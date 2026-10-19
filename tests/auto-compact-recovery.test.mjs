import assert from "node:assert/strict";
import test from "node:test";
import { deferred, harness } from "./fixtures/auto-compact-harness.mjs";

const lengthError = (label = "Summarization") => new Error(`${label} failed: generation hit the token cap and the summary is incomplete`);
const route = { model: { id: "fixture", maxTokens: 32000 }, thinkingLevel: "medium" };
const completed = { summary: "complete", firstKeptEntryId: "kept", tokensBefore: 90000,
  usage: { output: 10 }, details: { readFiles: ["prior.ts"], modifiedFiles: ["changed.ts"] } };
function eventFor(h, signal = new AbortController().signal) {
  return {
    customInstructions: h.calls.compactions.at(-1).customInstructions, signal,
    preparation: { firstKeptEntryId: "kept", tokensBefore: 90000,
      messagesToSummarize: [], turnPrefixMessages: [], previousSummary: "previous complete checkpoint",
      settings: { reserveTokens: 16384, keepRecentTokens: 20000, enabled: false },
      fileOps: { read: new Set(), edited: new Set() } },
    branchEntries: [{ type: "compaction", details: { readFiles: ["prior.ts"], modifiedFiles: ["changed.ts"] } }],
  };
}
async function started(options) {
  const h = await harness({ routes: [route], ...options });
  await h.start(); h.emit("turn_start"); return h;
}

for (const label of ["Summarization", "Turn prefix summarization"]) {
  test(`${label} length recovers once without changing preparation or limits`, async () => {
    const args = [];
    const h = await started({ compact: async (...input) => {
      args.push(input); if (args.length === 1) throw lengthError(label); return completed;
    } });
    const event = eventFor(h);
    const result = await h.emit("session_before_compact", event);
    assert.equal(result?.compaction, completed);
    assert.equal(args.length, 2);
    assert.equal(args[0][6], "medium"); assert.equal(args[1][6], "off");
    assert.equal(args[0][4], event.customInstructions);
    assert.ok(args[1][4].startsWith(event.customInstructions));
    assert.match(args[1][4], /concise/i);
    for (const index of [0, 1, 2, 3, 5, 7, 8]) assert.equal(args[0][index], args[1][index]);
    assert.equal(args[1][0], event.preparation);
    assert.equal(event.preparation.settings.reserveTokens, 16384);
    assert.equal(event.preparation.previousSummary, "previous complete checkpoint");
    assert.deepEqual([...event.preparation.fileOps.read], ["prior.ts"]);
    assert.deepEqual([...event.preparation.fileOps.edited], ["changed.ts"]);
    assert.equal(h.calls.auth, 1); assert.equal(h.calls.notifications.length, 1);
    assert.match(h.calls.notifications[0][0], /token cap.*retrying once/i);
    h.calls.compactions[0].onComplete(); h.flush(); assert.equal(h.calls.sent.length, 1);
  });
}

test("success passes the complete SDK result through without recovery", async () => {
  const h = await started({ compact: async () => completed });
  assert.equal((await h.emit("session_before_compact", eventFor(h))).compaction, completed);
  assert.equal(h.calls.model, 1); assert.equal(h.calls.notifications.length, 0);
});

for (const error of [new Error("network failed"), new Error("token cap unrelated"),
  new Error(lengthError().message + "\n"),
  new Error("Summarization failed: generation hit the token cap and the summary is incomplete: untrusted suffix"), "Summarization failed: generation hit the token cap and the summary is incomplete"]) {
  test(`no recovery for non-SDK error ${String(error)}`, async () => {
    const h = await started({ compact: async () => { throw error; } });
    assert.equal(await h.emit("session_before_compact", eventFor(h)), undefined);
    assert.equal(h.calls.model, 1);
    assert.equal(h.calls.notifications.length, 1);
    assert.match(h.calls.notifications[0][0], /using current session model/);
  });
}

