import assert from "node:assert/strict";
import test from "node:test";
import { contextEvent, deferred, harness, toolTurn } from "./fixtures/auto-compact-harness.mjs";

for (const reason of ["startup", "resume", "fork", "reload"]) {
  test(`active ${reason} session still compacts and continues once`, async () => {
    const h = await harness(); await h.start(reason);
    h.emit("turn_end", toolTurn);
    assert.equal(h.calls.compactions.length, 1);
    h.calls.compactions[0].onComplete(); h.flush();
    assert.equal(h.calls.sent.length, 1);
    assert.equal(h.calls.sent[0][0].customType, "pi-auto-compact/resume");
    assert.equal(h.calls.sent[0][1].triggerTurn, true);
  });
}

test("pending compaction is not duplicated across lifecycle hooks", async () => {
  const h = await harness(); await h.start();
  h.emit("turn_start"); h.emit("turn_end", toolTurn); h.emit("agent_end"); h.emit("context", contextEvent);
  assert.equal(h.calls.compactions.length, 1);
});

for (const mode of ["low", "busy", "final"]) {
  test(`${mode} control creates no automatic continuation`, async () => {
    const h = await harness({ percent: mode === "low" ? 60 : 90, idle: mode !== "busy" }); await h.start();
    h.emit(mode === "final" ? "agent_end" : "turn_start");
    assert.equal(h.calls.compactions.length, mode === "low" ? 0 : 1);
    h.calls.compactions[0]?.onComplete(); h.flush();
    assert.equal(h.calls.sent.length, 0);
  });
}

test("a failed compaction that interrupted a turn resumes it without compacting again", async () => {
  const h = await harness(); await h.start();
  h.emit("turn_start");
  h.emit("session_compact_failed", { reason: "manual", aborted: true });
  h.calls.compactions[0].onError(new Error("cancelled")); h.flush();
  assert.equal(h.calls.sent.length, 1, "the interrupted turn is answered");
  assert.equal(h.calls.sent[0][0].customType, "pi-auto-compact/resume");
  assert.match(h.calls.sent[0][0].content, /could not compact/);
  assert.equal(h.calls.sent[0][1].triggerTurn, true);
  assert.match(h.calls.notifications.at(-1)[0], /turn continues now without compacting/);
  h.emit("turn_start"); h.emit("turn_end", toolTurn);
  const result = h.emit("context", contextEvent); h.flush();
  assert.equal(result.messages.at(-1).content, "second", "the request size is still protected");
  assert.equal(h.calls.compactions.length, 1, "the resumed turn is not interrupted again");
  h.emit("agent_end");
  assert.equal(h.calls.compactions.length, 2, "compaction is tried again once the turn ends");
  h.calls.compactions[1].onError(new Error("cancelled")); h.flush();
  assert.equal(h.calls.sent.length, 1, "a compaction at the end of a turn interrupted nothing");
});

test("a failed compaction does not resume a session that is busy again", async () => {
  const h = await harness({ idle: false }); await h.start();
  h.emit("turn_start");
  h.calls.compactions[0].onError(new Error("cancelled")); h.flush();
  assert.equal(h.calls.sent.length, 0);
});

test("deferred context compaction still preserves system messages", async () => {
  const h = await harness(); await h.start();
  const result = h.emit("context", contextEvent);
  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages.at(-1).content, "second");
  assert.equal(h.calls.compactions.length, 0);
  h.flush(); assert.equal(h.calls.compactions.length, 1);
});

for (const mode of ["before-compaction", "after-complete", "late-complete", "late-error"]) {
  test(`shutdown makes ${mode} callbacks inert and cancels queued work`, async () => {
    const h = await harness(); await h.start();
    if (mode === "before-compaction") h.emit("context", contextEvent);
    else h.emit("turn_start");
    if (mode === "after-complete") h.calls.compactions[0].onComplete();
    const raced = [...h.callbacks];
    await h.shutdown(); await h.shutdown();
    assert.equal(h.timers.size, 0, "pending handles must be cancelled");
    if (mode === "late-complete") h.calls.compactions[0].onComplete();
    if (mode === "late-error") h.calls.compactions[0].onError(new Error("fixture error"));
    for (const callback of raced) callback(); // Also prove guards if cancellation lost the race.
    h.flush();
    assert.equal(h.calls.stale, 0); assert.equal(h.calls.sent.length, 0);
    if (mode === "before-compaction") assert.equal(h.calls.compactions.length, 0);
    await h.start("reload"); // A closed factory must not revive old callbacks.
    assert.equal(h.calls.stale, 0);
    const fresh = await harness(); await fresh.start(); fresh.emit("turn_start");
    fresh.calls.compactions[0].onComplete(); fresh.flush();
    assert.equal(fresh.calls.sent.length, 1);
  });
}

