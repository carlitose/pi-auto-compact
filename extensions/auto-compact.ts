// MIT: @henryqw/pi-auto-compact 4.0.0, bc41a2d6f2ec61c2073a4af9f91d1b2efe7c773e.
// Local changes own lifecycle, bounded summary recovery and per-model thresholds; see ../LICENSE and README.
import {
	compact,
	estimateTokens,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createConfigStore } from "@henryqw/pi-config-store";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pid } from "node:process";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	executeTaskRoutes,
	registerModelTask,
	resolveConfiguredTaskRoutes,
	type ModelTask,
	type ResolvedTaskRoute,
	type TaskRouteError,
} from "@henryqw/pi-task-models";

type AgentMessage = Parameters<typeof estimateTokens>[0];

/**
 * Proactive compaction runs at four points:
 * - turn_start: catch sessions already over threshold before next request.
 * - turn_end: catch growth caused by tool results before next LLM turn.
 * - agent_end: catch growth from the final provider turn.
 * - context: last-resort guard with a temporary keep-recent context.
 *
 * Pi's ctx.compact() aborts active low-level run internally. Mid-task
 * compaction sends a custom continuation message after summary.
 */
const DEFAULT_COMPACT_THRESHOLD_PERCENT = 70;
const MIN_COMPACT_THRESHOLD_PERCENT = 25;
// Sessions here compact in about two minutes; one run took twenty-seven and looked
// identical on screen, because Pi's indicator shows a spinner and no elapsed time.
const STALL_NOTICE_MS = 300_000;
// The on-screen notice scrolls away and the next compaction eats it, so the same text
// is appended here. One rotation keeps the file from growing without bound.
const LOG_FILE_NAME = "pi-auto-compact.log";
const LOG_MAX_BYTES = 512 * 1024;
// A reload builds a new instance with empty memory while Pi cancels the compaction the old
// one had started. This file is the only thing that crosses that boundary, so the new
// instance can say who started the compaction and when, instead of guessing both wrong.
const RUN_MARKER_FILE_NAME = "pi-auto-compact.run.json";
// Pi reports the cancellation of the replaced session almost at once. This wait only exists
// for the case where that report never arrives, so an orphaned marker still gets explained
// instead of the cancellation passing in silence.
const ORPHAN_NOTICE_MS = 10_000;
// A reload that lands on a running compaction cancels it and nothing is summarized, so the
// next turn is still over the threshold. Waiting a moment lets the replacement settle before
// asking for the compaction again; what the user cancelled by hand is never asked for again.
const RECOVERY_DELAY_MS = 1_000;

function logPath() {
	return join(getAgentDir(), LOG_FILE_NAME);
}

function runMarkerPath() {
	return join(getAgentDir(), RUN_MARKER_FILE_NAME);
}

// The marker is attribution, never control: every filesystem error is swallowed, and the
// worst case is the same unattributed message this extension printed before.
function markRunStart(startedAt: number) {
	try {
		writeFileSync(runMarkerPath(), JSON.stringify({ pid, startedAt }), "utf8");
	} catch {
		// Without the marker, a cancellation after a reload stays unattributed.
	}
}

