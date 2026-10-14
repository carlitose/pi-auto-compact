// Real ExtensionRunner invalidation in bounded children; config/compaction/transport are fixtures.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { contextEvent, harness, sourceURL, toolTurn } from "./fixtures/auto-compact-harness.mjs";

const sdk = process.argv[2];
if (!sdk) throw new Error("Pass the installed Pi SDK dist/index.js path");
const mode = process.argv[3];
const source = process.argv[4] ? pathToFileURL(resolve(process.argv[4])) : sourceURL;
const runnerURL = pathToFileURL(join(dirname(resolve(sdk)), "core/extensions/runner.js"));
if (!mode || mode === "--upstream-negative") {
  const results = [];
  for (const scenario of ["active", "after-complete", "before-compaction", "late-complete"]) {
    const start = performance.now();
    const result = spawnSync(process.execPath, ["--experimental-vm-modules", fileURLToPath(import.meta.url),
      sdk, scenario, fileURLToPath(source)], { encoding: "utf8", timeout: 15000, maxBuffer: 65536 });
    assert.equal(result.signal, null, "child must terminate without timeout");
    assert.equal(result.error, undefined);
    const expected = mode === "--upstream-negative" && scenario !== "active" ? 1 : 0;
    results.push({ scenario, elapsed_ms: performance.now() - start, exit_code: result.status, stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.status, expected, JSON.stringify(results.at(-1)));
    if (expected) assert.match(result.stderr, /This extension ctx is stale after session replacement or reload/);
    else assert.equal(JSON.parse(result.stdout).sent, scenario === "active" ? 1 : 0);
  }
  console.log(JSON.stringify({ scope: "real host guard, simulated compaction/config/transport; no live sessions, model or reload",
    sources: [source, runnerURL].map(url => ({ path: fileURLToPath(url), sha256: createHash("sha256").update(readFileSync(url)).digest("hex") })),
    results }, null, 2));
} else {
  assert.ok(["active", "after-complete", "before-compaction", "late-complete"].includes(mode));
  const { ExtensionRunner } = await import(runnerURL.href);
  const runner = new ExtensionRunner([], { invalidate() {} }, "isolated-fixture", {}, {});
  const pending = [];
  runner.getContextUsageFn = () => ({ percent: 90, contextWindow: 100 });
  runner.compactFn = options => pending.push(options);
  const h = await harness({ ctx: runner.createContext(), realTimers: true, source });
  await h.start();
  if (mode === "before-compaction") h.emit("context", contextEvent);
  else h.emit("turn_end", toolTurn);
  if (mode === "active" || mode === "after-complete") pending[0].onComplete();
  if (mode !== "active") { await h.shutdown(); runner.invalidate(); }
  if (mode === "late-complete") pending[0].onComplete();
  await new Promise(accept => setImmediate(accept));
  await new Promise(accept => setImmediate(accept));
  console.log(JSON.stringify({ mode, sent: h.calls.sent.length }));
}
