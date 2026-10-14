import assert from "node:assert/strict";
import test from "node:test";
import { deferred, harness } from "./fixtures/auto-compact-harness.mjs";

const opus = { provider: "anthropic", id: "opus" };
const luna = { provider: "openai-codex", id: "luna" };
// Saved values come from the vm realm; compare their JSON, not their prototypes.
const saved = h => JSON.parse(JSON.stringify(h.calls.saves));
const answered = value => { const input = deferred(); input.resolve(value); return input; };

async function compactsAt(percent, { config, model }) {
  const h = await harness({ config, model, percent }); await h.start();
  h.emit("turn_start");
  return h.calls.compactions.length === 1;
}

test("the threshold for provider/id replaces the general one", async () => {
  const config = { autoCompactThreshold: 70, modelThresholds: { "anthropic/opus": 95 } };
  assert.equal(await compactsAt(90, { config, model: opus }), false);
  assert.equal(await compactsAt(90, { config, model: luna }), true, "other models keep the general threshold");
});

test("a bare model id also matches, and a lower threshold compacts earlier", async () => {
  const config = { autoCompactThreshold: 95, modelThresholds: { opus: 30 } };
  assert.equal(await compactsAt(50, { config, model: opus }), true);
  assert.equal(await compactsAt(50, { config, model: luna }), false);
});

test("provider/id wins over the bare id", async () => {
  const config = { autoCompactThreshold: 70, modelThresholds: { opus: 95, "anthropic/opus": 30 } };
  assert.equal(await compactsAt(50, { config, model: opus }), true);
});

test("switching model applies the new model's threshold at the next check", async () => {
  const config = { autoCompactThreshold: 70, modelThresholds: { "anthropic/opus": 95 } };
  const h = await harness({ config, model: opus, percent: 90 }); await h.start();
  h.emit("turn_start");
  assert.equal(h.calls.compactions.length, 0);
  h.ctx.model = { contextWindow: 100, ...luna };
  h.emit("turn_start");
  assert.equal(h.calls.compactions.length, 1);
});

test("the context guard uses the model threshold too", async () => {
  // Three fixture messages estimate 300 tokens on a 100-token window: over any threshold.
  const config = { autoCompactThreshold: 70, modelThresholds: { "anthropic/opus": 95 } };
  const h = await harness({ config, model: opus, percent: 10 }); await h.start();
  const result = h.emit("context", { messages: [
    { role: "user", content: "a", timestamp: 0 }, { role: "user", content: "b", timestamp: 1 },
    { role: "user", content: "c", timestamp: 2 },
  ] });
  assert.ok(result?.messages, "still guarded: 300 tokens are over 95% of 100");
});

test("/auto-compact model saves the current model under provider/id and applies it", async () => {
  const h = await harness({ model: opus, percent: 50, input: answered("40") }); await h.start();
  await h.commands.get("auto-compact").handler("model", h.ctx);
  assert.deepEqual(saved(h), [{ autoCompactThreshold: 70, modelThresholds: { "anthropic/opus": 40 } }]);
  assert.match(h.calls.notifications.at(-1)[0], /anthropic\/opus set to 40%/);
  h.emit("turn_start");
  assert.equal(h.calls.compactions.length, 1, "50% is over the new 40% at once");
});

test("default removes the model entry and keeps the others", async () => {
  const config = { autoCompactThreshold: 70, modelThresholds: { "anthropic/opus": 40, luna: 90 } };
  const h = await harness({ config, model: opus, input: answered("default") }); await h.start();
  await h.commands.get("auto-compact").handler("model", h.ctx);
  assert.deepEqual(saved(h), [{ autoCompactThreshold: 70, modelThresholds: { luna: 90 } }]);
  assert.match(h.calls.notifications.at(-1)[0], /removed; using the default 70%/);
});

test("removing the last entry leaves no empty table", async () => {
  const config = { autoCompactThreshold: 70, modelThresholds: { "anthropic/opus": 40 } };
  const h = await harness({ config, model: opus, input: answered("default") }); await h.start();
  await h.commands.get("auto-compact").handler("model", h.ctx);
  assert.deepEqual(saved(h), [{ autoCompactThreshold: 70 }]);
});

test("the general command keeps the model thresholds", async () => {
  const config = { autoCompactThreshold: 70, modelThresholds: { luna: 90 } };
  const h = await harness({ config, input: answered("80") }); await h.start();
  await h.commands.get("auto-compact").handler("", h.ctx);
  assert.deepEqual(saved(h), [{ autoCompactThreshold: 80, modelThresholds: { luna: 90 } }]);
});

test("each save starts from the file as it is now, not as it was read", async () => {
  const input = deferred();
  const h = await harness({ model: opus, input }); await h.start();
  const command = h.commands.get("auto-compact").handler("model", h.ctx);
  h.stored.config = { autoCompactThreshold: 60, modelThresholds: { luna: 90 } };
  input.resolve("40"); await command;
  assert.deepEqual(saved(h), [{ autoCompactThreshold: 60, modelThresholds: { luna: 90, "anthropic/opus": 40 } }]);
});

