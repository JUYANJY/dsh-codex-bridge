/**
 * `codex_ask` decides two things the panel and the docs promise: it will not
 * pretend the strong model ran, and whatever it hands back to Codex is the
 * answer byte-for-byte.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { askTool } from "../src/tools/ask.js";

/**
 * @param handlers - method -> result or `(params) => result`.
 * @param onCall - optional hook called after each recorded call.
 * @returns an EventEmitter client that records traffic.
 */
function stubClient(handlers = {}, onCall = null) {
  const client = new EventEmitter();
  client.setMaxListeners(0);
  client.calls = [];
  client.call = async (method, params = {}) => {
    client.calls.push([method, params]);
    const handler = handlers[method];
    const value = typeof handler === "function" ? await handler(params) : handler;
    if (value === undefined && handler === undefined) throw new Error(`no stub for ${method}`);
    onCall?.(client, method, params);
    return value;
  };
  client.pendingServerRequests = () => [];
  return client;
}

/** @param client - the stub client. @returns a bridge bound to it. */
function stubBridge(client) {
  return { config: {}, withClient: async (fn) => fn(client), connection: async () => client };
}

/** @param client - the stub client. @param text - the answer to emit. @returns a tool. */
function askWith(client, options = {}) {
  return askTool(stubBridge(client), { pollMs: 10, answerTimeoutMs: 500, ...options });
}

/** A client whose throwaway thread answers over the notification stream. */
function answeringClient({ model = "gpt-6-astra", text = "Stage C first, then the tests.", onTurnStart = null } = {}) {
  return stubClient({
    "thread/start": { thread: { id: "T-ASK" }, model },
    "turn/start": (params) => {
      onTurnStart?.(params);
      return { turn: { id: "turn-1" } };
    },
    "thread/list": { data: [{ id: "T-DEV", cwd: "/work", updatedAt: 1791900000 }] },
    "thread/queue/add": { queuedSubmission: { id: "q-99" } },
  }, (client, method) => {
    if (method === "turn/start") {
      client.emit("notification", { method: "item/completed", params: { threadId: "T-ASK", item: { type: "agentMessage", text } } });
    }
  });
}

test("an honoured override, a notification answer, and a verbatim hand-back", async () => {
  const client = answeringClient();
  const value = await askWith(client).execute({ question: "what next?", model: "gpt-6-astra", feedThreadId: "T-DEV" });
  assert.equal(value.ok, true);
  assert.equal(value.reply, "Stage C first, then the tests.");
  assert.equal(value.replyChars, "Stage C first, then the tests.".length);
  assert.equal(value.requestedModel, "gpt-6-astra");
  assert.equal(value.modelReported, "gpt-6-astra");
  assert.equal(value.overrideHonoured, true);
  assert.equal(value.answerSource, "notification:item/completed");
  assert.equal(value.effort, "max");
  assert.equal(value.fed, true);
  assert.equal(value.fedThreadId, "T-DEV");
  assert.equal(value.fedSubmissionId, "q-99");

  const add = client.calls.find(([method]) => method === "thread/queue/add");
  assert.deepEqual(add[1].threadId, "T-DEV");
  // Byte-for-byte: no provenance, no prefix, no paraphrase.
  assert.equal(add[1].input[0].text, value.reply);
  // The question thread is throwaway, and the question is what was asked.
  const start = client.calls.find(([method]) => method === "thread/start");
  assert.equal(start[1].ephemeral, true);
  const turn = client.calls.find(([method]) => method === "turn/start");
  assert.equal(turn[1].input[0].text, "what next?");
  assert.equal(turn[1].effort, "max");
});

test("an unhonoured model override fails the call and asks nothing of Codex", async () => {
  const client = stubClient({
    "thread/start": { thread: { id: "T-ASK" }, model: "gpt-5" },
    "turn/start": { turn: { id: "turn-1" } },
  });
  const value = await askWith(client).execute({ question: "what next?", model: "gpt-6-astra" });
  assert.equal(value.ok, false);
  assert.match(value.reason, /honoured model gpt-5, not the requested gpt-6-astra/);
  assert.equal(value.overrideHonoured, false);
  assert.equal(value.modelReported, "gpt-5");
  assert.equal(client.calls.some(([method]) => method === "turn/start"), false);
  assert.match(value.detail, /allowOverride:true/);
});

test("allowOverride asks anyway and still reports which model ran", async () => {
  const client = stubClient({
    "thread/start": { thread: { id: "T-ASK" }, model: "gpt-5" },
    "turn/start": () => {
      client.emit("notification", { method: "item/completed", params: { threadId: "T-ASK", item: { type: "agentMessage", text: "ok" } } });
      return { turn: { id: "turn-1" } };
    },
  });
  const value = await askWith(client).execute({ question: "go", model: "gpt-6-astra", allowOverride: true, feed: false });
  assert.equal(value.ok, true);
  assert.equal(value.modelReported, "gpt-5");
  assert.equal(value.overrideHonoured, false);
  assert.equal(value.fed, false);
  assert.match(value.feedDetail, /feed:false/);
});

