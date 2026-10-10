/**
 * Board tests: the read-only projection, the honest column rules, and the
 * host-side route the panel polls.
 *
 * The panel only displays what these functions decide, so "what the board claims
 * is true" is asserted here, against plain values. What the panel then does with
 * those values is asserted in `tests/client.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BOARD_COLUMNS, buildBoard, collectBoard, observeTurnState } from "../src/board.js";
import { RPC_ROUTE, createRouteHandler, mountBoardChannel } from "../src/board-channel.js";

/**
 * @param handlers - method -> result or `(params) => result`; a throwing handler
 *   simulates a protocol failure.
 * @returns a stub client with `call`, `pendingServerRequests` and a call log.
 */
function stubClient(handlers = {}) {
  const client = {
    calls: [],
    pendingRequests: [],
    async call(method, params = {}) {
      client.calls.push([method, params]);
      const handler = handlers[method];
      if (typeof handler !== "function") throw new Error(`no stub for ${method}`);
      return handler(params);
    },
    pendingServerRequests() {
      return client.pendingRequests;
    },
  };
  return client;
}

const THREAD = (id, seconds) => ({ id, title: `thread ${id}`, preview: `preview ${id}`, cwd: "/repo", updatedAt: seconds });

test("the last column refuses to call silence idle", () => {
  const last = BOARD_COLUMNS.at(-1);
  assert.equal(last.id, "unobserved");
  assert.match(last.label, /no observed activity/i);
  assert.match(last.hint, /not proof of idleness/i);
  for (const column of BOARD_COLUMNS) assert.doesNotMatch(column.label, /idle/i);
});

test("a thread waiting on approval is never hidden behind its queue", () => {
  const board = buildBoard({
    now: 1_000_000,
    threads: [{ id: "T1", title: "t", preview: "p", cwd: "/repo", updatedAt: new Date(999_000).toISOString() }],
    queues: { T1: [{ id: "q1" }] },
    approvals: [{ id: 9, method: "item/commandExecution/requestApproval", threadId: "T1" }],
  });
  const [waiting, running, queued] = board.columns;
  assert.equal(waiting.cards.length, 1);
  assert.equal(waiting.cards[0].threadId, "T1");
  assert.equal(waiting.cards[0].waitingCount, 1);
  assert.equal(waiting.cards[0].queuedCount, 1);
  assert.equal(running.cards.length, 0);
  assert.equal(queued.cards.length, 0, "a queued card must not also appear under Queued");
  assert.deepEqual(board.totals, { threads: 1, waiting: 1, running: 0, queued: 0, unobserved: 0, queuedMessages: 1 });
});

test("a turn counts as running only while this connection has not seen it finish", () => {
  const board = buildBoard({
    now: 1_000_000,
    threads: [THREAD("T1", 999), THREAD("T2", 998)],
    turns: new Map([["T1", { at: 500_000, turnId: "turn-1" }]]),
  });
  assert.deepEqual(board.columns.find((column) => column.id === "running").cards.map((card) => card.threadId), ["T1"]);
  assert.deepEqual(board.columns.find((column) => column.id === "unobserved").cards.map((card) => card.threadId), ["T2"]);
});

test("observeTurnState folds started against finished, in order", () => {
  const started = (at, threadId) => ({ at, method: "turn/started", params: { threadId } });
  const finished = (at, threadId) => ({ at, method: "turn/completed", params: { threadId } });

  assert.equal(observeTurnState([started(1, "T1"), finished(2, "T1")]).size, 0);
  assert.equal(observeTurnState([started(1, "T1"), finished(2, "T1"), started(3, "T1")]).get("T1").at, 3);
  assert.equal(observeTurnState([finished(2, "T1")]).size, 0, "a finish with no start must not invent a turn");
  assert.equal(observeTurnState([started(1, "T1"), { at: 5, method: "turn/started", params: {} }]).size, 1);
  assert.equal(observeTurnState([{ at: 1, method: "item/agentMessage/delta", params: { threadId: "T1" } }]).size, 0);
  assert.equal(observeTurnState([]).size, 0);
});

test("an approval on a thread that is not listed is reported, not dropped", () => {
  const board = buildBoard({
    now: 1_000_000,
    threads: [THREAD("T1", 999)],
    approvals: [{ id: 4, method: "x", threadId: "T9" }, { id: 5, method: "y", threadId: null }],
  });
  assert.equal(board.unattachedApprovals.length, 2);
  assert.equal(board.totals.waiting, 0);
  assert.equal(board.columns.find((column) => column.id === "unobserved").cards.length, 1);
});

