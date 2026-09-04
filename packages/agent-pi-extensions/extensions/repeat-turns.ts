import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type RepeatMode = "repeat" | "traverse";

type RepeatState = {
	active: boolean;
	mode: RepeatMode;
	prompt: string;
	objective: string;
	total: number;
	nextIteration: number;
	stopRequested: boolean;
	notifyOnFinish: boolean;
	initialStateEmitted: boolean;
	activeLeaf: string;
	latestTraversalState: string;
	rehydrateOnNextDispatch: boolean;
	treeId: string;
	selectedNodeVersion: number;
	lastTransitionEvent: string;
	inboxCursor: number;
	generation: number;
};

type MariciInboxPollResult = {
	count: number;
	previousCursor: number;
	newCursor: number;
	source: "epistemic_graph_communication";
};

type MariciInboxPollRequest = {
	siteRoot: string;
	sinceSequence: number;
	requestId: string;
	resolve: (result: MariciInboxPollResult) => void;
	reject: (error: Error) => void;
};

const ENTRY_TYPE = "repeat-turns-state";
const MAX_ITERATIONS = 200;
const STOP_MARKER = "[REPEAT_STOP]";
const MAX_SNAPSHOT_CHARS = 40_000;
const INBOX_POLL_TIMEOUT_MS = 20_000;
const NARADA_MARICI_INBOX_POLL_EVENT = "narada:mcp:marici-inbox-poll";
const TRAVERSAL_BLOCK_PATTERN = /^- (?:ID:\s*)?([^\r\n—]+?)(?:\s+—[^\r\n]*)?[\r\n][\s\S]*?(?=^- (?:ID:\s*)?[^\r\n—]+(?:\s+—[^\r\n]*)?[\r\n]|(?![\s\S]))/gm;

function traversalBlocks(text: string): Map<string, string> {
	const blocks = new Map<string, string>();
	for (const match of text.matchAll(TRAVERSAL_BLOCK_PATTERN)) {
		const id = match[1]?.trim();
		if (id) blocks.set(id, match[0].trimEnd());
	}
	return blocks;
}

function serializeTraversalBlocks(blocks: Map<string, string>): string {
	if (blocks.size === 0) return "";
	return `TRAVERSAL_STATE\n\n${[...blocks.values()].join("\n\n")}`;
}

const emptyState = (): RepeatState => ({
	active: false,
	mode: "repeat",
	prompt: "",
	objective: "",
	total: 0,
	nextIteration: 1,
	stopRequested: false,
	notifyOnFinish: false,
	initialStateEmitted: false,
	activeLeaf: "",
	latestTraversalState: "",
	rehydrateOnNextDispatch: false,
	treeId: "",
	selectedNodeVersion: 0,
	lastTransitionEvent: "",
	inboxCursor: 0,
	generation: 0,
});

function restoredState(data: unknown): RepeatState | null {
	if (!data || typeof data !== "object") return null;
	const candidate = { ...emptyState(), ...(data as Partial<RepeatState>) };
	const safeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
	if (candidate.mode !== "repeat" && candidate.mode !== "traverse") return null;
	if (typeof candidate.active !== "boolean" || typeof candidate.prompt !== "string" || typeof candidate.objective !== "string") return null;
	if (!safeInteger(candidate.total) || candidate.total < 0 || candidate.total > MAX_ITERATIONS) return null;
	if (!safeInteger(candidate.nextIteration) || candidate.nextIteration < 1 || candidate.nextIteration > MAX_ITERATIONS + 1) return null;
	if (candidate.active && (candidate.total < 1 || candidate.nextIteration > candidate.total + 1)) return null;
	if (typeof candidate.stopRequested !== "boolean" || typeof candidate.notifyOnFinish !== "boolean" || typeof candidate.initialStateEmitted !== "boolean") return null;
	if (candidate.active && !candidate.prompt.trim()) return null;
	if (typeof candidate.activeLeaf !== "string" || typeof candidate.latestTraversalState !== "string" || candidate.latestTraversalState.length > MAX_SNAPSHOT_CHARS) return null;
	if (candidate.latestTraversalState && !traversalSnapshot(candidate.latestTraversalState)) return null;
	if (typeof candidate.rehydrateOnNextDispatch !== "boolean" || typeof candidate.treeId !== "string" || typeof candidate.lastTransitionEvent !== "string") return null;
	if (!safeInteger(candidate.selectedNodeVersion) || candidate.selectedNodeVersion < 0) return null;
	if (!safeInteger(candidate.inboxCursor) || candidate.inboxCursor < 0) return null;
	if (!safeInteger(candidate.generation) || candidate.generation < 0) return null;
	return candidate;
}