test("a silent notification stream is covered by the turn poll", async () => {
  const client = stubClient({
    "thread/start": { thread: { id: "T-ASK" }, model: "gpt-6-astra" },
    "turn/start": { turn: { id: "turn-1" } },
    // A non-ephemeral thread: the poll is allowed to read its recorded turns.
    "thread/read": { thread: { id: "T-ASK", ephemeral: false, status: { type: "idle" } } },
    "thread/turns/list": { data: [{ id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "final words", phase: "final_answer" }, { type: "agentMessage", text: "interim", phase: "commentary" }] }] },
  });
  const value = await askWith(client).execute({ question: "what next?", feed: false });
  assert.equal(value.ok, true);
  assert.equal(value.answerSource, "poll:thread/turns/list");
  assert.equal(value.reply, "final words");
});

test("a throwaway thread that errors reports the provider's own words", async () => {
  const client = stubClient({
    "thread/start": { thread: { id: "T-ASK" }, model: "gpt-6-astra" },
    "turn/start": () => {
      // Measured against the live server: the cause arrives as both an `error`
      // notification and turn/completed.turn.error.
      client.emit("notification", { method: "error", params: { threadId: "T-ASK", error: { message: "Unsupported value: 'minimal' is not supported with the 'gpt-6-astra' model." } } });
      client.emit("notification", { method: "thread/status/changed", params: { threadId: "T-ASK", status: { type: "systemError" } } });
      client.emit("notification", { method: "turn/completed", params: { threadId: "T-ASK", turn: { id: "turn-1", status: "failed", items: [], error: { message: "Unsupported value: 'minimal' is not supported with the 'gpt-6-astra' model." } } } });
      return { turn: { id: "turn-1" } };
    },
    "thread/read": { thread: { id: "T-ASK", ephemeral: true, status: { type: "systemError" } } },
  });
  const value = await askWith(client).execute({ question: "what next?", feed: false });
  assert.equal(value.ok, false);
  assert.match(value.reason, /the turn failed: Unsupported value/);
  assert.match(value.detail, /server error: Unsupported value/);
  assert.match(value.detail, /thread status: systemError/);
  assert.match(value.detail, /notifications: .*turn\/completed/);
});

test("a failed turn ends the wait with the server's own error text", async () => {
  const client = stubClient({
    "thread/start": { thread: { id: "T-ASK" }, model: "gpt-6-astra" },
    "turn/start": () => {
      client.emit("notification", { method: "turn/failed", params: { threadId: "T-ASK", error: { message: "stream disconnected before completion" } } });
      return { turn: { id: "turn-1" } };
    },
  });
  const value = await askWith(client).execute({ question: "what next?", feed: false });
  assert.equal(value.ok, false);
  assert.match(value.reason, /stream disconnected before completion/);
  assert.equal(value.answerSource, "notification:turn/failed");
});

test("a timeout is reported as a timeout, not as an empty answer", async () => {
  const client = stubClient({
    "thread/start": { thread: { id: "T-ASK" }, model: "gpt-6-astra" },
    "turn/start": { turn: { id: "turn-1" } },
    "thread/turns/list": { data: [{ id: "turn-1", status: "inProgress", items: [] }] },
  });
  const value = await askWith(client).execute({ question: "what next?", feed: false, timeoutMs: 60 });
  assert.equal(value.ok, false);
  assert.equal(value.answerSource, "timeout");
  assert.match(value.reason, /no answer within 60ms/);
  assert.equal(value.reply, "");
});

test("an answer that cannot be placed is not fed anywhere", async () => {
  const client = stubClient({
    "thread/start": { thread: { id: "T-ASK" }, model: "gpt-6-astra" },
    "turn/start": () => {
      client.emit("notification", { method: "item/completed", params: { threadId: "T-ASK", item: { type: "agentMessage", text: "do X" } } });
      return { turn: { id: "turn-1" } };
    },
    "thread/list": { data: [] },
  });
  const value = await askWith(client).execute({ question: "what next?" });
  assert.equal(value.ok, true);
  assert.equal(value.fed, false);
  assert.match(value.feedDetail, /no development thread could be resolved/);
  assert.equal(client.calls.some(([method]) => method === "thread/queue/add"), false);
});

test("a missing question never reaches the wire", async () => {
  const client = answeringClient();
  const value = await askWith(client).execute({ question: "   " });
  assert.equal(value.ok, false);
  assert.match(value.reason, /no question was given/);
  assert.deepEqual(client.calls, []);
});

test("a thread/start failure is reported with the server's message", async () => {
  const client = stubClient({ "thread/start": () => { throw new Error("invalid params: ephemeral"); } });
  const value = await askWith(client).execute({ question: "what next?" });
  assert.equal(value.ok, false);
  assert.match(value.reason, /thread\/start failed: invalid params: ephemeral/);
  assert.equal(value.threadId, "");
});
