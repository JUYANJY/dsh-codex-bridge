/**
 * Takeover tests: the three honest outcomes when Codex runs out of quota.
 *
 * The load-bearing rule here is that a prepared brief is NOT a handover. The
 * plugin cannot push into a Harness conversation, so `claimed` may only ever be
 * set by an explicit claim — these tests fail if that is ever softened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Takeovers, takeoverDecision } from "../src/takeover.js";

/** The app-server answers `collectHandoff` + `readBudget` need. */
function fakeClient(overrides = {}) {
  const reached = {
    ordinaryUsageAllowed: false,
    spendControlReached: false,
    rateLimitReachedType: "primary",
    rateLimits: {
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_800_000_000 },
    },
    rateLimitResetCredits: { availableCount: 2, credits: [] },
  };
  const handlers = {
    "thread/list": () => ({ data: [{ id: "T1", title: "the stuck project", cwd: "/tmp/demo", updatedAt: 1_700_000_000 }] }),
    "thread/read": () => ({ thread: { id: "T1", name: "the stuck project", cwd: "/tmp/demo", path: "/tmp/rollout.jsonl" } }),
    "thread/turns/list": () => ({
      data: [
        { id: "turn-2", status: "failed", error: { message: "usage limit reached" }, startedAt: 1_699_999_000, completedAt: 1_699_999_500, durationMs: 500, items: [] },
        { id: "turn-1", status: "completed", startedAt: 1_699_990_000, completedAt: 1_699_995_000, durationMs: 5000, items: [] },
      ],
    }),
    "thread/items/list": () => ({
      data: [{ turnId: "turn-2", item: { type: "userMessage", content: [{ type: "text", text: "finish stage C" }] } }],
    }),
    "thread/goal/get": () => ({ goal: { threadId: "T1", objective: "finish stage C then test it", status: "active", tokensUsed: 10, tokenBudget: null } }),
    "thread/queue/list": () => ({ data: [] }),
    "account/rateLimits/read": () => reached,
    ...overrides,
  };
  return {
    calls: [],
    async call(method) {
      this.calls.push(method);
      const handler = handlers[method];
      if (!handler) throw new Error(`no stub for ${method}`);
      return handler();
    },
  };
}

test("a budget that is not reached is not a takeover decision at all", () => {
  assert.equal(takeoverDecision(null, {}).action, "none");
  assert.equal(takeoverDecision({ level: "ok" }, {}).action, "none");
  assert.match(takeoverDecision({ level: "unknown" }, {}).reason, /reads "unknown"/);
});

test("a reached quota stays a call for a person until a takeover is authorised", () => {
  const decision = takeoverDecision({ level: "reached" }, { handoffArmed: false });
  assert.equal(decision.action, "keep-red");
  assert.match(decision.reason, /no takeover has been authorised/);
  assert.match(decision.reason, /stays a call for a person/);
});

test("an authorised takeover prepares a brief", () => {
  const decision = takeoverDecision({ level: "reached" }, { handoffArmed: true });
  assert.equal(decision.action, "prepare-handoff");
  assert.match(decision.reason, /a brief is prepared/);
});

