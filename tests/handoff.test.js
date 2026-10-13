/**
 * The handoff brief is what another model reads to continue a Codex project, so
 * the tests check that it quotes Codex's own records, that it says what it could
 * not read, and that a failed read never turns into invented content.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildHandoff, collectHandoff } from "../src/handoff.js";
import { budgetFromLimits } from "../src/quota.js";
import { handoffTool } from "../src/tools/handoff.js";

/** A thread with everything the brief can quote. @returns the fixture. */
function fixture() {
  return {
    now: 1791900000000,
    cwd: "/work/thing",
    thread: {
      id: "01a133d5-e21e-7df1-b4d8-9dde7d3d7e1d",
      title: "stage work",
      cwd: "/work/thing",
      path: "/Users/x/.codex/sessions/rollout-01a133d5.jsonl",
      gitBranch: "main",
      gitSha: "abc1234",
    },
    goal: {
      objective: "develop until every stage is done, testing after each stage",
      status: "active",
      tokensUsed: 1070878,
      tokenBudget: null,
      timeUsedSeconds: 2720,
    },
    turns: [
      { id: "turn-2", status: "failed", startedAt: 1791899000, completedAt: null, durationMs: 61000, error: { message: "stream disconnected before completion", codexErrorInfo: "other" } },
      { id: "turn-1", status: "completed", startedAt: 1791890000, completedAt: 1791890100, durationMs: 100000, error: null },
    ],
    items: [
      { type: "userMessage", text: "please finish stage C and test it" },
      { type: "reasoning", text: "(reasoning not exposed: encrypted)" },
      { type: "commandExecution", text: "$ pnpm test  [failed]" },
      { type: "fileChange", text: "2 files changed", path: "src/stage-c.js" },
      { type: "agentMessage", text: "stage C is half applied; the migration still needs a rollback" },
    ],
    approvals: [{ id: 9000, method: "item/commandExecution/requestApproval" }],
    queued: [{ id: "q-1" }],
    budget: budgetFromLimits({
      rateLimits: { limitId: "codex", planType: "plus", primary: { usedPercent: 12, windowDurationMins: 300 }, secondary: { usedPercent: 9, windowDurationMins: 10080 }, rateLimitReachedType: null, spendControlReached: null },
      ordinaryUsageAllowed: true,
      rateLimitResetCredits: { availableCount: 2, credits: [] },
    }),
    reason: "Codex's turn failed and the goal is still active.",
  };
}