// Only this process's own marker is readable or removable: another Pi process may be
// compacting right now, and its marker is none of this instance's business.
function readOwnRunStart(): number | null {
	try {
		const marker: unknown = JSON.parse(readFileSync(runMarkerPath(), "utf8") as unknown as string);
		if (!marker || typeof marker !== "object") return null;
		const { pid: owner, startedAt } = marker as { pid?: unknown; startedAt?: unknown };
		if (owner !== pid || typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
		return startedAt;
	} catch {
		return null;
	}
}

function clearOwnRunMark() {
	if (readOwnRunStart() === null) return;
	try {
		rmSync(runMarkerPath());
	} catch {
		// A stale marker only costs one wrong attribution later.
	}
}

// Logging is diagnostics: it must never change what the session does, so every
// filesystem error is swallowed on purpose.
function appendLog(text: string) {
	try {
		const path = logPath();
		try {
			if (statSync(path).size >= LOG_MAX_BYTES) renameSync(path, `${path}.1`);
		} catch {
			// No file yet, or it cannot be rotated: keep appending to it.
		}
		appendFileSync(path, `${new Date().toISOString()} ${text}\n`, "utf8");
	} catch {
		// A session must not die because a log line could not be written.
	}
}

function describeElapsed(startedAt: number | null) {
	if (startedAt === null) return "for an unknown time";
	const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
	return seconds < 90 ? `after ${seconds} s` : `after about ${Math.round(seconds / 60)} min`;
}

// Everything the red one-liner leaves out: who cancelled, how long it ran, how full the
// context was, and what happens next.
function describeCompactionFailure(
	event: { reason?: string; aborted?: boolean; errorMessage?: string; willRetry?: boolean; fromExtension?: boolean },
	facts: { ours: boolean; inherited?: boolean; retrying?: boolean; resuming?: boolean; startedAt: number | null; percent: number | null; threshold: number },
) {
	const parts: string[] = [];
	const what = event.aborted ? "Compaction was cancelled" : "Compaction failed";
	parts.push(`${what} ${describeElapsed(facts.startedAt)} (Pi reason: ${event.reason ?? "unknown"}).`);
	if (!event.aborted && event.errorMessage) parts.push(`Error: ${event.errorMessage}`);
	if (facts.ours) {
		parts.push("This extension started it with ctx.compact(), which Pi always labels a manual compaction, so a cancellation is shown as a red error.");
	} else if (facts.inherited) {
		parts.push("An earlier instance of this extension started it with ctx.compact(), and this session was reloaded or replaced while it ran, which is what cancelled it.");
	} else {
		parts.push("This extension did not start it.");
	}
	if (event.aborted) {
		parts.push("A compaction is cancelled by Esc while the compaction indicator is up, by a session reload or replacement, or by a second compaction starting while this one runs.");
	}
	if (facts.percent !== null) parts.push(`Context was at ${Math.round(facts.percent)}% of the window (threshold ${facts.threshold}%).`);
	parts.push(facts.retrying
		? "Nothing was summarized, so this session is compacting again now."
		: facts.resuming
			? "Nothing was summarized. Starting the compaction had interrupted the turn, so the turn continues now without compacting, and compaction is tried again once that turn ends."
		: event.aborted
			? "Nothing was summarized, so the next turn is still over the threshold and compacts again."
			: "Nothing was summarized; the next turn tries again.");
	if (event.willRetry) parts.push("Pi will retry the aborted turn after compaction.");
	if (event.fromExtension) parts.push("The summary content came from a session_before_compact handler.");
	return parts.join(" ");
}
export const AUTO_COMPACT_TASK = {
	id: "pi-auto-compact/autoCompact",
	label: "Auto compaction",
	purpose: "Compact session context before it is exhausted.",
	defaultProfile: "fast",
} as const satisfies ModelTask;
type ModelPattern = { match: string; threshold: number };
type AutoCompactConfig = {
	autoCompactThreshold: number;
	modelThresholds?: Record<string, number>;
	modelPatterns?: ModelPattern[];
};
type ModelRef = { provider?: string; id?: string } | undefined;

function isValidThreshold(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= MIN_COMPACT_THRESHOLD_PERCENT && value < 100;
}

function parseModelThresholds(table: unknown): Record<string, number> {
	if (!table || typeof table !== "object" || Array.isArray(table)) {
		throw new Error("modelThresholds must be an object of provider/id or id keys.");
	}
	const entries = Object.entries(table);
	for (const [key, entry] of entries) {
		if (!key.trim()) throw new Error("modelThresholds keys must be provider/id or id.");
		if (!isValidThreshold(entry)) {
			throw new Error(`modelThresholds.${key} must be at least ${MIN_COMPACT_THRESHOLD_PERCENT} and below 100.`);
		}
	}
	return Object.fromEntries(entries) as Record<string, number>;
}

function parseModelPatterns(list: unknown): ModelPattern[] {
	if (!Array.isArray(list)) throw new Error("modelPatterns must be a list of { match, threshold }.");
	return list.map((item, index) => {
		const { match, threshold } = (item ?? {}) as Record<string, unknown>;
		if (typeof match !== "string" || !match) throw new Error(`modelPatterns[${index}].match must be a regular expression.`);
		try {
			new RegExp(match);
		} catch {
			throw new Error(`modelPatterns[${index}].match is not a valid regular expression.`);
		}
		if (!isValidThreshold(threshold)) {
			throw new Error(`modelPatterns[${index}].threshold must be at least ${MIN_COMPACT_THRESHOLD_PERCENT} and below 100.`);
		}
		return { match, threshold };
	});
}

function parseAutoCompactConfig(value: unknown): AutoCompactConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Config must be an object.");
	}
	const raw = value as Record<string, unknown>;
	const threshold = raw.autoCompactThreshold ?? DEFAULT_COMPACT_THRESHOLD_PERCENT;
	if (!isValidThreshold(threshold)) {
		throw new Error(`autoCompactThreshold must be at least ${MIN_COMPACT_THRESHOLD_PERCENT} and below 100.`);
	}
	const config: AutoCompactConfig = { autoCompactThreshold: threshold };
	if (raw.modelThresholds !== undefined) config.modelThresholds = parseModelThresholds(raw.modelThresholds);
	if (raw.modelPatterns !== undefined) config.modelPatterns = parseModelPatterns(raw.modelPatterns);
	return config;
}