test("one extra attempt shared across all routes, reset only for a new event", async () => {
  const levels = [];
  const h = await started({ routes: [route, route], compact: async (...args) => {
    levels.push(args[6]); throw lengthError();
  } });
  assert.equal(await h.emit("session_before_compact", eventFor(h)), undefined);
  assert.deepEqual(levels, ["medium", "off", "medium"]);
  assert.equal(h.calls.auth, 2); assert.equal(h.calls.notifications.length, 2);
  assert.equal(h.calls.sent.length, 0);
  h.calls.compactions[0].onError(lengthError()); h.emit("agent_end");
  await h.emit("session_before_compact", eventFor(h));
  assert.deepEqual(levels, ["medium", "off", "medium", "medium", "off", "medium"]);
});

test("ordinary failure does not consume recovery on the next route", async () => {
  let n = 0;
  const h = await started({ routes: [route, route], compact: async () => {
    if (++n === 1) throw new Error("network"); if (n === 2) throw lengthError(); return completed;
  } });
  assert.equal((await h.emit("session_before_compact", eventFor(h))).compaction, completed);
  assert.equal(n, 3); assert.equal(h.calls.auth, 2);
});

for (const moment of ["before", "auth", "model", "retry"]) {
  test(`abort ${moment} blocks further auth, models, UI and late success`, async () => {
    const controller = new AbortController(); const pending = deferred();
    const h = await started({ routes: [route, route], auth: moment === "auth" ? pending : undefined,
      compact: async () => {
        if (moment === "retry" && h.calls.model === 1) throw lengthError();
        return pending.promise;
      } });
    if (moment === "before") controller.abort();
    const operation = h.emit("session_before_compact", eventFor(h, controller.signal));
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(); pending.resolve(moment === "auth" ? { ok: true, apiKey: "fixture-only" } : completed);
    assert.equal(await operation, undefined);
    assert.equal(h.calls.auth, moment === "before" ? 0 : 1);
    assert.equal(h.calls.model, ["before", "auth"].includes(moment) ? 0 : moment === "retry" ? 2 : 1);
    assert.equal(h.calls.notifications.length, moment === "retry" ? 1 : 0);
    assert.equal(h.calls.sent.length, 0); assert.equal(h.calls.stale, 0);
  });
}

test("abort followed by length rejection cannot retry or fall back", async () => {
  const pending = deferred(); const controller = new AbortController();
  const h = await started({ routes: [route, route], compact: async () => pending.promise });
  const operation = h.emit("session_before_compact", eventFor(h, controller.signal));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(); pending.reject(lengthError());
  assert.equal(await operation, undefined);
  assert.equal(h.calls.model, 1); assert.equal(h.calls.auth, 1);
  assert.equal(h.calls.notifications.length, 0);
});

for (const when of ["initial", "recovery"]) {
  for (const outcome of ["length", "success"]) {
    test(`shutdown during ${when} ${outcome} never uses a stale context`, async () => {
      const pending = deferred();
      const h = await started({ routes: [route, route], compact: async () => {
        if (when === "recovery" && h.calls.model === 1) throw lengthError();
        return pending.promise;
      } });
      const operation = h.emit("session_before_compact", eventFor(h));
      await new Promise(resolve => setImmediate(resolve)); await h.shutdown();
      if (outcome === "length") pending.reject(lengthError()); else pending.resolve(completed);
      assert.equal((await operation).cancel, true);
      assert.equal(h.calls.auth, 1); assert.equal(h.calls.model, when === "recovery" ? 2 : 1);
      assert.equal(h.calls.stale, 0); assert.equal(h.calls.sent.length, 0);
      assert.equal(h.calls.notifications.length, when === "recovery" ? 1 : 0);
    });
  }
}

for (const mode of ["manual", "no-routes", "not-pending"]) {
  test(`${mode} leaves default compaction ownership unchanged`, async () => {
    const h = await started({ routes: mode === "no-routes" ? [] : [route] });
    const event = eventFor(h);
    if (mode === "manual") event.customInstructions = "user focus";
    if (mode === "not-pending") h.calls.compactions[0].onError(lengthError());
    assert.equal(await h.emit("session_before_compact", event), undefined);
    assert.equal(h.calls.auth, 0); assert.equal(h.calls.model, 0);
  });
}
