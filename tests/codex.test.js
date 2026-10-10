/**
 * Projection tests: codex protocol payloads in, compact records out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  clamp,
  compactLimits,
  extractText,
  listItems,
  listThreads,
  renderItem,
  resolveThreadId,
} from "../src/codex.js";

/**
 * @param handlers - method name to `(params) => result`, or a function.
 * @returns a stub client recording every call.
 */
function stubClient(handlers = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params = {}) {
      calls.push([method, params]);
      const handler = handlers[method];
      if (typeof handler === "function") return handler(params);
      if (handler !== undefined) return handler;
      throw new Error(`no stub for ${method}`);
    },
  };
}

test("clamp leaves short text alone and marks truncation", () => {
  assert.equal(clamp("abc", 10), "abc");
  assert.equal(clamp("abcdef", 3), "abc\n…[truncated 3 chars]");
  assert.equal(clamp(null, 3), "");
  assert.equal(clamp(42, 3), "42");
});

test("extractText walks content arrays, nested summaries and plain strings", () => {
  assert.equal(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(extractText({ content: [{ text: "x" }] }), "x");
  assert.equal(extractText({ summary: ["s1", "s2"] }), "s1\ns2");
  assert.equal(extractText("bare"), "bare");
  assert.equal(extractText({ message: "m" }), "m");
  assert.equal(extractText(undefined), "");
});

test("renderItem: user and agent messages", () => {
  assert.deepEqual(renderItem({ type: "userMessage", content: [{ text: "hi" }] }), { type: "userMessage", text: "hi" });
  assert.deepEqual(renderItem({ type: "agentMessage", content: [{ text: "yo" }] }), { type: "agentMessage", text: "yo" });
});

test("renderItem: reasoning falls back to an explicit encrypted marker", () => {
  // The reason this matters: the model provider encrypts reasoning bodies, so a
  // bare `{summary: [], content: []}` is the normal case, not an error state.
  assert.deepEqual(
    renderItem({ type: "reasoning", summary: ["**Thinking**"], content: [] }),
    { type: "reasoning", text: "**Thinking**" },
  );
  assert.deepEqual(
    renderItem({ type: "reasoning", summary: [], content: [] }),
    { type: "reasoning", text: "(reasoning not exposed: encrypted)" },
  );
});

test("renderItem: command execution carries status and output", () => {
  assert.deepEqual(
    renderItem({ type: "commandExecution", command: "ls", status: "completed", aggregatedOutput: "ok" }),
    { type: "commandExecution", text: "$ ls  [completed]\nok" },
  );
  assert.deepEqual(
    renderItem({ type: "commandExecution", command: "ls", status: "failed" }),
    { type: "commandExecution", text: "$ ls  [failed]" },
  );
});

test("renderItem: file changes list kind, path and diff", () => {
  assert.deepEqual(
    renderItem({ type: "fileChange", changes: [{ path: "a.ts", kind: { type: "add" }, diff: "@@" }] }),
    { type: "fileChange", text: "[add] a.ts\n@@" },
  );
  assert.deepEqual(renderItem({ type: "fileChange", changes: [] }), { type: "fileChange", text: "(no changes)" });
});

test("renderItem: mcp calls, todos, errors and unknown types", () => {
  assert.equal(renderItem({ type: "mcpToolCall", server: "s", tool: "t", status: "completed" }).text, "mcp s.t [completed]");
  assert.equal(renderItem({ type: "todoList", items: [{ status: "pending", content: "do it" }] }).text, "[pending] do it");
  assert.deepEqual(renderItem({ type: "error", message: "boom" }), { type: "error", text: "boom" });
  assert.deepEqual(renderItem(null), { type: "unknown", text: "" });
  assert.equal(renderItem({ type: "somethingNew", text: "x" }).text, "x");
});

test("compactLimits reads the numbers that decide 'out of budget'", () => {
  const compact = compactLimits({
    ordinaryUsageAllowed: true,
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1 },
      secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 2 },
      rateLimitReachedType: "primary",
    },
    rateLimitResetCredits: { availableCount: 2 },
  });
  assert.deepEqual(compact, {
    planType: "plus",
    ordinaryUsageAllowed: true,
    reached: "primary",
    primary: { usedPercent: 42, windowMins: 300, resetsAt: 1 },
    secondary: { usedPercent: 8, windowMins: 10080, resetsAt: 2 },
    resetCreditsAvailable: 2,
  });
  assert.equal(compactLimits({}), null);
  assert.equal(compactLimits({ rateLimits: {} }).primary, null);
});

test("listThreads projects the thread shape and collapses whitespace in the preview", async () => {
  const client = stubClient({
    "thread/list": {
      data: [{
        id: "T1",
        title: "t",
        preview: "  a\n  b  ",
        cwd: "/x",
        model: "m",
        reasoningEffort: "high",
        status: { type: "notLoaded" },
        updatedAt: 1791600000,
        path: "/p.jsonl",
      }],
    },
  });
  const [thread] = await listThreads(client, { limit: 5 });
  assert.equal(thread.preview, "a b");
  assert.equal(thread.status, "notLoaded");
  assert.equal(thread.effort, "high");
  assert.equal(thread.updatedAt, new Date(1791600000 * 1000).toISOString());
  assert.deepEqual(client.calls[0], ["thread/list", { limit: 5 }]);
});

test("listItems projects items and keeps the ids", async () => {
  const client = stubClient({
    "thread/items/list": { data: [{ turnId: "turn-1", item: { type: "agentMessage", id: "i1", content: [{ text: "hi" }] } }] },
  });
  const { items } = await listItems(client, { threadId: "T1" });
  assert.deepEqual(items, [{ turnId: "turn-1", itemId: "i1", type: "agentMessage", text: "hi" }]);
});

test("resolveThreadId prefers explicit, then cwd match, then newest overall", async () => {
  const client = stubClient({
    "thread/list": (params) => ({
      data: params.cwd === "/beta" ? [{ id: "T2" }] : [{ id: "T1" }, { id: "T2" }],
    }),
  });
  assert.equal(await resolveThreadId(client, { threadId: "EXPLICIT" }), "EXPLICIT");
  assert.equal(await resolveThreadId(client, { cwd: "/beta" }), "T2");
  assert.equal(await resolveThreadId(client, { cwd: "/nowhere" }), "T1");
});

test("resolveThreadId returns null when there is nothing to pick", async () => {
  const client = stubClient({ "thread/list": { data: [] } });
  assert.equal(await resolveThreadId(client, { cwd: "/nope" }), null);
});