function modelKey(model: ModelRef): string | undefined {
	return model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;
}

// Most specific first: provider/id, then the bare id, then the first pattern matching
// provider/id, then the general threshold.
function thresholdFor(config: AutoCompactConfig, model: ModelRef): number {
	const table = config.modelThresholds ?? {};
	const key = modelKey(model);
	if (key !== undefined && Object.hasOwn(table, key)) return table[key];
	if (model?.id && Object.hasOwn(table, model.id)) return table[model.id];
	if (key !== undefined) {
		const pattern = config.modelPatterns?.find(({ match }) => new RegExp(match).test(key));
		if (pattern) return pattern.threshold;
	}
	return config.autoCompactThreshold;
}

// store.save replaces the whole file, so every change starts from the latest saved config.
function withThreshold(config: AutoCompactConfig, key: string | undefined, threshold: number | undefined): AutoCompactConfig {
	if (key === undefined) return { ...config, autoCompactThreshold: threshold ?? config.autoCompactThreshold };
	const table: Record<string, number> = { ...config.modelThresholds };
	if (threshold === undefined) delete table[key];
	else table[key] = threshold;
	const { modelThresholds: _old, ...rest } = config;
	return Object.keys(table).length ? { ...rest, modelThresholds: table } : rest;
}

function configuredTaskRoutes(ctx: ExtensionContext): ResolvedTaskRoute[] {
	try {
		return resolveConfiguredTaskRoutes(ctx, AUTO_COMPACT_TASK);
	} catch (error) {
		const { taskRouteCode, profileName } = error as TaskRouteError;
		if (taskRouteCode === "config-missing") return [];
		const cause = taskRouteCode === "profile-missing"
			? `Task model profile ${profileName} is not configured`
			: taskRouteCode === "no-route"
				? `No usable ${profileName} task model route`
				: "Couldn't read task model config";
		ctx.ui.notify(`${cause}; using current session model.`, "error");
		return [];
	}
}

function withoutDeletedHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

// Emergency context guard keeps recent messages while default compaction runs.
const KEEP_RECENT_PERCENT = 15;
const COMPACTION_INSTRUCTIONS = "Preserve current task to be resumed after compaction.";
const SUMMARY_RECOVERY_INSTRUCTIONS =
	"Be concise: prioritize the active task, pending work, constraints, decisions and durable evidence paths. " +
	"Condense completed history instead of repeating it. Do not invent completion or omit unresolved work.";

function isIncompleteSummary(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") return false;
	// Pi 0.86 has no typed error code. Match only its two exact rejection messages.
	return error.message === "Summarization failed: generation hit the token cap and the summary is incomplete" ||
		error.message === "Turn prefix summarization failed: generation hit the token cap and the summary is incomplete";
}
// A compaction takes the skill instructions out of context, and the routing rule then asks for
// them again: in one measured session ask-skills/SKILL.md was read 23 times, one per cut. The
// summary carries which skills were already routed so that rereading one is a decision about
// its content, never about satisfying the rule. The list is computed here, not requested from
// the summarizing model: a generation can drop a list, a concatenation cannot.
const SKILL_FILE_NAME = "SKILL.md";
const MAX_SKILL_ENTRIES = 30;

function pathParts(path: string): string[] {
	return path.split(/[\\/]+/).filter(Boolean);
}

/** The digest of the file on disk now. What was read cannot be recovered from a path list. */
function skillDigest(path: string): string {
	try {
		return `sha256:${createHash("sha256").update(readFileSync(path, "utf8")).digest("hex").slice(0, 16)}`;
	} catch {
		return "unreadable at compaction";
	}
}

function loadedSkillsSection(read: unknown): string | null {
	if (!read || typeof (read as Iterable<unknown>)[Symbol.iterator] !== "function") return null;
	const byPath = new Map<string, string>();
	for (const entry of read as Iterable<unknown>) {
		if (typeof entry !== "string") continue;
		const parts = pathParts(entry);
		if (parts.at(-1) !== SKILL_FILE_NAME || parts.length < 2) continue;
		byPath.set(entry, parts.at(-2) as string);
	}
	if (byPath.size === 0) return null;
	const entries = [...byPath].sort(([pathA, nameA], [pathB, nameB]) =>
		nameA.localeCompare(nameB) || pathA.localeCompare(pathB));
	const lines = entries.slice(0, MAX_SKILL_ENTRIES)
		.map(([path, name]) => `- ${name} — \`${path}\` — ${skillDigest(path)}`);
	const omitted = entries.length - lines.length;
	// Truncation is stated rather than silent: a short list that looks complete is worse than
	// a short list that says what it left out.
	if (omitted > 0) lines.push(`- and ${omitted} more skill files, left out of this list.`);
	return [
		"",
		"## Skills already routed in this session",
		"",
		"These SKILL.md files were read in this session, so the routing rule is already satisfied:",
		"rereading one only to satisfy it adds nothing.",
		"Their instructions are no longer in context, so read one again when you need what it says,",
		"never to route again.",
		"Each digest is of the file on disk at compaction time, not of the text that was read.",
		"",
		...lines,
		"",
	].join("\n");
}