test("the brief quotes the goal, the newest instruction and the stop, verbatim", () => {
  const { markdown, facts } = buildHandoff(fixture());
  assert.match(markdown, /^# Codex handoff — stage work$/m);
  assert.match(markdown, /thread: `01a133d5-e21e-7df1-b4d8-9dde7d3d7e1d`/);
  assert.match(markdown, /working directory: `\/work\/thing`/);
  assert.match(markdown, /git: main @ abc1234/);
  assert.match(markdown, /rollout: `\/Users\/x\/\.codex\/sessions\/rollout-01a133d5\.jsonl`/);
  assert.match(markdown, /- goal \(verbatim\): develop until every stage is done, testing after each stage/);
  assert.match(markdown, /goal status: active · tokens used 1070878 · no token budget reported · 45min elapsed/);
  assert.match(markdown, /> please finish stage C and test it/);
  assert.match(markdown, /`turn-2` failed at 2026-10-13T13:43:20\.000Z · 61s/);
  assert.match(markdown, /error: stream disconnected before completion \(other\)/);
  assert.match(markdown, /\*\*1 turn\(s\) failed\.\*\*/);
  assert.match(markdown, /\*\*1 approval request\(s\) are open\*\* — a person has to decide them; this bridge never answers one on its own:/);
  assert.match(markdown, /- `9000` item\/commandExecution\/requestApproval/);
  assert.match(markdown, /1 message\(s\) are queued and not yet consumed\./);
  assert.equal(facts.failures, 1);
  assert.equal(facts.approvals, 1);
  assert.equal(facts.queued, 1);
  assert.equal(facts.lastUserMessage, "please finish stage C and test it");
  assert.equal(facts.budgetLevel, "ok");
});

test("the brief names the files it saw and what it could not know", () => {
  const { markdown, facts } = buildHandoff(fixture());
  assert.match(markdown, /## What it already did/);
  assert.match(markdown, /- items read: 5 \(userMessage 1, reasoning 1, commandExecution 1, fileChange 1, agentMessage 1\)/);
  assert.match(markdown, /- files touched \(best effort, from recorded items\):/);
  assert.match(markdown, /  - `src\/stage-c\.js`/);
  assert.match(markdown, /Last things Codex said \(verbatim, truncated\):/);
  assert.match(markdown, /> stage C is half applied; the migration still needs a rollback/);
  assert.match(markdown, /## Quota at handoff/);
  assert.match(markdown, /- quota: ok · 12% of 300min · 9% weekly · 2 reset credits/);
  assert.match(markdown, /## What this brief cannot know/);
  assert.match(markdown, /- Only the newest 5 recorded item\(s\) of 2 turn\(s\) were read; older work is not represented here\./);
  assert.match(markdown, /- Codex's reasoning is encrypted; only its messages, commands and file changes are visible\./);
  assert.match(markdown, /- Nothing in this brief was paraphrased: every quoted line comes from Codex's own records\./);
  assert.match(markdown, /## Suggested next step/);
  assert.deepEqual(facts.filesTouched, ["src/stage-c.js"]);
});

test("a reached quota is quoted as reached, with the account's own reason", () => {
  const input = fixture();
  input.budget = budgetFromLimits({ error: "ordinaryUsageAllowed unavailable" });
  const { markdown } = buildHandoff(input);
  assert.match(markdown, /- quota: unknown \(the account read failed: ordinaryUsageAllowed unavailable\)/);
});

test("an empty thread still produces a brief that says what is missing", () => {
  const { markdown, facts } = buildHandoff({ now: 1791900000000 });
  assert.match(markdown, /- no goal is set on this thread; the newest user message below is the instruction\./);
  assert.match(markdown, /- no turns are recorded on this thread\./);
  assert.match(markdown, /- items read: 0 \(none\)/);
  assert.match(markdown, /- the account's quota was not read/);
  assert.equal(facts.budgetLevel, null);
  assert.equal(facts.failures, 0);
});

test("the same records always render the same brief", () => {
  const first = buildHandoff(fixture()).markdown;
  const second = buildHandoff(fixture()).markdown;
  assert.equal(first, second);
});

/**
 * @param handlers - method -> result or `(params) => result`.
 * @returns an EventEmitter client that records traffic.
 */
function stubClient(handlers = {}) {
  const client = new EventEmitter();
  client.setMaxListeners(0);
  client.calls = [];
  client.pending = [];
  client.call = async (method, params = {}) => {
    client.calls.push([method, params]);
    const handler = handlers[method];
    if (typeof handler === "function") return handler(params);
    if (handler !== undefined) return handler;
    throw new Error(`no stub for ${method}`);
  };
  client.pendingServerRequests = () => client.pending;
  return client;
}

const THREADS = { data: [{ id: "T1", title: "stage work", cwd: "/work/thing", preview: "hi", updatedAt: 1791900000 }] };

test("collectHandoff reads the thread, its turns, its goal and the account", async () => {
  const client = stubClient({
    "thread/list": THREADS,
    "thread/read": { thread: { id: "T1", name: "stage work", cwd: "/work/thing", path: "/r.jsonl", gitInfo: { branch: "main", sha: "abc" }, status: { type: "notLoaded" } } },
    "thread/turns/list": { data: [{ id: "turn-9", status: "failed", startedAt: 1791899000, completedAt: null, durationMs: 1000, error: { message: "boom", codexErrorInfo: "other" }, items: [] }] },
    "thread/items/list": { data: [{ turnId: "turn-9", item: { id: "i1", type: "userMessage", text: "do the thing" } }, { turnId: "turn-9", item: { id: "i2", type: "fileChange", changes: [{ path: "src/a.js" }] } }] },
    "thread/goal/get": { goal: { threadId: "T1", objective: "finish it", status: "active", tokensUsed: 10, tokenBudget: null, timeUsedSeconds: 5 } },
    "thread/queue/list": { data: [], nextCursor: null },
    "account/rateLimits/read": { rateLimits: { limitId: "codex", planType: "plus", primary: { usedPercent: 12, windowDurationMins: 300 }, secondary: null }, ordinaryUsageAllowed: true, rateLimitResetCredits: { availableCount: 1, credits: [] } },
  });
  const result = await collectHandoff(client, { cwd: "/work/thing" });
  assert.equal(result.ok, true);
  assert.equal(result.threadId, "T1");
  assert.match(result.markdown, /- goal \(verbatim\): finish it/);
  assert.match(result.markdown, /`turn-9` failed/);
  assert.match(result.markdown, /> do the thing/);
  assert.deepEqual(result.facts.filesTouched, ["src/a.js"]);
  assert.equal(result.budget.level, "ok");
  // The thread was resolved from the working directory, and the brief carries the
  // rollout path and git state read from thread/read.
  assert.match(result.markdown, /rollout: `\/r\.jsonl`/);
  assert.match(result.markdown, /git: main @ abc/);
});

test("collectHandoff survives every read but the thread list failing", async () => {
  const client = stubClient({ "thread/list": THREADS });
  const result = await collectHandoff(client, { cwd: "/work/thing" });
  assert.equal(result.ok, true);
  assert.match(result.markdown, /- no goal is set on this thread/);
  assert.match(result.markdown, /- no turns are recorded on this thread\./);
  assert.match(result.markdown, /- quota: unknown \(the account read failed/);
});

test("collectHandoff refuses when no thread can be resolved, rather than inventing one", async () => {
  const client = stubClient({ "thread/list": { data: [] } });
  const result = await collectHandoff(client, { cwd: "/nowhere" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no thread could be resolved/);
  assert.equal(result.markdown, "");
});

test("the tool writes the brief where it was told to, and reports the path", async () => {
  const client = stubClient({
    "thread/list": THREADS,
    "thread/turns/list": { data: [] },
    "thread/items/list": { data: [] },
    "thread/goal/get": { goal: null },
    "thread/queue/list": { data: [] },
    "account/rateLimits/read": { rateLimits: { limitId: "codex", primary: { usedPercent: 1, windowDurationMins: 300 } }, ordinaryUsageAllowed: true },
  });
  const bridge = { config: {}, withClient: async (fn) => fn(client), connection: async () => client };
  const dir = mkdtempSync(join(tmpdir(), "dcb-handoff-"));
  const value = await handoffTool(bridge, {}).execute({ threadId: "T1", saveTo: join(dir, "brief.md") });
  assert.equal(value.ok, true);
  assert.equal(value.savedTo, join(dir, "brief.md"));
  assert.match(readFileSync(value.savedTo, "utf8"), /# Codex handoff/);
  assert.equal(value.title, "stage work");
  assert.equal(value.budgetLevel, "ok");
});
