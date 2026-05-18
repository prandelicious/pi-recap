/**
 * pi-recap — inline session recap for pi
 *
 * Mimics Claude Code's recap feature. Injects a concise `※ recap:` line into
 * the conversation on session resume, after idle timeouts, and via /recap.
 *
 * Triggers:
 *   /recap                          Manual recap
 *   /recap off|on                   Disable/enable auto-recap
 *   /recap configure <minutes>      Set idle timeout (default: 5)
 *   Session resume                  Auto-recap on /resume
 *   Idle timeout                    Auto-recap after N min of inactivity
 */

import { complete } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	SessionEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// ─── Constants ────────────────────────────────────────────────────

const RECAP_TYPE = "pi-recap";
const STATE_TYPE = "pi-recap-state";
const DEFAULT_IDLE_MIN = 5;

// ─── Module state ─────────────────────────────────────────────────

let pi: ExtensionAPI;
let currentCtx: ExtensionContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

interface RecapState {
	lastRecapEntryId: string | null;
	enabled: boolean;
	idleMinutes: number;
}

let recapState: RecapState = {
	lastRecapEntryId: null,
	enabled: true,
	idleMinutes: DEFAULT_IDLE_MIN,
};
let generating = false;

// ─── Helpers ──────────────────────────────────────────────────────

/** Load persisted state from session custom entries. */
function loadState(ctx: ExtensionContext) {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === STATE_TYPE) {
			recapState = entry.data as RecapState;
		}
	}
}

function saveState() {
	pi.appendEntry(STATE_TYPE, structuredClone(recapState));
}

/** Extract AgentMessage from a session entry (handoff.ts pattern). */
function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		} as unknown as AgentMessage;
	}
	return undefined;
}

/** Get messages since last recap (or last 10 if none). */
function getRecentMessages(ctx: ExtensionContext): AgentMessage[] {
	const branch = ctx.sessionManager.getBranch();
	const startIdx = recapState.lastRecapEntryId
		? branch.findIndex((e: any) => e.id === recapState.lastRecapEntryId) + 1
		: Math.max(0, branch.length - 10);
	const recentEntries = branch.slice(startIdx);
	return recentEntries.map(entryToMessage).filter((m): m is AgentMessage => m !== undefined);
}

/** Fallback recap when LLM unavailable. Returns null if nothing useful to say. */
function simpleRecap(messages: AgentMessage[]): string | null {
	let userN = 0;
	let assN = 0;
	let toolN = 0;
	let fileN = 0;

	for (const m of messages) {
		if (m.role === "user") userN++;
		if (m.role === "assistant") {
			assN++;
			if (Array.isArray(m.content)) {
				for (const block of m.content as any[]) {
					if (block?.type === "toolCall") toolN++;
				}
			}
		}
		if (m.role === "toolResult" && ["read", "write", "edit"].includes(m.toolName)) fileN++;
	}

	const parts: string[] = [];
	if (userN > 0) parts.push(`${userN} prompts`);
	if (assN > 0) parts.push(`${assN} responses`);
	if (toolN > 0) parts.push(`${toolN} tool calls`);
	if (fileN > 0) parts.push(`${fileN} file ops`);

	return parts.length > 0
		? `Recap: ${parts.join(", ")}.`
		: null;
}

/** Generate concise recap using LLM (falls back to basic stats).
 *  Returns null when there's nothing meaningful to recap. */
async function generateRecap(ctx: ExtensionContext): Promise<string | null> {
	const messages = getRecentMessages(ctx);
	if (messages.length === 0) return null;

	// Require at least one user message and one assistant response
	// — no point recapping tool-only noise.
	const hasUser = messages.some((m) => m.role === "user");
	const hasAssistant = messages.some((m) => m.role === "assistant");
	if (!hasUser || !hasAssistant) return null;

	const text = serializeConversation(convertToLlm(messages));

	// If serialization produced nothing meaningful, bail.
	// Must contain at least one user message marker to be worth recapping.
	if (!text || !text.includes("[User]:")) return null;

	const model = ctx.model;
	if (!model) return simpleRecap(messages);

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return simpleRecap(messages);

	try {
		const res = await complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: `Review the conversation below and write a very concise recap (2-4 sentences max).

Focus on:
1. Key actions taken (e.g. "refactored X", "added Y", "debugged Z")
2. Important findings or decisions
3. What comes next

Start your response with "Recap: " and keep the entire recap under 4 sentences.

<conversation>
${text}
</conversation>`,
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 256 },
		);

		const recap = res.content
			.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
			.map((c: { text: string }) => c.text)
			.join("\n")
			.trim();

		// If LLM says something about no conversation/context, skip —
		// the serialized content probably wasn't useful.
		if (recap && /no (conversation|context|content) (was )?(provided|to review)/i.test(recap)) {
			return null;
		}

		return recap || simpleRecap(messages);
	} catch {
		return simpleRecap(messages);
	}
}

