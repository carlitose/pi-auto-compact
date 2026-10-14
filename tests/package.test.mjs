import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { sourceURL } from "./fixtures/auto-compact-harness.mjs";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

test("the package loads the extension, ships only what it needs, and keeps the original notice", () => {
  assert.equal(pkg.name, "@carlitose86/pi-auto-compact");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.pi.extensions, ["./extensions/auto-compact.ts"]);
  assert.deepEqual(pkg.files, ["extensions/auto-compact.ts", "README.md", "LICENSE"]);
  for (const file of pkg.files) assert.ok(existsSync(new URL(file, root)), file);
  assert.ok(existsSync(sourceURL));
  const license = readFileSync(new URL("LICENSE", root), "utf8");
  assert.match(license, /Copyright \(c\) 2026 Henry Wang/);
  assert.match(license, /Permission is hereby granted/);
});

test("runtime libraries are pinned and Pi itself is a peer", () => {
  assert.deepEqual(pkg.dependencies, { "@henryqw/pi-config-store": "3.1.0", "@henryqw/pi-task-models": "8.1.3" });
  assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], "*");
});
