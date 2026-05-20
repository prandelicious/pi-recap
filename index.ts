/**
 * pi-recap — inline session recap for pi
 *
 * Mimics Claude Code's recap feature. Injects a concise `※ recap:` line into
 * the conversation on session resume, after idle timeouts, and via /recap.
 *
 * Triggers:
 *   /recap                          Manual recap (works even when auto disabled)
 *   /recap off|on                   Disable/enable auto-recap
 *   /recap configure <minutes>      Set idle timeout (default: 5)
 *   /recap status                   Show current config
 *   Session resume / fork           Auto-recap on /resume or /fork
 *   Idle timeout                    Auto-recap after N min of inactivity
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** Path to the user-side config file (global defaults). */
function configFilePath(): string {
	return join(homedir(), ".pi", "agent", "pi-recap.json");
}

// ─── Module state ─────────────────────────────────────────────────

let pi: ExtensionAPI;
let currentCtx: ExtensionContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let abortController: AbortController | null = null;
let sessionGen = 0;

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

// ─── State persistence ────────────────────────────────────────────

interface FileConfig {
	idleMinutes?: number;
	enabled?: boolean;
}

/** Read global config from ~/.pi/agent/pi-recap.json (silent if missing). */
function loadFileConfig(): FileConfig {
	try {
		const path = configFilePath();
		if (!existsSync(path)) return {};
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw) as FileConfig;
	} catch {
		return {};
	}
}

/** Load persisted state from session custom entries (last occurrence wins). */
function loadState(ctx: ExtensionContext) {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && (entry as any).customType === STATE_TYPE) {
			const data = (entry as any).data as Partial<RecapState>;
			recapState = {
				lastRecapEntryId: data.lastRecapEntryId ?? null,
				enabled: data.enabled ?? true,
				idleMinutes: data.idleMinutes ?? DEFAULT_IDLE_MIN,
			};
		}
	}
}

function saveState() {
	pi.appendEntry(STATE_TYPE, structuredClone(recapState));
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Extract AgentMessage from a session entry (handoff.ts pattern). */
function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return (entry as any).message as AgentMessage;
	if (entry.type === "compaction") {
		const c = entry as any;
		return {
			role: "compactionSummary",
			summary: c.summary,
			tokensBefore: c.tokensBefore,
			timestamp: new Date(c.timestamp).getTime(),
		} as unknown as AgentMessage;
	}
	return undefined;
}

/**
 * Find the branch index where retained content starts after the last
 * compaction, or 0 if no compaction exists.
 */
function findCompactionBoundary(branch: SessionEntry[]): number {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "compaction") {
			const c = entry as any;
			const idx = branch.findIndex((e: any) => e.id === c.firstKeptEntryId);
			return idx >= 0 ? idx : i + 1;
		}
	}
	return 0;
}

/** Get messages since last recap (or last 10 if none).
 *  Handles compaction correctly: if lastRecapEntryId was compacted,
 *  falls back to the compaction boundary. */
function getRecentMessages(ctx: ExtensionContext): AgentMessage[] {
	const branch = ctx.sessionManager.getBranch();

	let startIdx: number;
	if (recapState.lastRecapEntryId) {
		startIdx = branch.findIndex((e: any) => e.id === recapState.lastRecapEntryId) + 1;
		if (startIdx <= 0) {
			// lastRecapEntryId not found — was compacted away
			startIdx = findCompactionBoundary(branch);
		}
	} else {
		startIdx = Math.max(0, branch.length - 10);
	}

	const recentEntries = branch.slice(startIdx);
	return recentEntries
		.map(entryToMessage)
		.filter((m): m is AgentMessage => m !== undefined);
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
		if (m.role === "toolResult" && ["read", "write", "edit"].includes((m as any).toolName)) fileN++;
	}

	const parts: string[] = [];
	if (userN > 0) parts.push(`${userN} prompts`);
	if (assN > 0) parts.push(`${assN} responses`);
	if (toolN > 0) parts.push(`${toolN} tool calls`);
	if (fileN > 0) parts.push(`${fileN} file ops`);

	return parts.length > 0 ? `Recap: ${parts.join(", ")}.` : null;
}

/**
 * Sanitize conversation text before interpolating into LLM prompt.
 * Prevents accidental prompt-injection via conversation content.
 */
function sanitizeConversation(text: string): string {
	// Escape XML-like tags to prevent breaking the prompt structure
	return text
		.replace(/<conversation>/gi, "‹conversation›")
		.replace(/<\/conversation>/gi, "‹/conversation›")
		.replace(/<previous-summary>/gi, "‹previous-summary›")
		.replace(/<\/previous-summary>/gi, "‹/previous-summary›");
}

/** Generate concise recap using LLM (falls back to basic stats).
 *  Returns null when there's nothing meaningful to recap. */
