import { describe, it, expect } from "vitest";

// ─── We test the pure helper logic in isolation ───────────────────

// Replicate the helpers from index.ts for testing.
// In a larger project these would live in a separate module.

type ContentBlock = {
	type: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type AgentMessage = {
	role: string;
	content?: string | ContentBlock[];
	toolName?: string;
	summary?: string;
	tokensBefore?: number;
	timestamp?: number;
};

type SessionEntry = {
	type: string;
	id?: string;
	message?: AgentMessage;
	summary?: string;
	tokensBefore?: number;
	timestamp?: number;
	firstKeptEntryId?: string;
	customType?: string;
	data?: unknown;
};

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp ?? Date.now()).getTime(),
		} as unknown as AgentMessage;
	}
	return undefined;
}

function findCompactionBoundary(branch: SessionEntry[]): number {
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i]?.type === "compaction") {
			const c = branch[i]!;
			const idx = branch.findIndex((e) => e.id === c.firstKeptEntryId);
			return idx >= 0 ? idx : i + 1;
		}
	}
	return 0;
}

function getRecentMessages(
	branch: SessionEntry[],
	lastRecapEntryId: string | null,
): AgentMessage[] {
	let startIdx: number;
	if (lastRecapEntryId) {
		startIdx = branch.findIndex((e) => e.id === lastRecapEntryId) + 1;
		if (startIdx <= 0) {
			startIdx = findCompactionBoundary(branch);
		}
	} else {
		startIdx = Math.max(0, branch.length - 10);
	}
	return branch
		.slice(startIdx)
		.map(entryToMessage)
		.filter((m): m is AgentMessage => m !== undefined);
}

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
		if (m.role === "toolResult" && ["read", "write", "edit"].includes(m.toolName ?? "")) fileN++;
	}

	const parts: string[] = [];
	if (userN > 0) parts.push(`${userN} prompts`);
	if (assN > 0) parts.push(`${assN} responses`);
	if (toolN > 0) parts.push(`${toolN} tool calls`);
	if (fileN > 0) parts.push(`${fileN} file ops`);

	return parts.length > 0 ? `Recap: ${parts.join(", ")}.` : null;
}

function sanitizeConversation(text: string): string {
	return text
		.replace(/<conversation>/gi, "‹conversation›")
		.replace(/<\/conversation>/gi, "‹/conversation›")
		.replace(/<previous-summary>/gi, "‹previous-summary›")
		.replace(/<\/previous-summary>/gi, "‹/previous-summary›");
}

// ─── Tests ────────────────────────────────────────────────────────

describe("entryToMessage", () => {
	it("extracts message from message entries", () => {
		const msg: AgentMessage = { role: "user", content: "hello" };
		const entry: SessionEntry = { type: "message", message: msg };
		expect(entryToMessage(entry)).toBe(msg);
	});

	it("converts compaction entries to compactionSummary messages", () => {
		const entry: SessionEntry = {
			type: "compaction",
			summary: "Refactored auth module",
			tokensBefore: 5000,
			timestamp: 1000000,
		};
		const result = entryToMessage(entry);
		expect(result).toBeDefined();
		expect(result!.role).toBe("compactionSummary");
		expect(result!.summary).toBe("Refactored auth module");
		expect(result!.tokensBefore).toBe(5000);
	});

	it("returns undefined for unknown entry types", () => {
		expect(entryToMessage({ type: "custom", customType: "foo" })).toBeUndefined();
	});
});

describe("findCompactionBoundary", () => {
	it("returns 0 when no compaction exists", () => {
		const branch: SessionEntry[] = [
			{ type: "message", id: "a" },
			{ type: "message", id: "b" },
		];
		expect(findCompactionBoundary(branch)).toBe(0);
	});

	it("finds boundary from last compaction's firstKeptEntryId", () => {
		const branch: SessionEntry[] = [
			{ type: "message", id: "1" },
			{ type: "message", id: "2" },
			{ type: "message", id: "3" },
			{ type: "compaction", firstKeptEntryId: "2", summary: "..." },
			{ type: "message", id: "4" },
		];
		expect(findCompactionBoundary(branch)).toBe(1); // index of "2"
	});

	it("falls back to i+1 when firstKeptEntryId is not in branch", () => {
		const branch: SessionEntry[] = [
			{ type: "message", id: "a" },
			{ type: "compaction", firstKeptEntryId: "ghost", summary: "..." },
		];
		expect(findCompactionBoundary(branch)).toBe(2); // index of compaction + 1
	});
});