/** Inject recap as an inline custom message. */
async function injectRecap(ctx: ExtensionContext) {
	if (generating || !recapState.enabled) return;
	generating = true;
	try {
		const recap = await generateRecap(ctx);
		if (!recap) return;

		pi.sendMessage({
			customType: RECAP_TYPE,
			content: recap,
			display: true,
		});

		const branch = ctx.sessionManager.getBranch();
		const last = branch[branch.length - 1];
		if (last) {
			recapState.lastRecapEntryId = last.id;
			saveState();
		}
	} finally {
		generating = false;
	}
}

/** Schedule idle timeout (one-shot; re-armed on next input). */
function scheduleIdle(ctx: ExtensionContext) {
	if (idleTimer) clearTimeout(idleTimer);
	if (!recapState.enabled) return;
	idleTimer = setTimeout(async () => {
		if (!currentCtx) return;
		await injectRecap(currentCtx);
	}, recapState.idleMinutes * 60 * 1000);
}

function cancelIdle() {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
}

// ─── Extension ────────────────────────────────────────────────────

export default function (extPi: ExtensionAPI) {
	pi = extPi;

	// ── Custom renderer ────────────────────────────────────

	pi.registerMessageRenderer(RECAP_TYPE, (message: any, _options: any, theme: any) => {
		const raw =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("")
					: "";

		// Strip leading "Recap:" so we rebuild it styled
		const body = raw.replace(/^Recap:\s*/i, "");

		const icon = theme.fg("dim", "※");
		const label = theme.fg("dim", theme.bold("recap:"));
		const dimmed = theme.fg("dim", ` ${body}`);

		return new Text(`${icon} ${label}${dimmed}`, 0, 0);
	});

	// ── Events ─────────────────────────────────────────────

	pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
		currentCtx = ctx;
		loadState(ctx);

		if (event.reason === "resume" && recapState.enabled) {
			await injectRecap(ctx);
		}

		scheduleIdle(ctx);
	});

	pi.on("session_shutdown", () => {
		currentCtx = null;
		cancelIdle();
	});

	pi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
		if (event.source === "interactive") {
			scheduleIdle(ctx);
		}
	});

	// ── Commands ───────────────────────────────────────────

	pi.registerCommand("recap", {
		description: "Show session recap. /recap off|on, /recap configure <minutes>",
		handler: async (args: string, ctx: any) => {
			const arg = args.trim().toLowerCase();

			if (arg === "off") {
				recapState.enabled = false;
				cancelIdle();
				saveState();
				ctx.ui.notify("Auto-recap disabled", "info");
				return;
			}

			if (arg === "on") {
				recapState.enabled = true;
				saveState();
				scheduleIdle(ctx);
				ctx.ui.notify("Auto-recap enabled", "info");
				return;
			}

			if (arg.startsWith("configure ")) {
				const mins = parseInt(arg.slice(10).trim(), 10);
				if (isNaN(mins) || mins < 1 || mins > 120) {
					ctx.ui.notify("Idle timeout must be 1–120 minutes", "error");
					return;
				}
				recapState.idleMinutes = mins;
				saveState();
				scheduleIdle(ctx);
				ctx.ui.notify(`Idle recap set to ${mins} minutes`, "info");
				return;
			}

			if (arg) {
				ctx.ui.notify("Usage: /recap, /recap off|on, /recap configure <minutes>", "info");
				return;
			}

			ctx.ui.notify("Generating recap…", "info");
			await injectRecap(ctx);
		},
	});
}