test("late input does not save or notify from the closed session", async () => {
  const input = deferred(); const h = await harness({ input }); await h.start();
  const command = h.commands.get("auto-compact").handler("", h.ctx);
  await h.shutdown(); input.resolve("80"); await command;
  assert.equal(h.calls.saves.length, 0); assert.equal(h.calls.notifications.length, 0);
});

for (const fail of [false, true]) {
  test(`late config save ${fail ? "failure" : "success"} does not use closed UI`, async () => {
    const input = deferred(), save = deferred(); const h = await harness({ input, save }); await h.start();
    const command = h.commands.get("auto-compact").handler("", h.ctx);
    input.resolve("80"); await new Promise(accept => setImmediate(accept));
    assert.equal(h.calls.saves.length, 1);
    await h.shutdown();
    if (fail) save.reject(new Error("fixture write failure")); else save.resolve();
    await command; assert.equal(h.calls.stale, 0); assert.equal(h.calls.notifications.length, 0);
  });
}

test("auth resolving after shutdown cannot call a model, fall back or notify", async () => {
  const auth = deferred(); const h = await harness({ auth, routes: [{ model: {} }, { model: {} }] }); await h.start();
  h.emit("turn_start");
  const result = h.emit("session_before_compact", {
    customInstructions: h.calls.compactions[0].customInstructions,
    branchEntries: [], preparation: { fileOps: { read: new Set(), edited: new Set() } },
    signal: new AbortController().signal,
  });
  assert.equal(h.calls.auth, 1);
  await h.shutdown(); auth.resolve({ ok: true, apiKey: "fixture-only" });
  assert.equal((await result).cancel, true);
  assert.equal(h.calls.auth, 1); assert.equal(h.calls.model, 0); assert.equal(h.calls.stale, 0);
});

test("built-in compaction conflict stays visible", async () => {
  const h = await harness({ builtIn: true });
  await assert.rejects(h.start(), /built-in auto-compaction is enabled/);
});

test("a compaction past the notice threshold reports how long it has been running", async () => {
  const h = await harness(); await h.start();
  h.emit("turn_start");
  assert.equal(h.calls.compactions.length, 1);
  assert.equal(h.timeouts.size, 1, "a running compaction arms exactly one notice");
  assert.equal(h.calls.notifications.length, 0, "nothing is said before the threshold");
  assert.equal(h.elapse(), 1);
  assert.equal(h.calls.notifications.length, 1);
  const [text, level] = h.calls.notifications[0];
  assert.match(text, /running for about \d+ min/);
  assert.match(text, /Esc cancels it/);
  assert.equal(level, "warning");
});

test("a compaction that finishes first says nothing and leaves no timer", async () => {
  const h = await harness(); await h.start();
  h.emit("turn_start");
  h.calls.compactions[0].onComplete(); h.flush();
  assert.equal(h.timeouts.size, 0, "the notice is cancelled when the summary lands");
  assert.equal(h.elapse(), 0);
  assert.equal(h.calls.notifications.length, 0);
});

test("a failed compaction also disarms the notice", async () => {
  const h = await harness(); await h.start();
  h.emit("turn_start");
  h.calls.compactions[0].onError(new Error("fixture failure"));
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.calls.notifications.length, 0);
});

test("the slow notice is said once per compaction, not once per elapsed check", async () => {
  const h = await harness(); await h.start();
  h.emit("turn_start");
  h.elapse(); h.elapse();
  assert.equal(h.calls.notifications.length, 1);
});

test("shutdown disarms the notice and a late elapse says nothing", async () => {
  const h = await harness(); await h.start();
  h.emit("turn_start");
  const pending = [...h.timeouts.values()];
  await h.shutdown();
  assert.equal(h.timeouts.size, 0);
  for (const entry of pending) entry.callback();
  assert.equal(h.calls.notifications.length, 0);
  assert.equal(h.calls.stale, 0);
});

