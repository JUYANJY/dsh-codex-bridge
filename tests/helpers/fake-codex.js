#!/usr/bin/env node
/**
 * A fake `codex app-server`, used by the test suite.
 *
 * It speaks the real wire format — JSONL JSON-RPC on stdin/stdout — so the tests
 * exercise the actual plumbing (handshake, id correlation, notification fan-out,
 * inbound server-request capture) rather than a stub of it.
 *
 * Environment switches:
 *   FAKE_CODEX_LOCK=1   refuse `thread/resume` and `turn/steer` with the
 *                       "already has an active writer" error the desktop app causes.
 *   FAKE_CODEX_SILENT=1 do not push notifications or a server request on `initialized`.
 *
 * @module dsh-codex-bridge/tests/helpers/fake-codex
 */

const LOCKED = process.env.FAKE_CODEX_LOCK === "1";
const SILENT = process.env.FAKE_CODEX_SILENT === "1";

const THREADS = [
  {
    id: "T1",
    title: "alpha work",
    preview: "working on   alpha\nproject",
    cwd: "/alpha",
    model: "gpt-6-luna",
    reasoningEffort: "high",
    status: { type: "notLoaded" },
    updatedAt: 1791600000,
    path: "/tmp/T1.jsonl",
  },
  {
    id: "T2",
    title: "beta work",
    preview: "beta",
    cwd: "/beta",
    model: "gpt-6-sol",
    reasoningEffort: "medium",
    status: { type: "idle" },
    updatedAt: 1791500000,
    path: "/tmp/T2.jsonl",
  },
];

const ITEMS = [
  { turnId: "turn-1", item: { type: "userMessage", id: "i1", content: [{ type: "text", text: "please do the thing" }] } },
  { turnId: "turn-1", item: { type: "reasoning", id: "i2", summary: ["**Planning the thing**"], content: [] } },
  { turnId: "turn-1", item: { type: "commandExecution", id: "i3", command: "ls -la", status: "completed", aggregatedOutput: "total 0" } },
  { turnId: "turn-1", item: { type: "fileChange", id: "i4", changes: [{ path: "a.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@" }] } },
  { turnId: "turn-1", item: { type: "agentMessage", id: "i5", content: [{ type: "text", text: "done" }] } },
];

/** @param value - any JSON-frame payload. */
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** @param id - request id. @param result - success payload. */
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

/** @param id - request id. @param message - error text. @param code - JSON-RPC code. */
function fail(id, message, code = -32600) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const ACTIVE_WRITER = (threadId) => `thread ${threadId} already has an active writer`;

/**
 * Push the frames a freshly initialized client should see.
 * @param client - the client-side id counter.
 */
function onInitialized(client) {
  if (SILENT) return;
  send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "T1", delta: "hello " } });
  send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "T1" } });
  send({ jsonrpc: "2.0", method: "account/rateLimits/updated", params: { threadId: "T1" } });
  send({
    jsonrpc: "2.0",
    id: client.nextServerId++,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "T1", turnId: "turn-1", itemId: "i3", command: ["rm", "-rf", "/tmp/x"] },
  });
}

const client = { nextServerId: 9000 };

/**
 * Handle one decoded frame.
 * @param message - a parsed JSON-RPC frame.
 */
function handle(message) {
  if (message.id !== undefined && message.method !== undefined) {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        reply(message.id, {
          userAgent: "fake-codex/0.0.1 (Test OS) test",
          codexHome: "/tmp/fake-codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        });
        return;
      case "thread/list": {
        const data = params.cwd ? THREADS.filter((thread) => thread.cwd === params.cwd) : THREADS;
        reply(message.id, { data: data.slice(0, params.limit ?? data.length) });
        return;
      }
      case "thread/items/list":
        reply(message.id, { data: ITEMS, nextCursor: null, backwardsCursor: null });
        return;
      case "account/read":
        reply(message.id, {
          account: { type: "chatgpt", email: "fake@example.com", planType: "plus" },
          requiresOpenaiAuth: true,
        });
        return;
      case "account/rateLimits/read":
        reply(message.id, {
          ordinaryUsageAllowed: true,
          rateLimits: {
            planType: "plus",
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1791626383 },
            secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1792051594 },
          },
          rateLimitResetCredits: { availableCount: 2 },
        });
        return;
      case "thread/queue/add":
        reply(message.id, {
          queuedSubmission: { id: "q-1", threadId: params.threadId, queueOrder: 1 },
        });
        return;
      case "thread/queue/list":
        reply(message.id, { data: [], nextCursor: null });
        return;
      case "thread/resume":
        if (LOCKED) fail(message.id, ACTIVE_WRITER(params.threadId));
        else reply(message.id, { thread: { id: params.threadId } });
        return;
      case "turn/steer":
        if (LOCKED) fail(message.id, ACTIVE_WRITER(params.threadId));
        else reply(message.id, {});
        return;
      case "turn/start":
        reply(message.id, { turn: { id: "turn-99" } });
        return;
      case "fake/hang":
        return ; // never answers: exercises the timeout path
      default:
        fail(message.id, `unknown method ${message.method}`, -32601);
    }
    return;
  }

  if (message.method === "initialized") {
    onInitialized(client);
    return;
  }

  // A client response to an inbound server request: echo it back so a test can observe it.
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", method: "fake/resolved", params: { id: message.id, result: message.result ?? null } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`fake-codex: bad frame: ${String(error)}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
