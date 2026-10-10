/**
 * Tool-level tests: each tool's execute() against a stub app-server client.
 *
 * These are what catch a tool that stopped matching its own output schema, or a
 * fallback that quietly disappeared.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { allTools, TOOL_NAMES } from "../src/tools/index.js";
import { ACTIVE_WRITER_HINT } from "../src/errors.js";

const THREADS = [{
  id: "T1",
  title: "project work",
  preview: "busy",
  cwd: "/repo",
  model: "gpt-6-luna",
  reasoningEffort: "high",
  status: { type: "notLoaded" },
  updatedAt: 1791600000,
  path: "/tmp/T1.jsonl",
}];

const ITEMS = {
  data: [
    { turnId: "turn-1", item: { type: "agentMessage", id: "i2", content: [{ text: "done" }] } },
    { turnId: "turn-1", item: { type: "commandExecution", id: "i1", command: "ls", status: "completed", aggregatedOutput: "ok" } },
  ],
  nextCursor: null,
};

/**
 * @param handlers - method -> result or `(params) => result`.
 * @returns an EventEmitter client with a `call` that records traffic.
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
  client.respond = (id, payload) => {
    client.pending = client.pending.filter((request) => request.id !== id);
    client.responded.push({ id, payload });
  };
  client.responded = [];
  return client;
}

/** @param client - the stub client. @returns a bridge bound to it. */
function stubBridge(client) {
  return { config: {}, connection: async () => client, withClient: async (fn) => fn(client) };
}

/** @param name - tool name. @param client - stub client. @returns the tool definition. */
function toolFor(name, client) {
  const tools = allTools(stubBridge(client), { timeoutMs: 500 });
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `tool ${name} should exist`);
  return tool;
}

test("allTools exposes exactly TOOL_NAMES", () => {
  const tools = allTools(stubBridge(stubClient()), {});
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
});

test("codex_status reports account, plan and the budget line", async () => {
  const client = stubClient({
    "account/read": { account: { type: "chatgpt", email: "fake@example.com", planType: "plus" } },
    "account/rateLimits/read": {
      ordinaryUsageAllowed: true,
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1 },
        secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 2 },
      },
      rateLimitResetCredits: { availableCount: 2 },
    },
    "thread/list": { data: THREADS },
  });
  const value = await toolFor("codex_status", client).execute({});
  assert.equal(value.account, "fake@example.com");
  assert.equal(value.plan, "plus");
  assert.equal(value.budget, "42% of 300min window, 8% weekly · 2 reset credits");
  assert.match(value.latestThread, /^T1 \(notLoaded, /);
  assert.equal(value.pendingApprovals, 0);
  assert.ok(Array.isArray(value.processes));
  assert.deepEqual(value.log, []);
});

test("codex_status degrades instead of throwing when the connection fails", async () => {
  const bad = {
    config: {},
    connection: async () => { throw new Error("spawn failed"); },
    withClient: async () => { throw new Error("spawn failed"); },
  };
  const tool = allTools(bad, {}).find((entry) => entry.name === "codex_status");
  const value = await tool.execute({});
  assert.equal(value.account, "unknown");
  assert.equal(value.budget, "unavailable");
  assert.equal(value.latestThread, "none");
  assert.deepEqual(value.log, ["bridge error: spawn failed"]);
});

test("codex_threads maps threads and filters by search", async () => {
  const tool = toolFor("codex_threads", stubClient({ "thread/list": { data: THREADS } }));
  const all = await tool.execute({});
  assert.equal(all.count, 1);
  assert.equal(all.threads[0].id, "T1");
  assert.equal(all.threads[0].status, "notLoaded");

  const hit = await tool.execute({ search: "PROJECT" });
  assert.equal(hit.count, 1);
  const miss = await tool.execute({ search: "nope" });
  assert.equal(miss.count, 0);
});