for (const configured of [false, true]) {
  test(`a ${configured ? "configured" : "missing"} task route is ${configured ? "silent" : "reported once"}`, async () => {
    const routes = configured ? [{ model: {} }] : [];
    const h = await harness({ routes }); await h.start();
    h.emit("turn_start");
    const event = () => ({
      customInstructions: h.calls.compactions[0].customInstructions,
      branchEntries: [], preparation: { fileOps: { read: new Set(), edited: new Set() } },
      signal: new AbortController().signal,
    });
    await h.emit("session_before_compact", event());
    await h.emit("session_before_compact", event());
    const notices = h.calls.notifications.filter(([text]) => /task model route is configured/.test(text));
    assert.equal(notices.length, configured ? 0 : 1);
    if (!configured) assert.equal(notices[0][1], "info");
  });
}

test("a cancelled compaction of ours says what happened and where the log is", async () => {
  const h = await harness({ agentDir: "agent" }); await h.start();
  h.emit("agent_end");
  h.emit("session_compact_failed", { reason: "manual", aborted: true, willRetry: false, fromExtension: false });
  assert.equal(h.calls.notifications.length, 1);
  const [text, level] = h.calls.notifications[0];
  assert.equal(level, "warning");
  assert.match(text, /Compaction was cancelled after \d+ s \(Pi reason: manual\)/);
  assert.match(text, /This extension started it with ctx\.compact\(\)/);
  assert.match(text, /red error/);
  assert.match(text, /Esc while the compaction indicator is up/);
  assert.match(text, /Context was at 90% of the window \(threshold 70%\)/);
  assert.match(text, /next turn is still over the threshold and compacts again/);
  assert.match(text, /Log: agent\/pi-auto-compact\.log/);
});

test("a failed compaction names the error and is reported as an error", async () => {
  const h = await harness(); await h.start();
  h.emit("turn_start");
  h.emit("session_compact_failed", { reason: "threshold", aborted: false, errorMessage: "provider exploded" });
  const [text, level] = h.calls.notifications[0];
  assert.equal(level, "error");
  assert.match(text, /Compaction failed after \d+ s \(Pi reason: threshold\)/);
  assert.match(text, /Error: provider exploded/);
  assert.doesNotMatch(text, /Esc while the compaction indicator/);
});

test("a compaction this extension did not start is reported as not ours", async () => {
  const h = await harness(); await h.start();
  h.emit("session_compact_failed", { reason: "manual", aborted: true });
  const [text] = h.calls.notifications[0];
  assert.match(text, /This extension did not start it/);
  assert.match(text, /for an unknown time/);
});

test("every failure and stall notice is appended to the log with a timestamp", async () => {
  const h = await harness({ agentDir: "agent" }); await h.start();
  h.emit("turn_start");
  h.elapse();
  h.emit("session_compact_failed", { reason: "manual", aborted: true });
  assert.equal(h.calls.log.length, 2);
  for (const [path, line] of h.calls.log) {
    assert.equal(path, "agent/pi-auto-compact.log");
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /);
    assert.ok(line.endsWith("\n"));
  }
  assert.match(h.calls.log[0][1], /running for about/);
  assert.match(h.calls.log[1][1], /Compaction was cancelled/);
  assert.ok(!h.files.get("agent/pi-auto-compact.log").includes("fixture system"));
});

test("the log rotates once when it passes the size cap", async () => {
  const big = [["agent/pi-auto-compact.log", "x".repeat(512 * 1024)]];
  const h = await harness({ agentDir: "agent", files: big }); await h.start();
  h.emit("session_compact_failed", { reason: "manual", aborted: true });
  assert.deepEqual(h.calls.rotations, [["agent/pi-auto-compact.log", "agent/pi-auto-compact.log.1"]]);
  assert.equal(h.files.get("agent/pi-auto-compact.log.1").length, 512 * 1024);
  assert.match(h.files.get("agent/pi-auto-compact.log"), /Compaction was cancelled/);
});

test("a log write failure does not propagate and the notice still shows", async () => {
  const h = await harness({ appendFails: true }); await h.start();
  h.emit("turn_start");
  h.emit("session_compact_failed", { reason: "manual", aborted: true });
  assert.equal(h.calls.log.length, 0);
  assert.match(h.calls.notifications[0][0], /Compaction was cancelled/);
});

const MARKER = "agent/pi-auto-compact.run.json";

// A reload builds a new instance in the same process: same files, same pid, empty memory.
async function afterReload(options = {}) {
  const first = await harness({ agentDir: "agent", ...options });
  await first.start();
  first.emit("turn_start");
  assert.equal(first.calls.compactions.length, 1, "the first instance must have started one");
  const second = await harness({ agentDir: "agent", files: [...first.files], ...options });
  await second.start("reload");
  return { first, second };
}

