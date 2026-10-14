// Config, model routing, transport and timers are explicit fixtures; no live models or sessions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

export const sourceURL = new URL("../../extensions/auto-compact.ts", import.meta.url);
export const toolTurn = { message: { role: "assistant", content: [{ type: "toolCall" }] } };
export const contextEvent = { messages: [
  { role: "system", content: "fixture system" },
  { role: "user", content: "first", timestamp: 0 },
  { role: "user", content: "second", timestamp: 1 },
] };
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function harness(options = {}) {
  const handlers = new Map(), commands = new Map(), timers = new Map(), callbacks = [];
  const timeouts = new Map();
  const calls = { compactions: [], sent: [], notifications: [], saves: [], auth: 0, model: 0, stale: 0, cleared: 0, timeoutsCleared: 0, log: [], rotations: [], markerWrites: [], markerRemovals: [] };
  // Fixture filesystem: the extension's log never touches a real path in tests.
  const files = new Map(options.files ?? []);
  const stored = { config: options.config ?? { autoCompactThreshold: 70 } };
  let alive = true, nextId = 0;
  const check = () => { if (!alive) { calls.stale++; throw new Error("fixture stale context accessed"); } };
  const ui = {
    notify(...args) { check(); calls.notifications.push(args); },
    input() { check(); return options.input?.promise ?? Promise.resolve(undefined); },
  };
  const fixture = {
    ui, cwd: "fixture", model: { contextWindow: 100, ...options.model },
    signal: new AbortController().signal,
    isProjectTrusted() { check(); return false; },
    getContextUsage() { check(); return { percent: options.percent ?? 90, contextWindow: 100 }; },
    isIdle() { check(); return options.idle ?? true; },
    compact(request) { check(); calls.compactions.push(request); },
    modelRegistry: { async getApiKeyAndHeaders() {
      check(); calls.auth++;
      return options.auth ? options.auth.promise : { ok: true, apiKey: "fixture-only" };
    } },
  };
  // The real-runner smoke supplies its own context; do not replace its stale guard.
  const ctx = options.ctx ?? new Proxy(fixture, { get(target, name) { check(); return target[name]; } });
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    sendMessage(...args) { check(); calls.sent.push(args); },
  };
  const dependencies = {
    "node:path": { join: (...parts) => parts.join("/") },
    "node:fs": {
      appendFileSync(path, text) {
        if (options.appendFails) throw new Error("fixture write failure");
        calls.log.push([path, text]);
        files.set(path, (files.get(path) ?? "") + text);
      },
      statSync(path) {
        const content = files.get(path);
        if (content === undefined) throw new Error(`fixture missing ${path}`);
        return { size: content.length };
      },
      renameSync(from, to) {
        calls.rotations.push([from, to]);
        files.set(to, files.get(from) ?? "");
        files.delete(from);
      },
      // The run marker crosses a reload, so the fixture must also read and delete.
      writeFileSync(path, text) {
        if (options.markerWriteFails) throw new Error("fixture marker write failure");
        calls.markerWrites.push([path, text]);
        files.set(path, text);
      },
      readFileSync(path) {
        if (options.markerReadFails) throw new Error("fixture marker read failure");
        const content = files.get(path);
        if (content === undefined) throw new Error(`fixture missing ${path}`);
        return content;
      },
      rmSync(path) {
        if (options.markerRemoveFails) throw new Error("fixture marker remove failure");
        calls.markerRemovals.push(path);
        files.delete(path);
      },
    },
    // Real runtime exposes this global; the fixture names it so a test can own it.
    "node:process": { pid: options.pid ?? 4242 },
    // Digests are real: a fixture hash would prove nothing about what the block publishes.
    "node:crypto": { createHash },
    "@earendil-works/pi-coding-agent": {
      async compact(...args) {
        check(); calls.model++;
        return options.compact ? options.compact(...args) : { summary: "fixture" };
      },
      estimateTokens() { return 100; }, getAgentDir() { return options.agentDir ?? "fixture"; },
      SettingsManager: { create() { return { getCompactionEnabled() { return options.builtIn ?? false; } }; } },
    },
    // Like the real store, every read and write goes through the extension's own parser.
    "@henryqw/pi-config-store": { createConfigStore({ parse }) { return {
      loadSync() { return { value: parse(stored.config) }; },
      async save(value) {
        calls.saves.push(value); stored.config = parse(value);
        if (options.save) await options.save.promise;
      },
    }; } },
    "@henryqw/pi-task-models": {
      registerModelTask() {}, resolveConfiguredTaskRoutes() { return options.routes ?? []; },
      async executeTaskRoutes(routes, execute, config) {
        for (let i = 0; i < routes.length; i++) {
          try { return await execute(routes[i]); }
          catch (error) { if (i === routes.length - 1 || !config.shouldFallback(error)) throw error; }
        }
      },
    },
  };
  const realm = vm.createContext({
    setImmediate(callback) {
      if (options.realTimers) return setImmediate(callback);
      const id = ++nextId; timers.set(id, callback); callbacks.push(callback); return id;
    },
    clearImmediate(id) {
      calls.cleared++;
      if (options.realTimers) clearImmediate(id); else timers.delete(id);
    },
    // Fixture timeouts never fire on their own: tests decide when a wait elapses.
    setTimeout(callback, delay) {
      if (options.realTimers) return setTimeout(callback, delay);
      const id = ++nextId; timeouts.set(id, { callback, delay }); return id;
    },
    clearTimeout(id) {
      calls.timeoutsCleared++;
      if (options.realTimers) clearTimeout(id); else timeouts.delete(id);
    },
  });
  const url = options.source ?? sourceURL;
  const module = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url, "utf8")), { context: realm, identifier: String(url) });
  await module.link(specifier => {
    const values = dependencies[specifier];
    assert.ok(values, `unexpected dependency ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context: realm });
  });
  await module.evaluate();
  module.namespace.default(pi);
  return {
    ctx, calls, timers, callbacks, commands, timeouts, files, stored,
    elapse() {
      const pending = [...timeouts]; timeouts.clear();
      for (const [, entry] of pending) entry.callback();
      return pending.length;
    },
    emit(name, event = {}) { return handlers.get(name)?.(event, ctx); },
    async start(reason = "startup") { await handlers.get("session_start")?.({ reason }, ctx); },
    async shutdown() { await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx); alive = false; },
    flush() {
      let count = 0;
      while (timers.size) {
        assert.ok(count++ < 10, "bounded fixture timer drain");
        const pending = [...timers]; timers.clear();
        for (const [, callback] of pending) callback();
      }
    },
  };
}
