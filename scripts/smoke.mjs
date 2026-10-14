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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAppServer, resolveCodexBin } from "../src/app-server.js";
import { CodexBridge } from "../src/bridge.js";
import { allTools, TOOL_NAMES } from "../src/tools/index.js";
import { compactLimits, listThreads, readAccountState } from "../src/codex.js";
import { collectBoard } from "../src/board.js";
import { decideAutoContinue } from "../src/autopilot.js";
import { classifyFailure, supervisionBrief } from "../src/supervise.js";
import { readWorkspace } from "../src/workspace.js";
import { Takeovers, takeoverDecision } from "../src/takeover.js";
import * as plugin from "../src/index.js";

let failures = 0;
/** @param ok - whether the check passed. @param label - what was checked. @param detail - extra context. */
function check(ok, label, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/**
 * Is this error our client's fault, or did Codex fail to answer for its own
 * reasons? The account endpoints are answered by OpenAI behind the local
 * app-server, so a transport failure or a Codex-internal refusal says nothing
 * about this plugin: it is reported loudly and does not fail the run, because the
 * shape checks that follow still prove our half works.
 *
 * A protocol-shaped error is the opposite: it means we sent the wrong method or
 * the wrong arguments, and that IS a hard failure.
 */
const OUR_FAULT = /method not found|unknown (method|variant)|invalid (params|request)|not supported|-32\d{3}|unexpected (type|value)/i;
function checkBackend(label, error) {
  const text = `${error?.message ?? error}`;
  if (!OUR_FAULT.test(text)) {
    console.log(`! ${label} — Codex could not answer for its own reasons: ${text.slice(0, 160)}`);
    return;
  }
  check(false, label, String(error));
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
if (state.account?.error) {
  checkBackend("account/read answered", state.account.error);
} else {
  check(
    state.account !== undefined && state.account !== null,
    "account/read answered",
    state.account?.account?.email ?? state.account?.account?.planType ?? "no email or plan in the reply",
  );
}

const limits = compactLimits(state.limits);
if (state.limits?.error) {
  checkBackend("account/rateLimits/read answered", state.limits.error);
} else {
  check(
    limits !== null,
    "account/rateLimits/read answered",
    limits?.primary ? `${limits.primary.usedPercent}% of ${limits.primary.windowMins}min window` : "no active window",
  );
}

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

// The board's colours rest on the turn rollups, and the handoff brief quotes
// them, so these two reads have to answer on this build as well. Read-only.
if (probe) {
  const turns = await client.call("thread/turns/list", { threadId: probe, limit: 3, sortDirection: "desc", itemsView: "summary" });
  const rollups = turns?.data ?? [];
  check(Array.isArray(turns?.data), "thread/turns/list answered", `${rollups.length} recent turn(s)`);
  check(
    rollups.every((turn) => typeof turn?.id === "string" && typeof turn?.status === "string"),
    "every turn carries an id and a status",
    rollups[0] ? `newest is ${rollups[0].status}` : "",
  );
  const goal = await client.call("thread/goal/get", { threadId: probe });
  check(goal !== null && typeof goal === "object", "thread/goal/get answered", goal?.goal ? `goal is ${goal.goal.status}` : "no goal on this thread");
  const read = await client.call("thread/read", { threadId: probe });
  check(typeof read?.thread?.id === "string", "thread/read answered", `${read.thread.originator ?? "?"} / ${read.thread.cliVersion ?? "?"}`);
} else {
  check(true, "thread/turns/list, thread/goal/get, thread/read", "skipped — no recent thread to probe");
}

// One whole board snapshot: every method it touches is a read, so this is safe
// against a live app-server and proves the projection end to end.
const snapshot = await collectBoard(client, null, { maxThreads: 3, maxQueueProbes: 1, maxItemProbes: 1, maxTurnProbes: 1, includeAccount: true });
check(snapshot.columns.length === 4, "collectBoard built the four state columns", `${snapshot.totals.threads} thread(s) listed`);
check(
  snapshot.totals.needsHuman + snapshot.totals.blocked + snapshot.totals.running + snapshot.totals.noActivity === snapshot.totals.threads,
  "every card landed in exactly one state column",
  `${snapshot.totals.running} running / ${snapshot.totals.blocked} blocked / ${snapshot.totals.needsHuman} needs you / ${snapshot.totals.noActivity} nothing observed`,
);
check(
  snapshot.quota === null || typeof snapshot.quota.level === "string",
  "the snapshot carries the quota verdict",
  snapshot.quota ? snapshot.quota.line : "not read",
);
check(snapshot.probe.maxItemProbes === 1, "collectBoard honours maxItemProbes", `probed ${snapshot.probe.itemProbed.length}, failed ${snapshot.probe.itemProbeErrors.length}`);
const labelled = snapshot.columns.flatMap((column) => column.cards).filter((card) => card.lastItem !== null);
check(
  labelled.length > 0 || snapshot.probe.itemProbeErrors.length > 0,
  "the probed thread came back with a last item",
  labelled.length > 0 ? `${labelled[0].lastItem.type}: ${labelled[0].lastItem.text.split("\n")[0].slice(0, 48)}` : "no item was readable",
);

// The supervisor's own error strings are the ones this machine really recorded, so
// the classifier is exercised against them rather than against invented text.
const transport = classifyFailure({
  turnStatus: "failed",
  turnError: { message: "Error running remote compact task: stream disconnected before completion: Transport error: network error: error decoding response body" },
});
const quota = classifyFailure({
  turnStatus: "failed",
  turnError: { message: "You've hit your usage limit. To get more access now, send a request to your admin." },
});
check(transport.kind === "transient" && transport.retryable === true, "a dropped stream is classified retryable", transport.text);
check(quota.kind === "quota" && quota.retryable === false, "a usage limit is never retried by the supervisor", quota.text);
const supervised = decideAutoContinue(
  {
    threadId: "smoke", state: "needs-human", waitingCount: 0, queuedCount: 0, ageMs: 3_600_000,
    lastTurnId: "turn-1", turnStatus: "failed", turnError: { message: transport.quoted },
    goal: { objective: "finish the smoke run", status: "active" }, lastItem: null, turnItemCounts: { agentMessage: 1 },
    failure: transport, failureAgeMs: 2 * 86_400_000, lastSpoken: "I stopped after the first stage.",
  },
  { armed: true, expiresAt: Date.now() + 60_000, template: null },
  {},
  Date.now(),
);
check(supervised.code === "send-supervised-retry", "a transient failure is handed back to Codex", `${supervised.message.split("\n").length} brief line(s), ${supervised.message.length} chars`);
check(/I stopped after the first stage\./.test(supervised.message), "the brief quotes Codex's own words");

// Resume, do not replay: the real working directory is read the same way a pass reads it.
const workspace = await readWorkspace({ cwd: process.cwd(), timeoutMs: 5000 });
check(workspace.isRepo === true, "the workspace read found a repository", `${workspace.state} · ${workspace.changedCount} change(s)`);
const withWorkspace = supervisionBrief(
  { threadId: "smoke", turnError: { message: transport.quoted }, goal: { objective: "finish the smoke run", status: "active" }, turnItemCounts: { commandExecution: 3 } },
  { workspace },
);
check(/工作区状态/.test(withWorkspace), "the brief states the workspace, so a retry is not a replay");

// Takeover: a reached quota stays a call for a person until one is authorised.
check(takeoverDecision({ level: "reached" }, { handoffArmed: false }).action === "keep-red", "a reached quota stays red without an authorised takeover");
check(takeoverDecision({ level: "reached" }, { handoffArmed: true }).action === "prepare-handoff", "an authorised takeover prepares a brief");
const prepared = await new Takeovers().prepare(client, {
  threadId: (await listThreads(client, { limit: 1 }))[0]?.id,
  cwd: mkdtempSync(join(tmpdir(), "dcb-smoke-handoff-")),
  force: true,
});
check(prepared.ok === true && prepared.claimed === false, "a prepared brief is on disk and unclaimed", `${prepared.chars} chars at ${prepared.path}`);

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