test("a cancellation after a reload is attributed to the instance that started it", async () => {
  const { second } = await afterReload();
  second.emit("session_compact_failed", { reason: "manual", aborted: true });
  const [text, level] = second.calls.notifications.at(-1);
  assert.equal(level, "warning");
  assert.match(text, /Compaction was cancelled after \d+ s \(Pi reason: manual\)/);
  assert.match(text, /an earlier instance of this extension started it/i);
  assert.match(text, /reloaded or replaced while it ran/);
  assert.doesNotMatch(text, /for an unknown time/);
  assert.doesNotMatch(text, /This extension did not start it/);
  assert.equal(second.files.has(MARKER), false, "the marker is consumed");
});

test("a marker left by another process is neither used nor deleted", async () => {
  const foreign = JSON.stringify({ pid: 999, startedAt: Date.now() - 30_000 });
  const h = await harness({ agentDir: "agent", pid: 4242, files: [[MARKER, foreign]] });
  await h.start();
  h.emit("session_compact_failed", { reason: "manual", aborted: true });
  const [text] = h.calls.notifications.at(-1);
  assert.match(text, /This extension did not start it/);
  assert.match(text, /for an unknown time/);
  assert.equal(h.files.get(MARKER), foreign, "another process still owns its marker");
});

test("a marker of ours nobody explains is announced once the wait elapses", async () => {
  const own = JSON.stringify({ pid: 4242, startedAt: Date.now() - 120_000 });
  const h = await harness({ agentDir: "agent", pid: 4242, files: [[MARKER, own]] });
  await h.start("reload");
  assert.equal(h.calls.notifications.length, 0, "nothing is said while the report may still arrive");
  assert.equal(h.elapse(), 1);
  const notice = h.calls.notifications.filter(([text]) => /never finished/.test(text));
  assert.equal(notice.length, 1);
  assert.match(notice[0][0], /about 2 min/);
  assert.equal(notice[0][1], "warning");
  assert.match(h.calls.log.at(-1)[1], /never finished/);
  assert.equal(h.files.has(MARKER), false);
  await h.start("reload"); h.elapse();
  assert.equal(h.calls.notifications.filter(([text]) => /never finished/.test(text)).length, 1);
});

test("a cancellation after a reload leaves no orphan notice behind", async () => {
  const { second } = await afterReload();
  second.emit("session_compact_failed", { reason: "manual", aborted: true });
  // Since CSV-04 one timer does stay armed, and it is the retry, not the orphan notice:
  // elapsing it must start a compaction and say nothing about a compaction never finishing.
  assert.equal(second.elapse(), 1);
  assert.equal(second.calls.compactions.length, 1);
  assert.equal(second.calls.notifications.filter(([text]) => /never finished/.test(text)).length, 0);
});

test("a compaction started after a reload supersedes the inherited one", async () => {
  const { second } = await afterReload();
  second.emit("turn_start");
  assert.equal(second.calls.compactions.length, 1);
  assert.equal(second.elapse(), 1, "only the stall notice stays armed");
  assert.equal(second.calls.notifications.filter(([text]) => /never finished/.test(text)).length, 0);
});

for (const ending of ["complete", "error", "failed"]) {
  test(`the marker is gone once the compaction ${ending}s`, async () => {
    const h = await harness({ agentDir: "agent" }); await h.start();
    h.emit("turn_start");
    assert.equal(h.files.has(MARKER), true, "a running compaction is marked");
    assert.deepEqual(JSON.parse(h.files.get(MARKER)).pid, 4242);
    assert.ok(Number.isFinite(JSON.parse(h.files.get(MARKER)).startedAt));
    if (ending === "complete") h.calls.compactions[0].onComplete();
    if (ending === "error") h.calls.compactions[0].onError(new Error("fixture error"));
    if (ending === "failed") h.emit("session_compact_failed", { reason: "manual", aborted: true });
    h.flush();
    assert.equal(h.files.has(MARKER), false);
  });
}

test("the marker holds nothing but a process id and an instant", async () => {
  const h = await harness({ agentDir: "agent" }); await h.start();
  h.emit("context", contextEvent); h.flush();
  const [path, text] = h.calls.markerWrites.at(-1);
  assert.equal(path, MARKER);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["pid", "startedAt"]);
  assert.ok(!text.includes("fixture"));
});