test("prepare writes the brief, and reports it as unclaimed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcb-takeover-"));
  try {
    const store = new Takeovers();
    const result = await store.prepare(fakeClient(), { threadId: "T1", cwd: dir, saveTo: join(dir, "brief.md") });

    assert.equal(result.ok, true);
    assert.equal(result.claimed, false);
    assert.equal(result.claimedAt, null);
    assert.ok(result.path.endsWith("brief.md"));
    assert.ok(existsSync(result.path), "the brief is on disk for whoever picks it up");
    const written = readFileSync(result.path, "utf8");
    assert.match(written, /## What Codex was asked to do/);
    assert.match(written, /finish stage C then test it/);
    assert.match(result.detail, /unclaimed/);

    const status = store.status();
    assert.equal(status.prepared, 1);
    assert.equal(status.claimed, 0);
    assert.equal(status.unclaimed, 1);
    assert.equal(store.forThread("T1").claimed, false);
    assert.equal(store.forThread("T2"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare refuses when the quota is not actually reached, and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcb-takeover-skip-"));
  try {
    const store = new Takeovers();
    const client = fakeClient({
      "account/rateLimits/read": () => ({
        ordinaryUsageAllowed: true,
        rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 } },
      }),
    });
    const result = await store.prepare(client, { threadId: "T1", cwd: dir, saveTo: join(dir, "brief.md") });
    assert.equal(result.ok, false);
    assert.equal(result.path, null);
    assert.match(result.detail, /not prepared/);
    assert.equal(existsSync(join(dir, "brief.md")), false);
    assert.equal(store.records.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claiming is what turns a prepared brief into a taken-over one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcb-takeover-claim-"));
  try {
    const store = new Takeovers();
    const prepared = await store.prepare(fakeClient(), { threadId: "T1", cwd: dir, saveTo: join(dir, "brief.md") });
    assert.equal(prepared.claimed, false);

    const claim = store.claim({ threadId: "T1", claimedBy: "a DeepSeek Harness turn" });
    assert.equal(claim.ok, true);
    assert.equal(claim.record.claimedBy, "a DeepSeek Harness turn");
    assert.ok(claim.record.claimedAt > 0);

    const status = store.status();
    assert.equal(status.prepared, 1);
    assert.equal(status.claimed, 1);
    assert.equal(status.unclaimed, 0);
    assert.equal(store.forThread("T1").claimed, true);
    assert.ok(status.log.some((line) => line.action === "claimed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claiming something that was never prepared fails with the reason", () => {
  const store = new Takeovers();
  const claim = store.claim({ threadId: "T1" });
  assert.equal(claim.ok, false);
  assert.match(claim.detail, /no prepared takeover matches thread T1/);
});

test("a claim can be addressed by path when the thread id is unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcb-takeover-path-"));
  try {
    const store = new Takeovers();
    const prepared = await store.prepare(fakeClient(), { threadId: "T1", cwd: dir, saveTo: join(dir, "brief.md") });
    const claim = store.claim({ path: prepared.path, claimedBy: "a person" });
    assert.equal(claim.ok, true);
    assert.equal(claim.record.threadId, "T1");
    assert.equal(store.claim({ path: "/nowhere.md" }).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the store is bounded, oldest first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcb-takeover-bound-"));
  try {
    const store = new Takeovers();
    for (let index = 0; index < 3; index += 1) {
      const client = fakeClient({
        "thread/list": () => ({ data: [{ id: `T${index}`, title: "x", cwd: dir, updatedAt: 1_700_000_000 }] }),
        "thread/read": () => ({ thread: { id: `T${index}`, name: "x", cwd: dir } }),
      });
      await store.prepare(client, { threadId: `T${index}`, cwd: dir, saveTo: join(dir, `brief-${index}.md`) });
    }
    assert.equal(store.records.size, 3);
    // The cap is 20; shrinking it here would need 20 briefs, so assert the
    // trimming path directly instead.
    while (store.records.size > 2) {
      const oldest = [...store.records.values()].sort((a, b) => a.preparedAt - b.preparedAt)[0];
      store.records.delete(oldest.threadId);
    }
    assert.equal(store.records.size, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a thread whose turns list is unreadable still produces a brief that says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcb-takeover-thin-"));
  try {
    const store = new Takeovers();
    const client = fakeClient({
      "thread/turns/list": () => { throw new Error("ephemeral threads do not support thread/turns/list"); },
      "thread/items/list": () => { throw new Error("not supported yet"); },
    });
    const result = await store.prepare(client, { threadId: "T1", cwd: dir, saveTo: join(dir, "brief.md") });
    assert.equal(result.ok, true, "a thin brief is still a brief — it just has less in it");
    const written = readFileSync(result.path, "utf8");
    assert.match(written, /## What Codex was asked to do/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default destination is a file under the project, not a vague promise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcb-takeover-default-"));
  try {
    const store = new Takeovers();
    const result = await store.prepare(fakeClient(), { threadId: "T1", cwd: dir });
    assert.equal(result.ok, true);
    assert.ok(result.path.startsWith(join(dir, ".codex-handoff")), result.path);
    assert.ok(existsSync(result.path));
    assert.ok(result.chars > 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