export function requestMariciInboxPoll(
	pi: Pick<ExtensionAPI, "events">,
	sinceSequence: number,
	siteRoot = process.cwd(),
	signal?: AbortSignal,
): Promise<MariciInboxPollResult> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		const onAbort = (): void => finish(reject, new Error("Marici inbox poll aborted"));
		const finish = <T>(callback: (value: T) => void, value: T): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			callback(value);
		};
		const request: MariciInboxPollRequest = {
			siteRoot,
			sinceSequence,
			requestId: `repeat-turns-${Date.now()}-${Math.random().toString(16).slice(2)}`,
			resolve: (result) => finish(resolve, result),
			reject: (error) => finish(reject, error),
		};
		timer = setTimeout(
			() => finish(reject, new Error(`Marici inbox poll timed out after ${INBOX_POLL_TIMEOUT_MS}ms`)),
			INBOX_POLL_TIMEOUT_MS,
		);
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			pi.events.emit(NARADA_MARICI_INBOX_POLL_EVENT, request);
		} catch (error) {
			finish(reject, error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const candidate = message as { role?: string; content?: unknown };
	if (candidate.role !== "assistant") return "";
	if (typeof candidate.content === "string") return candidate.content;
	if (!Array.isArray(candidate.content)) return "";
	return candidate.content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as { type?: string; text?: string };
			return value.type === "text" && typeof value.text === "string" ? value.text : "";
		})
		.join("\n");
}

export function traversalSnapshot(text: string): string {
	const heading = text.match(/^[ \t]*TRAVERSAL_STATE[ \t]*(?:\r)?$/mi);
	if (!heading || heading.index === undefined) return "";
	const snapshot = text.slice(heading.index).trim();
	if (snapshot.length > MAX_SNAPSHOT_CHARS || traversalBlocks(snapshot).size === 0) return "";
	return snapshot;
}

export function mergeTraversalSnapshot(previous: string, update: string): string {
	const updateBlocks = traversalBlocks(update);
	if (updateBlocks.size === 0) return previous;

	const blocks = traversalBlocks(previous);
	for (const [id, block] of updateBlocks) blocks.set(id, block);
	const merged = serializeTraversalBlocks(blocks);
	if (merged.length > MAX_SNAPSHOT_CHARS) return previous || (update.length <= MAX_SNAPSHOT_CHARS ? update : "");
	return merged;
}

function parseLabel(text: string, label: string): string {
	const match = text.match(new RegExp(`^${label}:\\s*(.+)$`, "mi"));
	return match?.[1]?.trim() ?? "";
}

export function parsePointerField(text: string, field: string): string {
	const line = text.match(/^LEAF_UPDATE:\s*(.+)$/mi)?.[1] ?? "";
	const match = line.match(new RegExp(`(?:^|\\|)\\s*${field}=([^|]+)`, "i"));
	return match?.[1]?.trim() ?? "";
}

export function finalPathNode(path: string): string {
	const nodes = path.split(/\s*(?:>|→)\s*/).map((value) => value.trim()).filter(Boolean);
	return nodes.at(-1) ?? "";
}