async function generateRecap(ctx: ExtensionContext, signal?: AbortSignal): Promise<string | null> {
	const messages = getRecentMessages(ctx);
	if (messages.length === 0) return null;

	// Require at least one user message and one assistant response
	const hasUser = messages.some((m) => m.role === "user");
	const hasAssistant = messages.some((m) => m.role === "assistant");
	if (!hasUser || !hasAssistant) return null;

	const text = serializeConversation(convertToLlm(messages));

	// Must contain at least one user message marker
	if (!text || !text.includes("[User]:")) return null;

	const model = ctx.model;
	if (!model) return simpleRecap(messages);

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return simpleRecap(messages);

	try {
		const safeText = sanitizeConversation(text);
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
${safeText}
</conversation>`,
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 256, signal },
		);

		const recap = res.content
			.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
			.map((c: { text: string }) => c.text)
			.join("\n")
			.trim();

		// If LLM says something about no conversation/context, skip
		if (recap && /no (conversation|context|content) (was )?(provided|to review)/i.test(recap)) {
			return null;
		}

		return recap || simpleRecap(messages);
	} catch {
		return simpleRecap(messages);
	}
}

/** Inject recap as an inline custom message.
 *  @param force — when true, bypasses the auto-recap enabled check. */
async function injectRecap(ctx: ExtensionContext, force = false) {
	if (generating) return;
	if (!force && !recapState.enabled) return;

	// Abort any in-flight generation from a stale session
	if (abortController?.signal.aborted === false) {
		abortController.abort();
	}
	abortController = new AbortController();
	const signal = abortController.signal;
	// Also use ctx.signal if available (during active agent turns)
	const combinedSignal = ctx.signal ? anySignal([signal, ctx.signal]) : signal;

	generating = true;
	try {
		const recap = await generateRecap(ctx, combinedSignal);
		if (!recap || signal.aborted) return;

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

/**
 * Combine multiple AbortSignals into one. Resolves when any source aborts.
 * Falls back to the first signal if AbortSignal.any() is unavailable.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
	if (typeof AbortSignal.any === "function") {
		return AbortSignal.any(signals);
	}
	// Polyfill for older runtimes
	return signals[0] as AbortSignal;
}

/** Schedule idle timeout (one-shot; re-armed on next input). */
function scheduleIdle(ctx: ExtensionContext) {
	if (idleTimer) clearTimeout(idleTimer);
	if (!recapState.enabled) return;
	const gen = sessionGen;
	idleTimer = setTimeout(async () => {
		if (!currentCtx || gen !== sessionGen) return;
		await injectRecap(currentCtx);
	}, recapState.idleMinutes * 60 * 1000);
}

function cancelIdle() {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
}

/** Reset all module-level state for a fresh session. */
function resetSession() {
	sessionGen++;
	cancelIdle();
	if (abortController) {
		abortController.abort();
		abortController = null;
	}
	generating = false;
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
		resetSession();
		currentCtx = ctx;

		// Seed defaults from file config, then let per-session state override
		const fileCfg = loadFileConfig();
		if (fileCfg.idleMinutes !== undefined) {
			recapState.idleMinutes = fileCfg.idleMinutes;
		}
		if (fileCfg.enabled !== undefined) {
			recapState.enabled = fileCfg.enabled;
		}
		loadState(ctx);

		// Auto-recap on resume or fork (both are "coming back" to work)
		if ((event.reason === "resume" || event.reason === "fork") && recapState.enabled) {
			await injectRecap(ctx);
		}

		scheduleIdle(ctx);
	});

	pi.on("session_shutdown", () => {
		resetSession();
		currentCtx = null;
	});

	pi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
		if (event.source === "interactive") {
			scheduleIdle(ctx);
		}
	});

	// ── Commands ───────────────────────────────────────────

	pi.registerCommand("recap", {
		description:
			"Show session recap. /recap, /recap off|on, /recap configure <minutes>, /recap status",
		handler: async (args: string, ctx: any) => {
			const arg = args.trim().toLowerCase();

			if (arg === "off") {
				recapState.enabled = false;
				cancelIdle();
				saveState();
				ctx.ui.notify("Auto-recap disabled. Use /recap for a one-off recap.", "info");
				return;
			}

			if (arg === "on") {
				recapState.enabled = true;
				saveState();
				scheduleIdle(ctx);
				ctx.ui.notify("Auto-recap enabled", "info");
				return;
			}

			if (arg === "status") {
				const status = recapState.enabled ? "enabled" : "disabled";
				const minutes = recapState.idleMinutes;
				ctx.ui.notify(
					`Auto-recap: ${status}, idle timeout: ${minutes} min, last recap: ${recapState.lastRecapEntryId ? "yes" : "none"}`,
					"info",
				);
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
				ctx.ui.notify(
					"Usage: /recap, /recap off|on, /recap configure <minutes>, /recap status",
					"info",
				);
				return;
			}

			ctx.ui.notify("Generating recap…", "info");
			// Manual /recap passes force=true so it works even when auto disabled
			await injectRecap(ctx, true);
		},
	});
}