describe("getRecentMessages", () => {
	const branch: SessionEntry[] = [
		{ type: "message", id: "1", message: { role: "user", content: "a" } },
		{ type: "message", id: "2", message: { role: "assistant", content: "b" } },
		{ type: "message", id: "3", message: { role: "user", content: "c" } },
		{ type: "message", id: "4", message: { role: "assistant", content: "d" } },
	];

	it("starts from lastRecapEntryId + 1 when found", () => {
		const msgs = getRecentMessages(branch, "2");
		expect(msgs).toHaveLength(2);
		expect(msgs[0]?.role).toBe("user");
		expect(msgs[0]?.content).toBe("c");
	});

	it("starts from compaction boundary when lastRecapEntryId is missing", () => {
		const compacted: SessionEntry[] = [
			{ type: "message", id: "0", message: { role: "user", content: "old" } },
			{ type: "compaction", id: "c1", firstKeptEntryId: "2", summary: "..." },
			{ type: "message", id: "2", message: { role: "user", content: "kept" } },
			{ type: "message", id: "3", message: { role: "assistant", content: "resp" } },
		];
		// lastRecapEntryId "1" doesn't exist (compacted)
		const msgs = getRecentMessages(compacted, "1");
		expect(msgs).toHaveLength(2);
		expect(msgs[0]?.content).toBe("kept");
	});

	it("returns last 10 when no lastRecapEntryId", () => {
		const many = Array.from({ length: 15 }, (_, i) => ({
			type: "message" as const,
			id: `${i}`,
			message: { role: (i % 2 === 0 ? "user" : "assistant") as string, content: `${i}` },
		}));
		const msgs = getRecentMessages(many, null);
		expect(msgs).toHaveLength(10);
		expect(msgs[0]?.content).toBe("5");
	});

	it("returns all when branch is shorter than 10 and no lastRecapEntryId", () => {
		const msgs = getRecentMessages(branch, null);
		expect(msgs).toHaveLength(4);
	});
});

describe("simpleRecap", () => {
	it("returns null for empty messages", () => {
		expect(simpleRecap([])).toBeNull();
	});

	it("returns message count for assistant-only messages", () => {
		const msgs: AgentMessage[] = [{ role: "assistant", content: "hi" }];
		expect(simpleRecap(msgs)).toBe("Recap: 1 responses.");
	});

	it("counts user prompts, assistant responses, tool calls, file ops", () => {
		const msgs: AgentMessage[] = [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me check" },
					{ type: "toolCall", name: "read", arguments: { path: "x.ts" } },
				],
			},
			{ role: "toolResult", toolName: "read", content: "..." },
			{ role: "user", content: "edit it" },
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "edit", arguments: {} }],
			},
			{ role: "toolResult", toolName: "edit", content: "done" },
		];
		const result = simpleRecap(msgs);
		expect(result).toBe("Recap: 2 prompts, 2 responses, 2 tool calls, 2 file ops.");
	});
});

describe("sanitizeConversation", () => {
	it("escapes <conversation> tags", () => {
		expect(sanitizeConversation("<conversation>hello</conversation>")).toBe(
			"‹conversation›hello‹/conversation›",
		);
	});

	it("escapes <previous-summary> tags", () => {
		expect(sanitizeConversation("<previous-summary>stuff</previous-summary>")).toBe(
			"‹previous-summary›stuff‹/previous-summary›",
		);
	});

	it("passes through normal text unchanged", () => {
		expect(sanitizeConversation("normal text here")).toBe("normal text here");
	});
});