export function traversalIsTerminal(snapshot: string): boolean {
	const statuses = [...snapshot.matchAll(/^\s*status:\s*([^\r\n]+)$/gmi)].map((match) => match[1].trim().toLowerCase());
	if (statuses.length === 0) return false;
	return statuses.every((status) => /^(completed|falsified|exhausted|superseded|cancelled|terminal)\b/.test(status));
}

export function repeatStopReason(text: string): string | null {
	const finalLine = text.trimEnd().split(/\r?\n/).at(-1)?.trim() ?? "";
	const match = finalLine.match(/^\[REPEAT_STOP(?:\s+reason="([^"\r\n]+)")?\]$/);
	if (!match) return null;
	return match[1]?.trim() || "agent requested stop";
}

function emitWindowsTerminalBell(ctx: ExtensionContext): void {
	if (process.platform !== "win32" || ctx.mode !== "tui") return;
	try {
		// BEL delegates to the configured Windows terminal bell without spawning a shell.
		process.stdout.write("\x07");
	} catch {
		// Notification is best effort and must not change repeat state.
	}
}

export default function (pi: ExtensionAPI) {
	let state = emptyState();
	let lastAssistantRequestedStop = false;
	let lastAssistantStopReason = "";
	let dispatching = false;
	let awaitingAgentStart = false;
	let iterationStarted = false;
	let iterationProducedAssistant = false;
	let runtimeGeneration = 0;
	let disposed = false;
	let inboxPollController: AbortController | undefined;

	function persist(): void {
		pi.appendEntry(ENTRY_TYPE, { ...state });
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!state.active) {
			ctx.ui.setStatus("repeat-turns", undefined);
			return;
		}
		const completed = state.nextIteration - 1;
		const leaf = state.mode === "traverse" && state.activeLeaf ? ` · ${state.activeLeaf}` : "";
		ctx.ui.setStatus("repeat-turns", `${state.mode} ${completed}/${state.total}${leaf}`);
	}

	function consumeFinishNotification(): boolean {
		const notifyOnFinish = state.notifyOnFinish;
		state.notifyOnFinish = false;
		return notifyOnFinish;
	}

	function finish(ctx: ExtensionContext, reason: string): void {
		const notifyOnFinish = consumeFinishNotification();
		inboxPollController?.abort();
		inboxPollController = undefined;
		state.active = false;
		state.stopRequested = false;
		awaitingAgentStart = false;
		iterationStarted = false;
		iterationProducedAssistant = false;
		lastAssistantRequestedStop = false;
		lastAssistantStopReason = "";
		persist();
		updateStatus(ctx);
		ctx.ui.notify(`Repeat stopped: ${reason}`, "info");
		if (notifyOnFinish) emitWindowsTerminalBell(ctx);
	}

	function supersedeActiveRun(ctx: ExtensionContext): number {
		inboxPollController?.abort();
		inboxPollController = undefined;
		state.generation += 1;
		if (!state.active) return state.generation;
		state.active = false;
		state.stopRequested = false;
		awaitingAgentStart = false;
		iterationStarted = false;
		iterationProducedAssistant = false;
		lastAssistantRequestedStop = false;
		lastAssistantStopReason = "";
		persist();
		updateStatus(ctx);
		return state.generation;
	}

	async function dispatchNext(ctx: ExtensionContext): Promise<void> {
		if (disposed || !state.active || dispatching || awaitingAgentStart || iterationStarted) return;
		if (state.stopRequested) {
			finish(ctx, "cancelled");
			return;
		}
		if (state.nextIteration > state.total) {
			const resumable = state.mode === "traverse"
				? `budget exhausted; traversal remains resumable${state.activeLeaf ? ` at ${state.activeLeaf}` : ""}`
				: "completed";
			finish(ctx, resumable);
			return;
		}

		dispatching = true;
		const generation = state.generation;
		const runtime = runtimeGeneration;
		const isStale = (): boolean => disposed || runtime !== runtimeGeneration || generation !== state.generation;
		const iteration = state.nextIteration;
		let inboxLine = "";
		let polledCursor = state.inboxCursor;
		if (state.mode === "traverse") {
			const previousCursor = state.inboxCursor;
			const pollController = new AbortController();
			inboxPollController = pollController;
			try {
				const result = await requestMariciInboxPoll(pi, previousCursor, ctx.cwd, pollController.signal);
				if (isStale() || !state.active) {
					dispatching = false;
					if (!isStale() && state.active && ctx.isIdle()) void dispatchNext(ctx);
					return;
				}
				if (
					!Number.isSafeInteger(result.count) || result.count < 0 ||
					!Number.isSafeInteger(result.previousCursor) || !Number.isSafeInteger(result.newCursor) ||
					result.previousCursor !== previousCursor || result.newCursor < previousCursor
				) {
					throw new Error("Marici inbox poll returned an invalid cursor interval");
				}
				polledCursor = result.newCursor;
				inboxLine = `NEW_MESSAGES: ${result.count} since_sequence=${previousCursor} through_sequence=${polledCursor}`;
			} catch (error) {
				if (isStale() || !state.active) {
					dispatching = false;
					if (!isStale() && state.active && ctx.isIdle()) void dispatchNext(ctx);
					return;
				}
				inboxLine = "NEW_MESSAGES: unavailable";
				const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
				ctx.ui.notify(`Marici opening inbox poll unavailable; cursor ${previousCursor} retained: ${detail}`, "warning");
			} finally {
				if (inboxPollController === pollController) inboxPollController = undefined;
			}
		}
		if (isStale() || !state.active || state.stopRequested) {
			dispatching = false;
			if (!isStale() && state.stopRequested && state.active) finish(ctx, "cancelled");
			else if (!isStale() && state.active && ctx.isIdle()) void dispatchNext(ctx);
			return;
		}

		const isTraversalContinuation = state.mode === "traverse" && state.initialStateEmitted;
		const body = isTraversalContinuation
			? [
				`Continue graph-backed programme with tree=${state.treeId || "resolve-by-objective"}, selected=${state.activeLeaf || "read-frontier"}, version=${state.selectedNodeVersion || "read-current"}, last_event=${state.lastTransitionEvent || "none"}.`,
				"Use binding marici-epistemic-graph: one atomic epistemic_graph_issue_tree_resume call and one idempotent epistemic_graph_issue_tree_transition call. If resume.selected is null and frontier.items is nonempty, work on frontier.items[0] and use transition nodes mode with that node's next version; selected-only mode is invalid when no leaf is selected. Do not spend a turn merely selecting a leaf. Ownership-blocked local mutation is not terminal while an authorized communication or handoff edge exists: create an active handoff successor and send the owner an exact evidence-bearing request. A fresh resume may establish terminal void only when selected is null, the unresolved frontier is empty, no nonredundant successor or valid transition target exists, and local execution plus owner handoff are unavailable or forbidden. In that case, omit the transition call and emit [REPEAT_STOP reason=\"<durable reason>\"] as a standalone final line. Do not use the command merely because one leaf completed or one branch is blocked. Do not invent a marici-issue-tree binding. Inspect schemas only after typed contract drift. Complete one substantive leaf, then give the result plus compact ACTIVE_PATH and LEAF_UPDATE lines.",
			].join("\n")
			: state.prompt;
		const message = [
			body,
			...(state.mode === "traverse"
				? ["", "The pre-dispatch NEW_MESSAGES poll is the opening inbox check. Perform a distinct closing Marici inbox poll during the agent turn to reconcile arrivals during work.", inboxLine]
				: [""]),
			`Iteration ${iteration} of ${state.total}.`,
			"Complete one substantive agent turn using freshly read mutable state.",
			...(state.mode === "traverse"
				? []
				: [`Emit ${STOP_MARKER} only if the objective is complete, explicitly cancelled, or has no nonredundant executable continuation.`]),
		].join("\n");

		awaitingAgentStart = true;
		iterationStarted = false;
		iterationProducedAssistant = false;
		lastAssistantRequestedStop = false;
		lastAssistantStopReason = "";
		try {
			pi.sendUserMessage(message);
			if (isStale() || !state.active) return;
			state.nextIteration = iteration + 1;
			if (state.mode === "traverse") {
				state.inboxCursor = polledCursor;
				state.initialStateEmitted = true;
				state.rehydrateOnNextDispatch = false;
			}
			persist();
			updateStatus(ctx);
		} catch (error) {
			if (isStale()) return;
			awaitingAgentStart = false;
			iterationStarted = false;
			persist();
			ctx.ui.notify(`Repeat dispatch failed without consuming iteration ${iteration}: ${String(error)}`, "error");
		} finally {
			dispatching = false;
			if (!disposed && runtime === runtimeGeneration && generation !== state.generation && state.active && ctx.isIdle()) void dispatchNext(ctx);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		inboxPollController?.abort();
		inboxPollController = undefined;
		runtimeGeneration += 1;
		disposed = false;
		dispatching = false;
		state = emptyState();
		lastAssistantRequestedStop = false;
		lastAssistantStopReason = "";
		awaitingAgentStart = false;
		iterationStarted = false;
		iterationProducedAssistant = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const restored = restoredState(entry.data);
			if (restored) state = restored;
		}
		if (state.active) {
			state.active = false;
			state.stopRequested = false;
			state.notifyOnFinish = false;
			state.rehydrateOnNextDispatch = state.mode === "traverse";
			persist();
			ctx.ui.notify(state.mode === "traverse" ? "Interrupted traversal recovered as resumable." : "Interrupted repeat recovered as stopped.", "warning");
		}
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		runtimeGeneration += 1;
		inboxPollController?.abort();
		inboxPollController = undefined;
		dispatching = false;
		awaitingAgentStart = false;
		iterationStarted = false;
		iterationProducedAssistant = false;
	});

	pi.on("session_compact", async () => {
		// Canonical traversal state is graph-resident; the next turn rereads the Site frontier.
	});

	pi.on("agent_start", async () => {
		if (disposed || !state.active || !awaitingAgentStart) return;
		awaitingAgentStart = false;
		iterationStarted = true;
		iterationProducedAssistant = false;
	});

	pi.on("message_end", async (event, ctx) => {
		if (disposed || !state.active || !iterationStarted) return;
		const text = assistantText(event.message);
		if (!text) return;
		iterationProducedAssistant = true;
		const stopReason = repeatStopReason(text);
		if (stopReason && (state.mode !== "traverse" || stopReason !== "agent requested stop")) {
			lastAssistantRequestedStop = true;
			lastAssistantStopReason = stopReason;
		}
		if (state.mode !== "traverse") return;

		const snapshot = traversalSnapshot(text);
		if (snapshot) state.latestTraversalState = mergeTraversalSnapshot(state.latestTraversalState, snapshot);
		else if (text.includes("TRAVERSAL_STATE")) ctx.ui.notify("Traversal-state update exceeded the bounded snapshot contract or was malformed; prior canonical state was preserved.", "warning");
		const selectedObjective = parseLabel(text, "ROOT_OBJECTIVE");
		if (selectedObjective) state.objective = selectedObjective;
		const activePath = parseLabel(text, "ACTIVE_PATH");
		if (activePath) state.activeLeaf = finalPathNode(activePath);
		const treeId = parsePointerField(text, "tree");
		if (treeId) state.treeId = treeId;
		const version = Number(parsePointerField(text, "version"));
		if (Number.isSafeInteger(version) && version > 0) state.selectedNodeVersion = version;
		const eventId = parsePointerField(text, "graph");
		if (eventId && eventId !== "unavailable") state.lastTransitionEvent = eventId;
		persist();
		updateStatus(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (disposed || !state.active) return;
		if (!iterationStarted) {
			await dispatchNext(ctx);
			return;
		}
		iterationStarted = false;
		if (!iterationProducedAssistant) {
			const notifyOnFinish = consumeFinishNotification();
			state.nextIteration = Math.max(1, state.nextIteration - 1);
			state.active = false;
			persist();
			updateStatus(ctx);
			ctx.ui.notify("Traversal paused: the agent run settled without an assistant result; the iteration was not consumed.", "warning");
			if (notifyOnFinish) emitWindowsTerminalBell(ctx);
			return;
		}
		iterationProducedAssistant = false;
		if (lastAssistantRequestedStop) {
			const reason = lastAssistantStopReason || `agent emitted ${STOP_MARKER}`;
			finish(ctx, reason);
			return;
		}
		await dispatchNext(ctx);
	});

	async function startRepeat(args: string, ctx: ExtensionContext, notifyOnFinish: boolean, commandName: string): Promise<void> {
		const match = args.trim().match(/^(\d+)\s+([\s\S]+)$/);
		if (!match) {
			ctx.ui.notify(`Usage: /${commandName} <1-200> <prompt>`, "warning");
			return;
		}
		const generation = supersedeActiveRun(ctx);
		const total = Number(match[1]);
		const prompt = match[2].trim();
		if (!Number.isSafeInteger(total) || total < 1 || total > MAX_ITERATIONS) {
			ctx.ui.notify(`Repeat count must be between 1 and ${MAX_ITERATIONS}.`, "warning");
			return;
		}
		state = { ...emptyState(), active: true, mode: "repeat", prompt, total, notifyOnFinish, generation };
		persist();
		updateStatus(ctx);
		if (ctx.isIdle()) await dispatchNext(ctx);
		else {
			ctx.abort();
			ctx.ui.notify("Previous run aborted; replacement repeat will dispatch when Pi settles.", "info");
		}
	}

	pi.registerCommand("repeat", {
		description: "Run one prompt for N sequential substantive turns",
		handler: (args, ctx) => startRepeat(args, ctx, false, "repeat"),
	});

	pi.registerCommand("repeat-then-notify", {
		description: "Run N sequential substantive turns and emit one Windows terminal bell when settled",
		handler: (args, ctx) => startRepeat(args, ctx, true, "repeat-then-notify"),
	});

	pi.registerCommand("traverse-issue-tree", {
		description: "Traverse a research issue tree depth first for N substantive turns",
		handler: async (args, ctx) => {
			const match = args.trim().match(/^(\d+)(?:\s+([\s\S]+))?$/);
			if (!match) {
				ctx.ui.notify("Usage: /traverse-issue-tree <1-200> [root objective]", "warning");
				return;
			}
			const inboxCursor = state.inboxCursor;
			const generation = supersedeActiveRun(ctx);
			const total = Number(match[1]);
			const suppliedObjective = match[2]?.trim() ?? "";
			if (!Number.isSafeInteger(total) || total < 1 || total > MAX_ITERATIONS) {
				ctx.ui.notify(`Traversal count must be between 1 and ${MAX_ITERATIONS}.`, "warning");
				return;
			}
			const selector = suppliedObjective
				? `Initial leaf: ${suppliedObjective}`
				: "Select the highest-value unresolved research leaf from the active durable programme; exclude meta/status prompts.";
			const prompt = [
				selector,
				"Use binding marici-epistemic-graph through atomic calls: objective-oriented epistemic_graph_issue_tree_resume, then idempotent epistemic_graph_issue_tree_transition. If resume.selected is null and frontier.items is nonempty, work on frontier.items[0] and use transition nodes mode with that node's next version; selected-only mode is invalid when no leaf is selected. Do not spend a turn merely selecting a leaf. Ownership-blocked local mutation is not terminal while an authorized communication or handoff edge exists: create an active handoff successor and send the owner an exact evidence-bearing request. Do not invent a marici-issue-tree binding or ask marici-task-lifecycle for graph tools. Use the stable contract without schema inspection; inspect only after typed contract drift. If unavailable, report graph=unavailable.",
				"Leaf blockers are branch-local; create nonredundant research branches autonomously. Leaf completion never stops the programme. A fresh resume may establish terminal void only when selected is null, the unresolved frontier is empty, no nonredundant successor or valid transition target exists, and local execution plus owner handoff are unavailable or forbidden. In that case, omit the transition call and emit [REPEAT_STOP reason=\"<durable reason>\"] as a standalone final line. Never emit it merely because the turn budget is exhausted.",
				"Do not print schemas, policy, or unchanged state. Give the research result, then exactly: ACTIVE_PATH: <ids>; LEAF_UPDATE: <id> | <status> | <result/blocker> | next=<id> | tree=<tree_id> | version=<selected_version> | graph=<event/unavailable>. Keep the update under 600 characters.",
			].join("\n");
			state = {
				...emptyState(),
				active: true,
				mode: "traverse",
				prompt,
				objective: suppliedObjective,
				total,
				inboxCursor,
				generation,
			};
			persist();
			updateStatus(ctx);
			if (ctx.isIdle()) await dispatchNext(ctx);
			else {
				ctx.abort();
				ctx.ui.notify("Previous run aborted; replacement traversal will dispatch when Pi settles.", "info");
			}
		},
	});

	pi.registerCommand("traverse-resume", {
		description: "Resume the latest issue-tree traversal; optionally replace its turn budget",
		handler: async (args, ctx) => {
			const requested = args.trim();
			const total = requested ? Number(requested) : state.total;
			if (!Number.isSafeInteger(total) || total < 1 || total > MAX_ITERATIONS) {
				ctx.ui.notify("Usage: /traverse-resume [1-200]", "warning");
				return;
			}
			supersedeActiveRun(ctx);
			if (state.mode !== "traverse" || (!state.objective && !state.latestTraversalState)) {
				ctx.ui.notify("No resumable traversal is recorded in this session branch.", "warning");
				return;
			}
			state.active = true;
			state.total = total;
			state.nextIteration = 1;
			state.stopRequested = false;
			state.initialStateEmitted = true;
			state.rehydrateOnNextDispatch = true;
			persist();
			updateStatus(ctx);
			if (ctx.isIdle()) await dispatchNext(ctx);
			else {
				ctx.abort();
				ctx.ui.notify("Previous run aborted; resumed traversal will dispatch when Pi settles.", "info");
			}
		},
	});

	pi.registerCommand("repeat-cancel", {
		description: "Stop the active repeat or traversal after the current turn",
		handler: async (_args, ctx) => {
			if (!state.active) {
				ctx.ui.notify("No repeat or traversal run is active.", "info");
				return;
			}
			state.stopRequested = true;
			persist();
			if (ctx.isIdle()) finish(ctx, "cancelled");
			else ctx.ui.notify("Cancellation requested.", "info");
		},
	});

	pi.registerCommand("repeat-status", {
		description: "Show repeat or traversal status",
		handler: async (_args, ctx) => {
			if (!state.active) {
				const resumable = state.mode === "traverse" && (state.objective || state.latestTraversalState);
				ctx.ui.notify(resumable ? `Traversal resumable${state.activeLeaf ? ` at ${state.activeLeaf}` : ""}.` : "No run is active.", "info");
				return;
			}
			ctx.ui.notify(
				`${state.mode} active: ${state.nextIteration - 1}/${state.total} dispatched${state.activeLeaf ? `; leaf ${state.activeLeaf}` : ""}.`,
				"info",
			);
		},
	});
}