for (const [label, args, model, message] of [
  ["an unknown argument", "everything", opus, /Usage: \/auto-compact \[model\]/],
  ["model without a current model", "model", undefined, /No current model/],
]) {
  test(`${label} is refused without asking or saving`, async () => {
    const h = await harness({ model, input: answered("40") }); await h.start();
    await h.commands.get("auto-compact").handler(args, h.ctx);
    assert.equal(h.calls.saves.length, 0);
    assert.match(h.calls.notifications.at(-1)[0], message);
  });
}

test("default is not a valid general threshold", async () => {
  const h = await harness({ input: answered("default") }); await h.start();
  await h.commands.get("auto-compact").handler("", h.ctx);
  assert.equal(h.calls.saves.length, 0);
  assert.match(h.calls.notifications.at(-1)[0], /at least 25% and below 100%/);
});

for (const [label, modelThresholds] of [
  ["a threshold out of range", { "anthropic/opus": 10 }],
  ["an empty key", { " ": 50 }],
  ["a list instead of a table", [50]],
]) {
  test(`${label} rejects the file and falls back to 70%`, async () => {
    const config = { autoCompactThreshold: 30, modelThresholds };
    const h = await harness({ config, model: opus, percent: 50 }); await h.start();
    assert.match(h.calls.notifications.at(-1)[0], /Couldn't read pi-auto-compact config; using 70%/);
    h.emit("turn_start");
    assert.equal(h.calls.compactions.length, 0, "50% is under the 70% fallback");
  });
}

const patterns = [{ match: "^anthropic/", threshold: 30 }, { match: "^openai", threshold: 90 }];

test("a pattern on provider/id gives its threshold; no match falls back to the general one", async () => {
  const config = { autoCompactThreshold: 70, modelPatterns: patterns };
  assert.equal(await compactsAt(50, { config, model: opus }), true, "anthropic at 30%");
  assert.equal(await compactsAt(80, { config, model: luna }), false, "openai-codex at 90%");
  assert.equal(await compactsAt(80, { config, model: { provider: "google", id: "gemini" } }), true, "general 70%");
});

test("the first matching pattern wins", async () => {
  const config = { autoCompactThreshold: 30, modelPatterns: [{ match: "opus", threshold: 95 }, { match: "^anthropic/", threshold: 30 }] };
  assert.equal(await compactsAt(50, { config, model: opus }), false);
});

test("an exact model entry wins over any pattern", async () => {
  const config = { autoCompactThreshold: 70, modelThresholds: { luna: 40 }, modelPatterns: patterns };
  assert.equal(await compactsAt(50, { config, model: luna }), true);
});

test("both commands keep the patterns, and the prompt shows the pattern threshold as inherited", async () => {
  const config = { autoCompactThreshold: 70, modelPatterns: patterns };
  const general = await harness({ config, input: answered("80") }); await general.start();
  await general.commands.get("auto-compact").handler("", general.ctx);
  assert.deepEqual(saved(general), [{ autoCompactThreshold: 80, modelPatterns: patterns }]);
  const prompts = [];
  const h = await harness({ config, model: opus, input: answered("40") }); await h.start();
  const ask = h.ctx.ui.input;
  h.ctx.ui.input = (title, ...rest) => { prompts.push(title); return ask(title, ...rest); };
  await h.commands.get("auto-compact").handler("model", h.ctx);
  assert.match(prompts[0], /current: 30 \(inherited\)/);
  assert.deepEqual(saved(h), [{ autoCompactThreshold: 70, modelPatterns: patterns, modelThresholds: { "anthropic/opus": 40 } }]);
  const reset = await harness({ config: saved(h)[0], model: opus, input: answered("default") }); await reset.start();
  await reset.commands.get("auto-compact").handler("model", reset.ctx);
  assert.deepEqual(saved(reset), [{ autoCompactThreshold: 70, modelPatterns: patterns }]);
  assert.match(reset.calls.notifications.at(-1)[0], /removed; using the default 30%/, "the pattern applies again");
});

for (const [label, modelPatterns] of [
  ["a pattern that does not compile", [{ match: "(", threshold: 50 }]],
  ["an empty pattern", [{ match: "", threshold: 50 }]],
  ["a pattern threshold out of range", [{ match: "^anthropic/", threshold: 100 }]],
  ["an object instead of a list", { "^anthropic/": 30 }],
  ["a bare string in the list", ["^anthropic/"]],
]) {
  test(`${label} rejects the file and falls back to 70%`, async () => {
    const config = { autoCompactThreshold: 30, modelPatterns };
    const h = await harness({ config, model: opus, percent: 50 }); await h.start();
    assert.match(h.calls.notifications.at(-1)[0], /Couldn't read pi-auto-compact config; using 70%/);
    h.emit("turn_start");
    assert.equal(h.calls.compactions.length, 0, "50% is under the 70% fallback");
  });
}
