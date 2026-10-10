/**
 * Wire-level tests: the bridge against a real child process speaking the real format.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { CodexAppServer, newClientMessageId, resolveCodexBin } from "../src/app-server.js";

const FAKE = fileURLToPath(new URL("./helpers/fake-codex.js", import.meta.url));

/**
 * @param env - extra environment for the fake server.
 * @returns an unstarted client pointed at the fake.
 */
function makeClient(env = {}) {
  return new CodexAppServer({
    bin: process.execPath,
    args: [FAKE],
    env: { ...process.env, ...env },
  });
}

test("start() completes the initialize handshake before resolving", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());
  assert.equal(client.initialized, false);
  await client.start();
  assert.equal(client.initialized, true);
  assert.equal(client.alive, true);
});

test("start() is idempotent and concurrent callers share one child", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());
  const [a, b] = await Promise.all([client.start(), client.start()]);
  assert.equal(a, b);
  assert.equal(a, client);
});

test("call() correlates each response to its own request by id", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());
  await client.start();
  const [threads, account, items] = await Promise.all([
    client.call("thread/list", { limit: 5 }),
    client.call("account/read", {}),
    client.call("thread/items/list", { threadId: "T1" }),
  ]);
  assert.equal(threads.data.length, 2);
  assert.equal(account.account.email, "fake@example.com");
  assert.equal(items.data.length, 5);
});

test("a server error rejects only that call, with code and message preserved", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());
  await client.start();
  await assert.rejects(
    () => client.call("nope/not-a-method", {}),
    (error) => {
      assert.equal(error.code, -32601);
      assert.match(error.message, /unknown method nope\/not-a-method/);
      return true;
    },
  );
  // The connection survives a rejected call.
  const threads = await client.call("thread/list", {});
  assert.equal(threads.data.length, 2);
});

test("notifications are fanned out with method and params", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());
  const seen = [];
  client.on("notification", (message) => seen.push(message));
  await client.start();
  await once(client, "notification").catch(() => {});
  // Allow the two remaining frames to arrive.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const methods = seen.map((message) => message.method);
  assert.ok(methods.includes("item/agentMessage/delta"), `saw ${methods.join(",")}`);
  assert.ok(methods.includes("turn/started"), `saw ${methods.join(",")}`);
  const delta = seen.find((message) => message.method === "item/agentMessage/delta");
  assert.equal(delta.params.delta, "hello ");
});

test("an inbound server request is captured, listed, and can be answered", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());
  const resolved = [];
  client.on("notification", (message) => {
    if (message.method === "fake/resolved") resolved.push(message.params);
  });
  await client.start();
  if (client.pendingServerRequests().length === 0) await once(client, "serverRequest");

  const pending = client.pendingServerRequests();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].method, "item/commandExecution/requestApproval");
  assert.deepEqual(pending[0].params.command, ["rm", "-rf", "/tmp/x"]);

  client.respond(pending[0].id, { result: { decision: "decline" } });
  assert.deepEqual(client.pendingServerRequests(), []);

  const deadline = Date.now() + 2000;
  while (resolved.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(resolved.length, 1, "the server should have received our answer");
  assert.deepEqual(resolved[0].result, { decision: "decline" });
});

test("the active-writer refusal surfaces verbatim, and is not a crash", async (t) => {
  const client = makeClient({ FAKE_CODEX_LOCK: "1" });
  t.after(() => client.stop());
  await client.start();
  await assert.rejects(
    () => client.call("thread/resume", { threadId: "T1" }),
    /already has an active writer/,
  );
  await assert.rejects(
    () => client.call("turn/steer", { threadId: "T1", expectedTurnId: "turn-1" }),
    /already has an active writer/,
  );
  // queueing still works while the lock is held: that is the whole point.
  const queued = await client.call("thread/queue/add", { threadId: "T1", input: [] });
  assert.equal(queued.queuedSubmission.queueOrder, 1);
});

test("a request that is never answered rejects on its own timeout", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());
  await client.start();
  await assert.rejects(
    () => client.call("fake/hang", {}, { timeoutMs: 150 }),
    /timed out: fake\/hang \(150ms\)/,
  );
  // The timeout must not poison the connection.
  const threads = await client.call("thread/list", {});
  assert.equal(threads.data.length, 2);
});

test("stop() rejects in-flight calls and detaches the child", async (t) => {
  const client = makeClient();
  await client.start();
  const inflight = client.call("fake/hang", {}, { timeoutMs: 10_000 });
  client.stop();
  await assert.rejects(() => inflight, /codex app-server stopped/);
  assert.equal(client.alive, false);
  t.after(() => client.stop());
});

test("resolveCodexBin honours an explicit path and reports a bare command otherwise", () => {
  assert.equal(resolveCodexBin(process.execPath), process.execPath);
  const bogus = resolveCodexBin("/definitely/not/a/real/binary");
  assert.equal(typeof bogus, "string");
  assert.ok(bogus.length > 0);
});

test("newClientMessageId returns distinct ids", () => {
  assert.notEqual(newClientMessageId(), newClientMessageId());
});