function withLoadedSkills<T>(result: T, read: unknown): T {
	const compaction = (result as { compaction?: { summary?: unknown } } | undefined)?.compaction;
	if (!compaction || typeof compaction.summary !== "string") return result;
	const section = loadedSkillsSection(read);
	if (!section) return result;
	return { ...result, compaction: { ...compaction, summary: `${compaction.summary}\n${section}` } };
}

const RESUME_MESSAGE_TYPE = "pi-auto-compact/resume";
const RESUME_MESSAGE = "Auto-compact ran. Continue the current task.";
const RESUME_FAILED_MESSAGE = "Auto-compact could not compact and had interrupted this turn. Continue the current task.";
const COMPACTION_ABORT_ERROR = "This operation was aborted";
const ACTIVATION_ERROR =
	"pi-auto-compact failed to activate: Pi built-in auto-compaction is enabled. " +
	"Set compaction.enabled to false in Pi settings, then restart Pi.";

/** Estimate current request size, including Pi 0.86 transcript state. */
function estimateMessageTokens(message: AgentMessage): number {
	if (message.role === "system") return Math.ceil(JSON.stringify(message).length / 4);
	return estimateTokens(message);
}

function estimateTotalTokens(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/**
 * Return temporary context containing complete newest turns plus notice.
 * System messages are transcript state, so preserve them in their original order
 * even when the surrounding conversation is removed.
 */
function keepRecent(messages: AgentMessage[], keepTokens: number): AgentMessage[] | null {
	const systemTokens = estimateTotalTokens(messages.filter((message) => message.role === "system"));
	const suffixTokens = new Array<number>(messages.length + 1).fill(0);
	for (let i = messages.length - 1; i >= 0; i--) {
		suffixTokens[i] = suffixTokens[i + 1] + (messages[i].role === "system" ? 0 : estimateMessageTokens(messages[i]));
	}

	const userBoundaries = messages.flatMap((message, index) => message.role === "user" ? [index] : []);
	if (userBoundaries.length === 0) return null;

	let cutIndex = userBoundaries.at(-1) as number;
	for (const boundary of userBoundaries) {
		const removed = messages.slice(0, boundary).filter((message) => message.role !== "system");
		if (removed.length === 0) continue;
		const notice: AgentMessage = {
			role: "user",
			content: `[Context compacted: ${removed.length} earlier messages (~${Math.round(estimateTotalTokens(removed) / 1000)}K tokens) were summarized. Continue with the current task.]`,
			timestamp: Date.now(),
		};
		if (systemTokens + suffixTokens[boundary] + estimateMessageTokens(notice) <= keepTokens) {
			cutIndex = boundary;
			break;
		}
	}

	const removed = messages.slice(0, cutIndex).filter((message) => message.role !== "system");
	if (removed.length === 0) return null;
	const notice: AgentMessage = {
		role: "user",
		content: `[Context compacted: ${removed.length} earlier messages (~${Math.round(estimateTotalTokens(removed) / 1000)}K tokens) were summarized. Continue with the current task.]`,
		timestamp: Date.now(),
	};
	const retained: AgentMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (i === cutIndex) retained.push(notice);
		if (messages[i].role === "system" || i >= cutIndex) retained.push(messages[i]);
	}
	return retained;
}

/** Final assistant turns need no automatic follow-up; tool turns do. */
function hasToolCall(message: AgentMessage): boolean {
	return (
		message.role === "assistant" &&
		Array.isArray(message.content) &&
		message.content.some((part) => part.type === "toolCall")
	);
}

