// Installed SDK compaction, synthetic completed provider responses; no network/auth/session mutation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { harness, sourceURL } from "./fixtures/auto-compact-harness.mjs";

if (!process.argv[2]) throw new Error("Pass the installed Pi SDK dist/index.js path");
const sdkURL = pathToFileURL(resolve(process.argv[2]));
const { compact } = await import(sdkURL.href);
const model = { id: "synthetic", provider: "fixture", api: "anthropic-messages", reasoning: true, maxTokens: 32000 };
const message = { role: "user", content: "Continue the pending task; preserve constraints.", timestamp: 0 };
const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function preparation(split = false, history = true) {
  return { firstKeptEntryId: "kept", tokensBefore: 90000,
    messagesToSummarize: history ? [message] : [], turnPrefixMessages: split ? [message] : [],
    isSplitTurn: split, previousSummary: "Previous complete summary.",
    settings: { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 },
    fileOps: { read: new Set(), edited: new Set(), written: new Set() } };
}
function stream(stopReason, responseModel = model) {
  return { result: async () => ({ role: "assistant", provider: responseModel.provider,
    api: responseModel.api, model: responseModel.id, stopReason, usage, timestamp: 1,
    content: [{ type: "text", text: stopReason === "length" ? "INCOMPLETE_DO_NOT_PERSIST" : "Complete synthetic summary." }] }) };
}
const baselineSignal = new AbortController().signal;
await assert.rejects(compact(preparation(), model, "fixture-only", undefined, "focus", baselineSignal,
  "medium", async () => stream("length")), /Summarization failed: generation hit the token cap and the summary is incomplete/);

const scenarios = [
  { name: "success", stops: ["stop"], calls: 1 },
  { name: "history-recovery", stops: ["length", "stop"], calls: 2 },
  { name: "prefix-recovery", split: true, history: false, stops: ["length", "stop"], calls: 2 },
  { name: "split-history-prefix-recovery", split: true, stops: ["stop", "length", "stop", "stop"], calls: 4 },
  { name: "exhaustion", stops: ["length", "length"], calls: 2, fails: true },
  { name: "model-cap", stops: ["length", "stop"], calls: 2, maxTokens: 2048 },
];
const results = [];
for (const scenario of scenarios) {
  const observed = []; let compacts = 0;
  const selectedModel = { ...model, maxTokens: scenario.maxTokens ?? model.maxTokens };
  const h = await harness({ routes: [{ model: selectedModel, thinkingLevel: "medium" }], compact: async (...args) => {
    compacts++;
    args[7] = async (requestModel, context, options) => {
      assert.equal(requestModel, selectedModel);
      const nth = observed.length;
      assert.ok(nth < scenario.stops.length, "no unbudgeted provider call");
      observed.push({ maxTokens: options.maxTokens, reasoning: options.reasoning ?? "off", cacheRetention: options.cacheRetention });
      assert.equal(options.signal, signal);
      assert.equal(options.cacheRetention, "none");
      return stream(scenario.stops[nth], requestModel);
    };
    return compact(...args);
  } });
  await h.start(); h.emit("turn_start");
  const signal = new AbortController().signal;
  const input = preparation(scenario.split, scenario.history !== false);
  const result = await h.emit("session_before_compact", { preparation: input, signal,
    customInstructions: h.calls.compactions[0].customInstructions,
    branchEntries: [{ type: "compaction", details: { readFiles: ["old.ts"], modifiedFiles: ["changed.ts"] } }],
  });
  assert.equal(observed.length, scenario.calls);
  assert.equal(compacts, scenario.name === "success" ? 1 : 2);
  assert.equal(input.settings.reserveTokens, 16384);
  const firstLimit = scenario.split && scenario.history === false ? 8192 : 13107;
  assert.equal(observed[0].maxTokens, Math.min(firstLimit, selectedModel.maxTokens));
  assert.equal(observed[0].reasoning, "medium");
  if (compacts === 2) assert.equal(observed.at(-1).reasoning, "off");
  if (scenario.fails) {
    assert.equal(result, undefined);
    assert.match(h.calls.notifications.at(-1)[0], /using current session model/);
  } else {
    assert.equal(result.compaction.firstKeptEntryId, "kept");
    assert.equal(result.compaction.tokensBefore, 90000);
    assert.doesNotMatch(result.compaction.summary, /INCOMPLETE_DO_NOT_PERSIST/);
    assert.match(result.compaction.summary, /Complete synthetic summary/);
    assert.deepEqual(result.compaction.details, { readFiles: ["old.ts"], modifiedFiles: ["changed.ts"] });
    assert.equal(result.compaction.usage.output, scenario.split && scenario.history !== false ? 40 : 20);
  }
  assert.equal(h.calls.sent.length, 0, "only the host's onComplete may authorize continuation");
  results.push({ name: scenario.name, compacts, calls: observed, returned_complete_result: Boolean(result) });
  await h.shutdown();
}
console.log(JSON.stringify({ scope: "real installed SDK compact; synthetic provider/config/routes; no live session or model",
  source_sha256: createHash("sha256").update(readFileSync(sourceURL)).digest("hex"),
  sdk_compaction_sha256: createHash("sha256").update(readFileSync(new URL("core/compaction/compaction.js", sdkURL))).digest("hex"),
  baseline_length_rejected: true, results }, null, 2));