test("codex_transcript defaults to desc and caps each item", async () => {
  const client = stubClient({ "thread/items/list": ITEMS });
  const tool = toolFor("codex_transcript", client);
  const value = await tool.execute({ threadId: "T1", limit: 5, maxCharsPerItem: 100 });
  assert.equal(value.threadId, "T1");
  assert.equal(value.count, 2);
  assert.equal(value.entries[0].itemId, "i2");
  assert.deepEqual(client.calls[0], ["thread/items/list", { threadId: "T1", limit: 5, sortDirection: "desc" }]);
});

test("codex_watch merges live stream events with transcript polls", async () => {
  const client = stubClient({ "thread/items/list": { data: [ITEMS.data[0]], nextCursor: null } });
  const tool = toolFor("codex_watch", client);
  const pending = tool.execute({ threadId: "T1", seconds: 1, maxEvents: 20 });
  setTimeout(() => {
    client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "T1", delta: "live text" } });
    client.emit("notification", { method: "turn/started", params: {} });
    client.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "OTHER" } });
  }, 150);
  const value = await pending;
  assert.equal(value.threadId, "T1");
  assert.ok(value.watchedMs >= 1000);
  const methods = value.events.map((event) => event.method);
  assert.ok(methods.includes("item/agentMessage/delta"), methods.join(","));
  assert.ok(methods.includes("turn/started"), methods.join(","));
  // A notification for another thread must not leak in.
  assert.ok(!methods.includes("thread/tokenUsage/updated"), methods.join(","));
  const delta = value.events.find((event) => event.method === "item/agentMessage/delta");
  assert.equal(delta.text, "live text");
  assert.equal(delta.source, "stream");
  // The listener must not survive the call.
  assert.equal(client.listenerCount("notification"), 0);
});

test("codex_watch reports a poll failure as an error event instead of throwing", async () => {
  // The seed read is allowed to succeed; it is the in-loop poll that must degrade.
  let reads = 0;
  const client = stubClient({
    "thread/items/list": () => {
      reads += 1;
      if (reads === 1) return { data: [], nextCursor: null };
      throw new Error("poll exploded");
    },
  });
  const tool = toolFor("codex_watch", client);
  const value = await tool.execute({ threadId: "T1", seconds: 1 });
  const error = value.events.find((event) => event.source === "error");
  assert.ok(error, JSON.stringify(value));
  assert.equal(error.text, "poll exploded");
});

test("codex_send queues by default", async () => {
  // Shape copied from a live app-server reply: there is no queue-order field.
  const client = stubClient({ "thread/queue/add": { queuedSubmission: { id: "01a12470-c8b0-7992-b011-dc8fabef74f2" } } });
  const value = await toolFor("codex_send", client).execute({ message: "hi", threadId: "T1" });
  assert.equal(value.mode, "queue");
  assert.equal(value.accepted, true);
  assert.match(value.detail, /queued as 01a12470-c8b0-7992-b011-dc8fabef74f2/);
  assert.equal(client.calls[0][1].input[0].text, "hi");
  assert.ok(client.calls[0][1].clientUserMessageId, "queueing needs a client message id");
});

test("codex_send stays honest when the reply carries no submission id", async () => {
  const client = stubClient({ "thread/queue/add": {} });
  const value = await toolFor("codex_send", client).execute({ message: "hi", threadId: "T1" });
  assert.equal(value.detail, "queued; the running Codex session will consume it");
  assert.ok(!value.detail.includes("?"), "must not invent a field the protocol does not send");
});

test("codex_send mode=turn falls back to the queue when another process holds the lock", async () => {
  const client = stubClient({
    "thread/resume": () => { throw new Error("thread T1 already has an active writer"); },
    "thread/queue/add": { queuedSubmission: { id: "q-sub-7" } },
  });
  const value = await toolFor("codex_send", client).execute({ message: "hi", threadId: "T1", mode: "turn" });
  assert.equal(value.accepted, true);
  assert.equal(value.mode, "queue");
  assert.match(value.detail, /mode=turn unavailable/);
  assert.ok(value.detail.includes(ACTIVE_WRITER_HINT));
  assert.match(value.detail, /Fell back to the queue — queued as q-sub-7/);
});

