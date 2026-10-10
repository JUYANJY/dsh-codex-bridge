#!/usr/bin/env node
/**
 * Smoke test against the real Codex app-server, no DSH process involved.
 *
 * It answers the two questions the unit tests deliberately cannot, because both
 * need a live binary: does the plugin's entrypoint register cleanly, and does the
 * shipped app-server client actually complete a handshake with the installed
 * Codex build?
 *
 * Nothing here writes to a Codex thread. Usage:
 *   node scripts/smoke.mjs
 */
import { CodexAppServer, resolveCodexBin } from "../src/app-server.js";
import { CodexBridge } from "../src/bridge.js";
import { allTools, TOOL_NAMES } from "../src/tools/index.js";
import { compactLimits, listThreads, readAccountState } from "../src/codex.js";
import { collectBoard } from "../src/board.js";
import * as plugin from "../src/index.js";

let failures = 0;
/** @param ok - whether the check passed. @param label - what was checked. @param detail - extra context. */
function check(ok, label, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

console.log("— entrypoint —");
check(plugin.name === "codex-bridge", "plugin name", plugin.name);
check(Array.isArray(plugin.inject) && plugin.inject.includes("tools"), "injects the tools service");
check(typeof plugin.apply === "function", "apply() is exported");

// Register against a stand-in context: this is what the loader does, minus cordis.
const registered = [];
plugin.apply({ tools: { register: (tool) => registered.push(tool) } }, { requestTimeoutMs: 5000 });
check(registered.length === TOOL_NAMES.length, "apply() registers every tool", `${registered.length}/${TOOL_NAMES.length}`);
check(
  registered.every((tool) => typeof tool.name === "string" && tool.parameters && tool.output),
  "every registered tool has a name, parameters and an output contract",
);

console.log("\n— binary —");
const bin = resolveCodexBin();
console.log(`  resolved: ${bin}`);

console.log("\n— live app-server —");
const client = new CodexAppServer();
const logs = [];
client.on("log", (line) => logs.push(line));
client.on("crashed", (error) => logs.push(`crashed: ${error.message}`));

const started = Date.now();
await client.start();
check(client.alive, "handshake completed", `${Date.now() - started}ms`);

const state = await readAccountState(client);
check(
  state.account !== undefined && state.account !== null && !state.account.error,
  "account/read answered",
  state.account?.account?.email ?? state.account?.account?.planType ?? String(state.account),
);

const limits = compactLimits(state.limits);
check(
  limits !== null,
  "account/rateLimits/read answered",
  limits?.primary ? `${limits.primary.usedPercent}% of ${limits.primary.windowMins}min window` : "no active window",
);

const threads = await listThreads(client, { limit: 5 });
check(Array.isArray(threads), "thread/list answered", `${threads.length} recent thread(s)`);

// `codex_queue action=list` is only a projection of thread/queue/list, so the
// method has to answer on this build. Read-only, and safe on a live thread.
const probe = threads[0]?.id;
if (probe) {
  const queue = await client.call("thread/queue/list", { threadId: probe });
  const entries = queue?.data ?? [];
  check(Array.isArray(queue?.data), "thread/queue/list answered", `${entries.length} waiting`);
  check(
    entries.every((entry) => typeof entry?.id === "string"),
    "every queue entry carries an id",
  );
} else {
  check(true, "thread/queue/list", "skipped — no recent thread to probe");
}

// The board's cards read `thread/items/list` for their "last" line, so the method
// has to answer on this build too. Read-only, and safe on a live thread.
if (probe) {
  const items = await client.call("thread/items/list", { threadId: probe, limit: 3, sortDirection: "desc" });
  const entries = items?.data ?? [];
  check(Array.isArray(items?.data), "thread/items/list answered", `${entries.length} recent item(s)`);
  check(
    entries.every((entry) => typeof entry?.item?.type === "string"),
    "every item carries a type",
  );
} else {
  check(true, "thread/items/list", "skipped — no recent thread to probe");
}

// One whole board snapshot: every method it touches is a read, so this is safe
// against a live app-server and proves the projection end to end.
const snapshot = await collectBoard(client, null, { maxThreads: 3, maxQueueProbes: 1, maxItemProbes: 1, includeAccount: false });
check(snapshot.columns.length === 4, "collectBoard built the four columns", `${snapshot.totals.threads} thread(s) listed`);
check(snapshot.probe.maxItemProbes === 1, "collectBoard honours maxItemProbes", `probed ${snapshot.probe.itemProbed.length}, failed ${snapshot.probe.itemProbeErrors.length}`);
const labelled = snapshot.columns.flatMap((column) => column.cards).filter((card) => card.lastItem !== null);
check(
  labelled.length > 0 || snapshot.probe.itemProbeErrors.length > 0,
  "the probed thread came back with a last item",
  labelled.length > 0 ? `${labelled[0].lastItem.type}: ${labelled[0].lastItem.text.split("\n")[0].slice(0, 48)}` : "no item was readable",
);

// The bridge is what the tools actually hold; make sure it can hand one out.
const bridge = new CodexBridge({ binary: bin, requestTimeoutMs: 5000 });
const viaBridge = await bridge.withClient((live) => listThreads(live, { limit: 1 }));
check(Array.isArray(viaBridge), "CodexBridge.withClient() works end to end");
bridge.dispose();
check(!bridge.client?.alive, "dispose() stopped the child");

client.stop();
check(!client.alive, "stop() detached the child");

console.log("\n— app-server log —");
console.log(logs.length ? logs.map((line) => `  ${line}`).join("\n") : "  (quiet)");

console.log(`\n${failures === 0 ? "smoke passed" : `smoke FAILED (${failures} check(s))`}`);
process.exit(failures === 0 ? 0 : 1);