test("buildBoard answers an empty world with four empty columns", () => {
  const board = buildBoard();
  assert.equal(board.columns.length, 4);
  for (const column of board.columns) assert.deepEqual(column.cards, []);
  assert.equal(board.totals.threads, 0);
  assert.match(board.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("collectBoard says which threads it did not probe", async () => {
  const client = stubClient({
    "thread/list": () => ({
      data: [
        { id: "T1", preview: "a", updatedAt: 1000 },
        { id: "T2", preview: "b", updatedAt: 900 },
        { id: "T3", preview: "c", updatedAt: 800 },
      ],
    }),
    "thread/queue/list": (params) => ({ data: params.threadId === "T1" ? [{ id: "q1" }] : [] }),
    "thread/items/list": () => ({ data: [] }),
    "account/read": () => ({ account: { email: "someone@example.com" } }),
    "account/rateLimits/read": () => ({ rateLimits: { planType: "plus", primary: { usedPercent: 12, windowDurationMins: 300 } } }),
  });

  const partial = await collectBoard(client, { recentNotifications: [] }, { maxThreads: 3, maxQueueProbes: 1 });
  assert.deepEqual(partial.probe.queueProbed, ["T1"]);
  assert.deepEqual(partial.probe.queueUnprobedThreadIds, ["T2", "T3"]);
  assert.equal(partial.probe.queueCoverageComplete, false);
  assert.equal(partial.account.email, "someone@example.com");
  assert.equal(partial.columns.find((column) => column.id === "queued").cards.length, 1);

  const full = await collectBoard(client, { recentNotifications: [] }, { maxThreads: 3, maxQueueProbes: 3 });
  assert.equal(full.probe.queueCoverageComplete, true);
  assert.equal(full.probe.queueProbeErrors.length, 0);
});

test("a failed queue probe is reported instead of silently counted as zero", async () => {
  const client = stubClient({
    "thread/list": () => ({ data: [{ id: "T1", preview: "a", updatedAt: 1000 }] }),
    "thread/queue/list": () => { throw new Error("thread/queue/list is not available"); },
    "thread/items/list": () => ({ data: [] }),
  });
  const board = await collectBoard(client, { recentNotifications: [] }, { maxThreads: 1, maxQueueProbes: 1, includeAccount: false });
  assert.equal(board.probe.queueCoverageComplete, false);
  assert.equal(board.probe.queueProbeErrors.length, 1);
  assert.match(board.probe.queueProbeErrors[0].message, /not available/);
  assert.equal(board.account, null);
});

/** One `thread/items/list` entry, shaped like the real reply. */
function itemEntry(item) {
  return { turnId: "turn-1", itemId: item.id, item };
}

test("a card's last line is the newest item that is not encrypted reasoning", async () => {
  const client = stubClient({
    "thread/list": () => ({ data: [{ id: "T1", preview: "a", updatedAt: 1000 }, { id: "T2", preview: "b", updatedAt: 900 }] }),
    "thread/queue/list": () => ({ data: [] }),
    "thread/items/list": (params) => ({
      data: params.threadId === "T1"
        ? [
          itemEntry({ id: "r1", type: "reasoning", summary: [] }),
          itemEntry({ id: "c1", type: "commandExecution", command: "ls -la", status: "inProgress" }),
        ]
        : [],
    }),
  });

  const board = await collectBoard(client, { recentNotifications: [] }, { maxThreads: 2, maxItemProbes: 1, includeAccount: false });
  const card = board.columns.find((column) => column.id === "unobserved").cards.find((entry) => entry.threadId === "T1");
  assert.equal(card.lastItem.type, "commandExecution");
  assert.equal(card.lastItem.turnId, "turn-1");
  assert.match(card.lastItem.text, /ls -la/);
  assert.equal(card.lastItemStatus, "inProgress", "the status belongs to the item the label came from");
  assert.deepEqual(board.probe.itemProbed, ["T1"]);
  assert.deepEqual(board.probe.itemUnprobedThreadIds, ["T2"]);
  assert.equal(board.probe.itemCoverageComplete, false);
});

test("a card with no readable item is left blank, not filled in", () => {
  const allReasoning = buildBoard({
    now: 1_000_000,
    threads: [THREAD("T1", 999)],
    items: { T1: { last: { type: "reasoning", text: "(reasoning not exposed: encrypted)", turnId: "turn-1" }, status: null } },
  });
  const card = allReasoning.columns.find((column) => column.id === "unobserved").cards[0];
  assert.equal(card.lastItem.type, "reasoning");
  assert.equal(card.lastItemStatus, null);
  assert.equal(buildBoard({ threads: [THREAD("T1", 999)] }).columns.at(-1).cards[0].lastItem, null);
});

test("a card's last text is clamped, like every other projected field", () => {
  const board = buildBoard({
    now: 1_000_000,
    threads: [THREAD("T1", 999)],
    items: { T1: { last: { type: "agentMessage", text: "x".repeat(5000) } } },
  });
  const card = board.columns.find((column) => column.id === "unobserved").cards[0];
  assert.ok(card.lastItem.text.length < 5000);
  assert.match(card.lastItem.text, /truncated \d+ chars/);
});

test("a failed item probe is reported, not rendered as a thread with no history", async () => {
  const client = stubClient({
    "thread/list": () => ({ data: [{ id: "T1", preview: "a", updatedAt: 1000 }] }),
    "thread/queue/list": () => ({ data: [] }),
    "thread/items/list": () => { throw new Error("thread/items/list is not available"); },
  });
  const board = await collectBoard(client, { recentNotifications: [] }, { maxThreads: 1, includeAccount: false });
  assert.equal(board.probe.itemCoverageComplete, false);
  assert.equal(board.probe.itemProbeErrors.length, 1);
  assert.equal(board.probe.itemProbeErrors[0].threadId, "T1");
  const card = board.columns.find((column) => column.id === "unobserved").cards[0];
  assert.equal(card.lastItem, null);
  assert.equal(card.lastItemStatus, null);
});

/** Build a POST request carrying the client's envelope. */
function rpcRequest(body, path = RPC_ROUTE) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Build a well-formed client request for one endpoint. */
function clientRequest(method, payload = {}, rpcId = "rpc-1") {
  return { type: "client-request", rpcId, payload: { method, payload } };
}

test("the route answers a snapshot and rejects everything else explicitly", async () => {
  const route = createRouteHandler(new Map([["snapshot", async () => ({ ok: true })]]));

  const good = await route(rpcRequest(clientRequest("snapshot")));
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { type: "server-response", rpcId: "rpc-1", result: { ok: true, value: { ok: true } } });

  assert.equal((await route(new Request(`http://localhost${RPC_ROUTE}`, { method: "GET" }))).status, 405);
  assert.equal((await route(new Request(`http://localhost${RPC_ROUTE}`, { method: "POST", body: "not json" }))).status, 400);

  const wrongType = await (await route(rpcRequest({ type: "server-response", rpcId: "rpc-1" }))).json();
  assert.equal(wrongType.result.ok, false);
  assert.match(wrongType.result.error.message, /invalid client-request/);

  const noPayload = await (await route(rpcRequest({ type: "client-request", rpcId: "rpc-1" }))).json();
  assert.match(noPayload.result.error.message, /missing call payload/);

  const unknown = await (await route(rpcRequest(clientRequest("nope")))).json();
  assert.equal(unknown.result.ok, false);
  assert.match(unknown.result.error.message, /unknown endpoint: nope/);

  const offChannel = await (await route(rpcRequest(clientRequest("snapshot"), "/api/other"))).json();
  assert.match(offChannel.result.error.message, /not on channel/);

  const badId = await (await route(rpcRequest(clientRequest("snapshot", {}, "has spaces")))).json();
  assert.equal(badId.rpcId, "invalid-request");
});

test("a handler that throws answers a failure envelope, not a broken response", async () => {
  const route = createRouteHandler(new Map([["snapshot", async () => { throw new Error("app-server is gone"); }]]));
  const response = await route(rpcRequest(clientRequest("snapshot")));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.ok, false);
  assert.equal(body.result.error.message, "app-server is gone");
});

test("mountBoardChannel registers the exact route and yields to a live copy", async () => {
  const registered = [];
  const client = stubClient({
    "thread/list": () => ({ data: [{ id: "T1", preview: "a", updatedAt: 1000 }] }),
    "thread/queue/list": () => ({ data: [] }),
    "thread/items/list": () => ({ data: [itemEntry({ id: "a1", type: "agentMessage", text: "hello" })] }),
  });
  const bridge = { connection: async () => client, recentNotifications: [] };
  const ctx = {
    get: (name) => (name === "connection"
      ? { fetch: { register: (options) => { registered.push(options); return () => {}; } } }
      : undefined),
    effect: () => {},
  };

  const result = mountBoardChannel(ctx, bridge, { includeAccount: false });
  assert.equal(result.ok, true);
  assert.equal(result.path, RPC_ROUTE);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].path, RPC_ROUTE);
  assert.deepEqual(registered[0].methods, ["POST"]);
  assert.equal(registered[0].requestBody, "buffered");

  const answered = await registered[0].fetch(rpcRequest(clientRequest("snapshot")));
  const body = await answered.json();
  assert.equal(body.result.ok, true);
  assert.equal(body.result.value.columns.length, 4);
  assert.equal(body.result.value.columns.at(-1).cards[0].threadId, "T1");

  const noConnection = mountBoardChannel({ get: () => undefined }, bridge, {});
  assert.equal(noConnection.ok, false);
  assert.equal(noConnection.reason, "connection.fetch.register-missing");

  const duplicating = mountBoardChannel({
    get: () => ({ fetch: { register: () => { throw new Error(`${RPC_ROUTE} is already registered`); } } }),
  }, bridge, {});
  assert.equal(duplicating.ok, false);
  assert.equal(duplicating.reason, "fetch-route-duplicate");
});

test("mountBoardChannel never throws out of plugin activation", () => {
  const hostile = {
    get: () => { throw new Error("the context is gone"); },
  };
  assert.doesNotThrow(() => mountBoardChannel(hostile, { connection: async () => stubClient({}) }, {}));
});