test("codex_send mode=turn still starts a turn when the lock is free", async () => {
  const client = stubClient({
    "thread/resume": { thread: { id: "T1" } },
    "turn/start": { turn: { id: "turn-99" } },
  });
  const value = await toolFor("codex_send", client).execute({ message: "hi", threadId: "T1", mode: "turn" });
  assert.equal(value.mode, "turn");
  assert.equal(value.detail, "turn turn-99");
});

test("codex_send mode=steer reports rejected (not thrown) under the lock", async () => {
  const client = stubClient({
    "turn/steer": () => { throw new Error("thread T1 already has an active writer"); },
  });
  const value = await toolFor("codex_send", client).execute({
    message: "hi", threadId: "T1", mode: "steer", turnId: "turn-1",
  });
  assert.equal(value.accepted, false);
  assert.equal(value.detail, ACTIVE_WRITER_HINT);
});

test("codex_send mode=steer requires a turnId", async () => {
  const client = stubClient({});
  await assert.rejects(
    () => toolFor("codex_send", client).execute({ message: "hi", threadId: "T1", mode: "steer" }),
    /mode=steer requires turnId/,
  );
});

test("codex_approvals lists the queue", async () => {
  const client = stubClient({});
  client.pending = [{
    id: 9001,
    method: "item/commandExecution/requestApproval",
    params: { command: ["rm", "-rf", "/tmp/x"], threadId: "T1" },
    receivedAt: Date.now() - 12,
  }];
  const value = await toolFor("codex_approvals", client).execute({});
  assert.equal(value.action, "list");
  assert.equal(value.answered, 0);
  assert.equal(value.pending.length, 1);
  assert.equal(value.pending[0].id, "9001");
  assert.equal(value.pending[0].summary, "run: rm -rf /tmp/x");
  assert.ok(value.pending[0].ageMs >= 12);
});

test("codex_approvals answers one request, and every request when no id is given", async () => {
  const client = stubClient({});
  client.pending = [
    { id: 1, method: "item/commandExecution/requestApproval", params: { command: "ls" }, receivedAt: Date.now() },
    { id: 2, method: "applyPatchApproval", params: {}, receivedAt: Date.now() },
  ];
  const one = await toolFor("codex_approvals", client).execute({ action: "accept", requestId: "1" });
  assert.equal(one.answered, 1);
  assert.equal(one.pending.length, 1);
  assert.deepEqual(client.responded[0], { id: 1, payload: { result: { decision: "accept" } } });

  const rest = await toolFor("codex_approvals", client).execute({ action: "decline", reason: "not now" });
  assert.equal(rest.answered, 1);
  assert.deepEqual(client.responded[1], { id: 2, payload: { result: { decision: "decline", reason: "not now" } } });

  const none = await toolFor("codex_approvals", client).execute({ action: "accept" });
  assert.equal(none.answered, 0);
  assert.equal(none.note, "nothing pending to answer");
});

test("codex_approvals answers a currentTime/read with a clock, not a decision", async () => {
  const client = stubClient({});
  client.pending = [{ id: 7, method: "currentTime/read", params: {}, receivedAt: Date.now() }];
  await toolFor("codex_approvals", client).execute({ action: "accept", requestId: "7" });
  assert.equal(typeof client.responded[0].payload.result.unixMs, "number");
});

test("every tool renders its own output without throwing", async () => {
  const client = stubClient({
    "account/read": { account: { type: "chatgpt", email: "e", planType: "plus" } },
    "account/rateLimits/read": { rateLimits: { primary: {}, secondary: {} } },
    "thread/list": { data: THREADS },
    "thread/items/list": ITEMS,
    "thread/queue/add": { queuedSubmission: { id: "q", queueOrder: 1 } },
  });
  for (const tool of allTools(stubBridge(client), {})) {
    const args = tool.name === "codex_send"
      ? { message: "hi", threadId: "T1" }
      : (tool.name === "codex_watch" ? { threadId: "T1", seconds: 1 } : { threadId: "T1" });
    const value = await tool.execute(args);
    const blocks = tool.output.render(args, value);
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${tool.name} rendered nothing`);
    assert.equal(blocks[0].type, "text");
    assert.equal(typeof blocks[0].text, "string");
  }
});