export default function (pi: ExtensionAPI) {
	registerModelTask(pi, AUTO_COMPACT_TASK);
	const configStore = createConfigStore<AutoCompactConfig>({
		extensionId: "pi-auto-compact",
		defaults: () => ({ autoCompactThreshold: DEFAULT_COMPACT_THRESHOLD_PERCENT }),
		parse: parseAutoCompactConfig,
	});
	let active = false;
	let config: AutoCompactConfig = { autoCompactThreshold: DEFAULT_COMPACT_THRESHOLD_PERCENT };
	// A session can stay open for days; an edit of the config file must not wait for /reload.
	// The file is stat'ed on every check and read again only when its time or size changed.
	let configStamp: string | undefined;
	const configStampNow = () => {
		try {
			const stat = statSync(join(getAgentDir(), "config", "pi-auto-compact", "config.json"));
			return `${stat.mtimeMs}:${stat.size}`;
		} catch {
			return "missing";
		}
	};
	const refreshConfig = () => {
		if (configStamp === undefined) return;
		const stamp = configStampNow();
		if (stamp === configStamp) return;
		configStamp = stamp;
		try {
			config = configStore.loadSync().value;
		} catch {
			// A half-written or invalid edit keeps the thresholds already in use.
		}
	};
	// The session model can change between turns, so every check asks for its threshold again.
	const thresholdOf = (ctx: ExtensionContext) => {
		refreshConfig();
		let model: ModelRef;
		try {
			model = ctx.model;
		} catch {
			model = undefined;
		}
		return thresholdFor(config, model);
	};
	// Prevent lifecycle hooks from starting duplicate summaries.
	let compactionPending = false;
	let compactionAbortExpected = false;
	// ctx.compact() aborts the running turn first. When the compaction then fails or is
	// cancelled, nothing would ever answer that turn: the session would sit still with the
	// user's message unanswered. interruptedTurn remembers the abort; holdOff keeps the
	// resumed turn from compacting (and interrupting itself) again until it ends.
	let interruptedTurn = false;
	let holdOff = false;
	// ctx.compact() first waits for the aborted run to settle, and Pi counts the session as idle
	// in that gap. A message with triggerTurn (a terminal notice, a goal check) then starts a new
	// run, and Pi's compaction waits for that whole run, often half an hour, while this guard
	// keeps every other compaction out and the context grows past the window.
	// waitingForSummary covers that gap; resumeAfter says whether a turn awaits the result.
	let waitingForSummary = false;
	let resumeAfter = false;
	let stallTimer: ReturnType<typeof setTimeout> | null = null;
	let missingRouteReported = false;
	let compactionStartedAt: number | null = null;
	// Start time of a compaction that a previous instance of this extension began, taken from
	// the marker file at session start and used only to attribute what Pi cancels next.
	let inheritedStartedAt: number | null = null;
	let orphanTimer: ReturnType<typeof setTimeout> | null = null;
	// At most one recovery per instance: losing a compaction is bad, retrying it forever is worse.
	let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
	let recoveryUsed = false;

	// One place for both the screen and the file, so the log never disagrees with the notice.
	const report = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error") => {
		appendLog(text);
		ctx.ui.notify(text, level);
	};

	const clearStallNotice = () => {
		if (stallTimer === null) return;
		clearTimeout(stallTimer);
		stallTimer = null;
	};

	const clearOrphanNotice = () => {
		if (orphanTimer === null) return;
		clearTimeout(orphanTimer);
		orphanTimer = null;
	};

	const clearRecovery = () => {
		if (recoveryTimer === null) return;
		clearTimeout(recoveryTimer);
		recoveryTimer = null;
	};

	const readPercent = (ctx: ExtensionContext) => {
		try {
			return ctx.getContextUsage()?.percent ?? null;
		} catch {
			return null;
		}
	};

	// Ask again for a compaction this pid started and a reload took away. Only for that case:
	// a compaction the user cancelled with Esc, or one this extension never started, is left
	// alone. Returns whether the retry was scheduled, so the notice can say what it did.
	const recoverLostCompaction = (ctx: ExtensionContext, percent: number | null) => {
		if (closed || !active || recoveryUsed || compactionPending) return false;
		if (percent === null || percent <= thresholdOf(ctx)) return false;
		recoveryUsed = true;
		clearRecovery();
		recoveryTimer = setTimeout(() => {
			recoveryTimer = null;
			if (closed || !active || compactionPending) return;
			compactionPending = true;
			runCompaction(ctx);
		}, RECOVERY_DELAY_MS);
		return true;
	};

	const armOrphanNotice = (ctx: ExtensionContext) => {
		clearOrphanNotice();
		orphanTimer = setTimeout(() => {
			orphanTimer = null;
			if (closed || inheritedStartedAt === null) return;
			const startedAt = inheritedStartedAt;
			inheritedStartedAt = null;
			clearOwnRunMark();
			const retrying = recoverLostCompaction(ctx, readPercent(ctx));
			report(
				ctx,
				`A compaction started ${describeElapsed(startedAt)} never finished: this session was reloaded or replaced before it could summarize. ${retrying
					? "Nothing was summarized, so this session is compacting again now."
					: "Nothing was summarized, so this session compacts again once it crosses the threshold."} Log: ${logPath()}`,
				"warning",
			);
		}, ORPHAN_NOTICE_MS);
	};

	// An extension cannot stop a compaction: ctx.compact() exposes no abort. Saying how
	// long it has been running is the only thing this side can honestly offer.
	const startStallNotice = (ctx: ExtensionContext) => {
		clearStallNotice();
		const startedAt = Date.now();
		stallTimer = setTimeout(() => {
			stallTimer = null;
			if (closed || !compactionPending) return;
			const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
			report(
				ctx,
				`Compaction has been running for about ${minutes} min, well past the usual couple of minutes. This extension cannot stop it; Esc cancels it and the next turn compacts again.`,
				"warning",
			);
		}, STALL_NOTICE_MS);
	};
	// A replacement gets a new factory. Never reopen this instance after shutdown.
	let closed = false;
	const deferred = new Set<ReturnType<typeof setImmediate>>();
	const defer = (callback: () => void) => {
		if (closed) return;
		const handle = setImmediate(() => {
			deferred.delete(handle);
			if (!closed) callback();
		});
		deferred.add(handle);
	};
	pi.on("session_shutdown", () => {
		closed = true;
		active = false;
		compactionPending = false;
		compactionAbortExpected = false;
		interruptedTurn = false;
		holdOff = false;
		waitingForSummary = false;
		resumeAfter = false;
		compactionStartedAt = null;
		inheritedStartedAt = null;
		clearStallNotice();
		clearOrphanNotice();
		clearRecovery();
		for (const handle of deferred) clearImmediate(handle);
		deferred.clear();
	});

	const runCompaction = (ctx: ExtensionContext, resumeTask = true) => {
		if (closed) return;
		compactionAbortExpected = Boolean(ctx.signal && !ctx.signal.aborted);
		interruptedTurn = resumeTask && compactionAbortExpected;
		waitingForSummary = true;
		resumeAfter = resumeTask;
		compactionStartedAt = Date.now();
		// A fresh compaction supersedes whatever the replaced instance had left behind.
		clearOrphanNotice();
		inheritedStartedAt = null;
		markRunStart(compactionStartedAt);
		startStallNotice(ctx);
		ctx.compact({
			customInstructions: COMPACTION_INSTRUCTIONS,
			onComplete: () => {
				clearStallNotice();
				compactionStartedAt = null;
				clearOwnRunMark();
				if (closed) return;
				compactionPending = false;
				compactionAbortExpected = false;
				interruptedTurn = false;
				waitingForSummary = false;
				if (!resumeAfter) return;
				// Pi may flush queued input during compaction_end. Wait one macrotask
				// before checking idle, otherwise follow-up can race that flush.
				defer(() => {
					if (!ctx.isIdle()) return;
					pi.sendMessage({
						customType: RESUME_MESSAGE_TYPE,
						content: RESUME_MESSAGE,
						display: false,
					}, { triggerTurn: true });
				});
			},
			// The failure text comes from session_compact_failed, which knows whether it was
			// an abort and why; this callback only releases the guard.
			onError: () => {
				clearStallNotice();
				compactionStartedAt = null;
				clearOwnRunMark();
				if (closed) return;
				compactionPending = false;
				compactionAbortExpected = false;
				waitingForSummary = false;
				const resume = interruptedTurn;
				interruptedTurn = false;
				if (!resume) return;
				holdOff = true;
				defer(() => {
					if (!ctx.isIdle()) return;
					pi.sendMessage({
						customType: RESUME_MESSAGE_TYPE,
						content: RESUME_FAILED_MESSAGE,
						display: false,
					}, { triggerTurn: true });
				});
			},
		});
	};

	const compactIfNeeded = (ctx: ExtensionContext, resumeTask = true) => {
		if (!active || compactionPending || holdOff) return;

		const usage = ctx.getContextUsage();
		if (usage?.percent == null || usage.percent <= thresholdOf(ctx)) return;

		compactionPending = true;
		runCompaction(ctx, resumeTask);
	};

	// Hide only empty abort produced when ctx.compact() cancels active run.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (
			!compactionPending ||
			!compactionAbortExpected ||
			!ctx.signal?.aborted ||
			message.role !== "assistant" ||
			message.stopReason !== "error" ||
			message.errorMessage !== COMPACTION_ABORT_ERROR ||
			message.content.some((part) => part.type !== "text" || part.text !== "")
		) return;

		compactionAbortExpected = false;
		return {
			message: { ...message, stopReason: "stop", errorMessage: undefined },
		};
	});

	// Do not use agent_settled here: long tool loops may cross threshold before
	// the full run settles. These hooks inspect every provider-turn boundary.
	// Pre-turn catches resumed/queued work before provider request starts.
	// A run that starts while Pi still waits to summarize is stopped, so the summary can begin;
	// the resume message continues it once the summary is in.
	pi.on("turn_start", (_event, ctx) => {
		if (compactionPending && waitingForSummary) {
			interruptedTurn = true;
			resumeAfter = true;
			compactionAbortExpected = true;
			appendLog("A turn started while the compaction waited for the previous one to stop; stopped it so the summary can start.");
			ctx.abort();
			return;
		}
		compactIfNeeded(ctx);
	});

	// Only tool-call turns need mid-run compaction.
	pi.on("turn_end", (event, ctx) => {
		if (hasToolCall(event.message)) compactIfNeeded(ctx);
	});

	// Catch threshold crossings caused by the final provider turn.
	// A turn that ends interrupts nothing, so the held-off compaction can run here.
	pi.on("agent_end", (_event, ctx) => {
		holdOff = false;
		compactIfNeeded(ctx, false);
	});

	// Runs before every provider request. Temporary truncation protects request
	// size while asynchronous default compaction summarizes persisted history.
	pi.on("context", (event, ctx) => {
		if (!active || compactionPending) return;

		const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const estimatedTokens = estimateTotalTokens(event.messages);
		if (contextWindow <= 0 || estimatedTokens <= contextWindow * thresholdOf(ctx) / 100) return;

		const truncated = keepRecent(
			event.messages,
			Math.floor(contextWindow * KEEP_RECENT_PERCENT / 100),
		);
		if (!truncated) return;
		// Held off: protect the request size, but do not interrupt the resumed turn.
		if (holdOff) return { messages: truncated };

		// Mark pending before deferring. Another context event can fire before
		// setImmediate runs, and must not schedule a second compaction.
		compactionPending = true;
		defer(() => runCompaction(ctx));
		return { messages: truncated };
	});

	pi.registerCommand("auto-compact", {
		description: "configure automatic compaction threshold; 'model' sets it for the current model",
		handler: async (args, ctx) => {
			if (closed) return;
			const scope = args.trim();
			if (scope !== "" && scope !== "model") {
				ctx.ui.notify("Usage: /auto-compact [model]", "error");
				return;
			}
			const key = scope === "model" ? modelKey(ctx.model) : undefined;
			if (scope === "model" && key === undefined) {
				ctx.ui.notify("No current model to set an auto-compact threshold for.", "error");
				return;
			}

			let current: AutoCompactConfig;
			try {
				current = configStore.loadSync().value;
			} catch {
				ctx.ui.notify("Couldn't read pi-auto-compact config.", "error");
				return;
			}

			const own = key === undefined ? undefined : current.modelThresholds?.[key];
			const input = await ctx.ui.input(
				key === undefined
					? `Auto-compact threshold (%) · current: ${current.autoCompactThreshold}`
					: `Auto-compact threshold for ${key} (%) · current: ${own ?? `${thresholdFor(current, ctx.model)} (inherited)`}`,
				key === undefined
					? "Enter a number at least 25 and below 100"
					: "Enter a number at least 25 and below 100, or default",
			);
			if (closed || input === undefined) return;

			const text = input.trim();
			const reset = key !== undefined && text.toLowerCase() === "default";
			const threshold = Number(text);
			if (!reset && !isValidThreshold(threshold)) {
				ctx.ui.notify("Threshold must be at least 25% and below 100%.", "error");
				return;
			}

			let next: AutoCompactConfig;
			try {
				next = withThreshold(configStore.loadSync().value, key, reset ? undefined : threshold);
				await configStore.save(next);
			} catch {
				if (!closed) ctx.ui.notify("Couldn't save pi-auto-compact config.", "error");
				return;
			}
			if (closed) return;
			config = next;
			ctx.ui.notify(
				key === undefined
					? `Auto-compact threshold set to ${threshold}%.`
					: reset
						? `Auto-compact threshold for ${key} removed; using the default ${thresholdFor(next, ctx.model)}%.`
						: `Auto-compact threshold for ${key} set to ${threshold}%.`,
				"info",
			);
		},
	});

	// Pi's built-in automatic compaction competes with this extension. Refuse
	// activation unless effective global/project settings disable it.
	pi.on("session_start", (event, ctx) => {
		if (closed) return;
		configStamp = configStampNow();
		try {
			config = configStore.loadSync().value;
		} catch {
			config = { autoCompactThreshold: DEFAULT_COMPACT_THRESHOLD_PERCENT };
			ctx.ui.notify(`Couldn't read pi-auto-compact config; using ${DEFAULT_COMPACT_THRESHOLD_PERCENT}%.`, "error");
		}

		active = !SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionEnabled();
		if (!active) throw new Error(ACTIVATION_ERROR);

		// A marker of ours that nobody cleared means a compaction of a replaced instance. Hold
		// its start time: the cancellation Pi is about to report belongs to it.
		inheritedStartedAt = readOwnRunStart();
		if (inheritedStartedAt !== null) armOrphanNotice(ctx);

		// Resume/fork can load an already-large session before first turn.
		if (event.reason === "resume" || event.reason === "fork") compactIfNeeded(ctx);
	});

	// Pi's own message for a cancelled manual compaction is a bare red line. This says what
	// happened, and writes it where it survives the next compaction.
	pi.on("session_compact_failed", (event, ctx) => {
		if (closed) return;
		const ours = compactionPending;
		// With no state of its own, this instance can still have started the compaction: a
		// reload replaced the instance, not the process.
		const inherited = ours ? null : inheritedStartedAt ?? readOwnRunStart();
		const startedAt = ours ? compactionStartedAt : inherited;
		clearStallNotice();
		clearOrphanNotice();
		clearOwnRunMark();
		compactionStartedAt = null;
		inheritedStartedAt = null;
		const percent = readPercent(ctx);
		// Only a cancellation inherited from a replaced instance means a reload took the
		// compaction away. Esc reaches the instance that started it, and stays final.
		const retrying = event.aborted && inherited !== null && recoverLostCompaction(ctx, percent);
		const text = describeCompactionFailure(event, {
			ours, inherited: inherited !== null, retrying, resuming: ours && interruptedTurn, startedAt, percent, threshold: thresholdOf(ctx),
		});
		report(ctx, `${text} Log: ${logPath()}`, event.aborted ? "warning" : "error");
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// Pi is summarizing now; a later turn no longer holds the compaction back.
		if (compactionPending) waitingForSummary = false;
		if (
			!active ||
			!compactionPending ||
			event.signal.aborted ||
			event.customInstructions !== COMPACTION_INSTRUCTIONS
		) return;

		// Pi omits details from prior extension compactions when preparing next run.
		const previous = [...event.branchEntries].reverse().find((entry) => entry.type === "compaction");
		if (previous?.details && typeof previous.details === "object") {
			const details = previous.details as { readFiles?: unknown; modifiedFiles?: unknown };
			if (Array.isArray(details.readFiles)) {
				for (const path of details.readFiles) {
					if (typeof path === "string") event.preparation.fileOps.read.add(path);
				}
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const path of details.modifiedFiles) {
					if (typeof path === "string") event.preparation.fileOps.edited.add(path);
				}
			}
		}

		const routes = configuredTaskRoutes(ctx);
		if (!routes.length) {
			// Without a route this handler stops here, so the single retry against a
			// truncated summary never runs. That used to be silent.
			if (!missingRouteReported) {
				missingRouteReported = true;
				report(
					ctx,
					"No auto-compact task model route is configured, so Pi summarizes on its own: this extension's retry for a truncated summary does not apply, and the list of skills already routed is not added to the summary either.",
					"info",
				);
			}
			return;
		}
		// One extra compact invocation per event, not one per route or split summary.
		let recoveryUsed = false;

		try {
			const result = await executeTaskRoutes(
				routes,
				async (route) => {
					if (closed) throw new Error("Auto-compaction session closed.");
					event.signal.throwIfAborted();
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(route.model);
					if (closed) throw new Error("Auto-compaction session closed.");
					event.signal.throwIfAborted();
					if (!auth.ok) throw new Error("Configured task model authentication failed.");

					const requestModel = auth.baseUrl ? { ...route.model, baseUrl: auth.baseUrl } : route.model;
					const headers = withoutDeletedHeaders(auth.headers);
					const summarize = (thinking: ResolvedTaskRoute["thinkingLevel"], instructions: string) => compact(
						event.preparation, requestModel, auth.apiKey, headers, instructions,
						event.signal, thinking, undefined, auth.env,
					);
					try {
						return { compaction: await summarize(route.thinkingLevel, COMPACTION_INSTRUCTIONS) };
					} catch (error) {
						if (closed || event.signal.aborted || recoveryUsed || !isIncompleteSummary(error)) throw error;
						recoveryUsed = true;
						ctx.ui.notify("Summary hit the token cap; retrying once without thinking and with concise instructions.", "warning");
						return { compaction: await summarize("off", `${COMPACTION_INSTRUCTIONS}\n${SUMMARY_RECOVERY_INSTRUCTIONS}`) };
					}
				},
				{ signal: event.signal, shouldFallback: () => !closed && !event.signal.aborted },
			);
			if (closed) return { cancel: true };
			if (!event.signal.aborted) return withLoadedSkills(result, event.preparation.fileOps.read);
		} catch {
			if (closed) return { cancel: true };
			if (event.signal.aborted) return;
		}

		if (!event.signal.aborted) {
			ctx.ui.notify("Configured task model routes failed; using current session model.", "error");
		}
	});
}