for (const failure of ["markerWriteFails", "markerReadFails", "markerRemoveFails"]) {
  test(`a marker ${failure.replace("marker", "").replace("Fails", "").toLowerCase()} failure changes nothing`, async () => {
    const own = JSON.stringify({ pid: 4242, startedAt: Date.now() - 5_000 });
    const h = await harness({ agentDir: "agent", files: [[MARKER, own]], [failure]: true });
    await h.start();
    h.emit("turn_start");
    assert.equal(h.calls.compactions.length, 1, "compaction still runs");
    h.emit("session_compact_failed", { reason: "manual", aborted: true });
    assert.match(h.calls.notifications.at(-1)[0], /Compaction was cancelled/);
    h.calls.compactions[0].onComplete(); h.flush();
    assert.equal(h.calls.sent.length, 1, "the continuation still goes out");
  });
}

test("a failure after shutdown says nothing", async () => {
  const h = await harness(); await h.start();
  h.emit("turn_start");
  await h.shutdown();
  h.emit("session_compact_failed", { reason: "manual", aborted: true });
  assert.equal(h.calls.notifications.length, 0);
  assert.equal(h.calls.stale, 0);
});

// CSV-04: a reload cancels a compaction that was already running. Until now the extension
// only said so; the work was lost and the next turn crossed the threshold again. What the
// user cancels by hand is a different case and must stay cancelled.

test("a compaction cancelled by a reload is started again", async () => {
  const { second } = await afterReload();
  second.emit("session_compact_failed", { reason: "manual", aborted: true });
  assert.equal(second.calls.compactions.length, 0, "not before the session has settled");
  second.elapse();
  assert.equal(second.calls.compactions.length, 1, "the lost compaction is retried once");
  assert.equal(second.files.has(MARKER), true, "the retry leaves its own marker");
});

test("the notice says the compaction is being retried, not that the next turn will", async () => {
  const { second } = await afterReload();
  second.emit("session_compact_failed", { reason: "manual", aborted: true });
  const [text] = second.calls.notifications.at(-1);
  assert.match(text, /reloaded or replaced while it ran/);
  assert.match(text, /compacting again now/i);
  assert.doesNotMatch(text, /the next turn is still over the threshold/);
});

test("a compaction the user cancelled stays cancelled", async () => {
  const h = await harness({ agentDir: "agent" });
  await h.start();
  h.emit("turn_start");
  assert.equal(h.calls.compactions.length, 1);
  h.emit("session_compact_failed", { reason: "manual", aborted: true });
  h.elapse();
  assert.equal(h.calls.compactions.length, 1, "Esc means stop, not start over");
  const [text] = h.calls.notifications.at(-1);
  assert.doesNotMatch(text, /compacting again now/i);
});

test("a reload cancellation under the threshold is not retried", async () => {
  const first = await harness({ agentDir: "agent" });
  await first.start();
  first.emit("turn_start");
  const second = await harness({ agentDir: "agent", files: [...first.files], percent: 10 });
  await second.start("reload");
  second.emit("session_compact_failed", { reason: "manual", aborted: true });
  second.elapse();
  assert.equal(second.calls.compactions.length, 0, "there is nothing left to compact");
});

test("one retry per instance, however many cancellations arrive", async () => {
  const { second } = await afterReload();
  second.emit("session_compact_failed", { reason: "manual", aborted: true });
  second.elapse();
  second.emit("session_compact_failed", { reason: "manual", aborted: true });
  second.elapse();
  assert.equal(second.calls.compactions.length, 1, "a retry loop would be worse than the loss");
});

test("a compaction lost without any cancellation report is also started again", async () => {
  const own = JSON.stringify({ pid: 4242, startedAt: Date.now() - 120_000 });
  const h = await harness({ agentDir: "agent", pid: 4242, files: [[MARKER, own]] });
  await h.start("reload");
  h.elapse();
  const notice = h.calls.notifications.filter(([text]) => /never finished/.test(text));
  assert.equal(notice.length, 1);
  assert.match(notice[0][0], /compacting again now/i);
  h.elapse();
  assert.equal(h.calls.compactions.length, 1);
});

test("a retry never starts after shutdown", async () => {
  const { second } = await afterReload();
  second.emit("session_compact_failed", { reason: "manual", aborted: true });
  await second.shutdown();
  second.elapse();
  assert.equal(second.calls.compactions.length, 0);
  assert.equal(second.calls.stale, 0);
});

// A compaction drops the skill instructions from context, and the routing rule then asks for
// them again: in the 3 446 $ session ask-skills/SKILL.md was read 23 times. These cases pin the
// facts the summary carries so that re-reading is a choice about content, not about the rule.
const SKILLS = "C:/Users/CGS03/.agents/skills";
const TRUNCATED = "Summarization failed: generation hit the token cap and the summary is incomplete";

const compactEvent = (h, read, branchEntries = []) => ({
  customInstructions: h.calls.compactions[0].customInstructions,
  branchEntries,
  preparation: { fileOps: { read: new Set(read), edited: new Set() } },
  signal: new AbortController().signal,
});

async function summaryFor({ read, files = [], branchEntries = [], compact, routes = [{ model: {} }] }) {
  const h = await harness({ routes, files, compact });
  await h.start();
  h.emit("turn_start");
  const result = await h.emit("session_before_compact", compactEvent(h, read, branchEntries));
  return { h, summary: result?.compaction?.summary };
}

test("a skill read in this session is named in the summary with its digest", async () => {
  const path = `${SKILLS}/ask-skills/SKILL.md`;
  const { summary } = await summaryFor({ read: [path], files: [[path, "route requests here"]] });
  assert.ok(summary.startsWith("fixture"), "the produced summary is kept whole");
  assert.match(summary, /ask-skills/);
  assert.match(summary, /sha256:[0-9a-f]{16}/);
  assert.match(summary, /on disk at compaction/i);
  assert.match(summary, /no longer in context/i);
});

test("a skill file that cannot be read is marked, not dropped", async () => {
  const path = `${SKILLS}/gone/SKILL.md`;
  const { summary } = await summaryFor({ read: [path] });
  assert.match(summary, /gone/);
  assert.match(summary, /unreadable at compaction/i);
});

test("a file that is not a SKILL.md stays out of the block", async () => {
  const skill = `${SKILLS}/tdd/SKILL.md`;
  const other = "C:/project/docs/OPERATING-DEFAULTS.md";
  const { summary } = await summaryFor({ read: [other, skill], files: [[skill, "red green"]] });
  assert.match(summary, /tdd/);
  assert.equal(/OPERATING-DEFAULTS/.test(summary), false);
});

test("a session that read no skill gets no block at all", async () => {
  const { summary } = await summaryFor({ read: ["C:/project/docs/notes.md"] });
  assert.equal(summary, "fixture");
});

test("repeated paths make one entry and entries come out sorted by skill", async () => {
  const zeta = `${SKILLS}/zeta/SKILL.md`, alpha = `${SKILLS}/alpha/SKILL.md`;
  const helper = await harness({ routes: [{ model: {} }], files: [[zeta, "z"], [alpha, "a"]] });
  await helper.start();
  helper.emit("turn_start");
  const event = compactEvent(helper, [], []);
  event.preparation.fileOps.read = [zeta, alpha, zeta];
  const summary = (await helper.emit("session_before_compact", event))?.compaction?.summary;
  assert.equal(summary.match(/^- zeta /gm).length, 1, "one entry per path");
  assert.ok(summary.indexOf("alpha") < summary.indexOf("zeta"), "sorted by skill name");
});

test("past the cap the block says how many skills it left out", async () => {
  const many = Array.from({ length: 34 }, (_, index) => `${SKILLS}/skill-${String(index).padStart(2, "0")}/SKILL.md`);
  const { summary } = await summaryFor({ read: many, files: many.map((path) => [path, "body"]) });
  assert.match(summary, /4 more/);
});

test("skills inherited from the previous compaction are still listed", async () => {
  const path = `${SKILLS}/wayfinder/SKILL.md`;
  const branchEntries = [{ type: "compaction", details: { readFiles: [path], modifiedFiles: [] } }];
  const { summary } = await summaryFor({ read: [], branchEntries, files: [[path, "frontier"]] });
  assert.match(summary, /wayfinder/);
});

test("the retry after a truncated summary also carries the block", async () => {
  const path = `${SKILLS}/diagnose/SKILL.md`;
  let attempts = 0;
  const compact = () => {
    attempts += 1;
    if (attempts === 1) throw new Error(TRUNCATED);
    return { summary: "shorter fixture" };
  };
  const { summary } = await summaryFor({ read: [path], files: [[path, "reproduce first"]], compact });
  assert.equal(attempts, 2);
  assert.ok(summary.startsWith("shorter fixture"));
  assert.match(summary, /diagnose/);
});

test("without a configured route the notice also names the missing block", async () => {
  const { h } = await summaryFor({ read: [`${SKILLS}/tdd/SKILL.md`], routes: [] });
  const [text] = h.calls.notifications.find(([line]) => /task model route is configured/.test(line));
  assert.match(text, /skills/i);
});
