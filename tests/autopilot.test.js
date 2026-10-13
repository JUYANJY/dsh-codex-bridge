/**
 * Autopilot tests: the guard rails around the plugin's only self-directed
 * write. Every refusal must have a code and a sentence, and the arming window
 * must be the thing that ends it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AUTOPILOT_DEFAULTS, Autopilot, CONTINUE_PLAIN, CONTINUE_WITH_GOAL, continueMessage, decideAutoContinue, queueAutopilotMessage, stuckFingerprint } from "../src/autopilot.js";

const NOW = 1_700_000_000_000;

/** A board card in the shape `buildBoard` produces, narrowed to what the policy reads. */
function card(overrides = {}) {
  return {
    threadId: "T1",
    state: "blocked",
    waitingCount: 0,
    queuedCount: 0,
    ageMs: 10 * 60_000,
    lastTurnId: "turn-1",
    turnStatus: "completed",
    goal: null,
    lastItem: null,
    ...overrides,
  };
}

/** An armed policy, as `Autopilot.arm` would leave it. */
function policy(overrides = {}) {
  return { ...AUTOPILOT_DEFAULTS, armed: true, expiresAt: NOW + 60_000, ...overrides };
}

test("nothing is sent while the autopilot is disarmed", () => {
  const decision = decideAutoContinue(card(), policy({ armed: false }), {}, NOW);
  assert.equal(decision.action, "skip");
  assert.equal(decision.code, "not-armed");
});

test("an expired window refuses and says so", () => {
  const decision = decideAutoContinue(card(), policy({ expiresAt: NOW - 1 }), {}, NOW);
  assert.equal(decision.code, "window-expired");
});

test("only a blocked card is continued; the other three states are refused by name", () => {
  for (const state of ["running", "no-activity", "needs-human"]) {
    const decision = decideAutoContinue(card({ state }), policy(), {}, NOW);
    assert.equal(decision.action, "skip");
    assert.equal(decision.code, `state-${state}`);
  }
  assert.equal(decideAutoContinue(card({ state: "blocked" }), policy(), {}, NOW).action, "send");
});

test("an approval outranks the autopilot: a person is paged, not a queue entry", () => {
  const decision = decideAutoContinue(card({ waitingCount: 1 }), policy(), {}, NOW);
  assert.equal(decision.code, "approval-pending");
  assert.match(decision.text, /work for a person/);
});

test("a failed turn is never auto-continued", () => {
  const decision = decideAutoContinue(card({ turnStatus: "failed" }), policy(), {}, NOW);
  assert.equal(decision.code, "turn-failed");
});

test("a queued message blocks a second one", () => {
  const decision = decideAutoContinue(card({ queuedCount: 1 }), policy(), {}, NOW);
  assert.equal(decision.code, "already-queued");
});

test("a thread that just moved is left to settle", () => {
  const decision = decideAutoContinue(card({ ageMs: 5_000 }), policy({ settleMs: 30_000 }), {}, NOW);
  assert.equal(decision.code, "settling");
  assert.match(decision.text, /active 5s ago/);
});

test("the same stuck turn is continued once, not once per poll", () => {
  const first = decideAutoContinue(card(), policy(), {}, NOW);
  assert.equal(first.action, "send");
  const sent = new Map([["T1", { count: 1, lastAt: NOW, fingerprint: first.fingerprint }]]);
  const again = decideAutoContinue(card(), policy({ expiresAt: NOW + 3_600_000, minIntervalMs: 0 }), { sent, total: 1 }, NOW + 10 * 60_000);
  assert.equal(again.code, "already-continued");
});

test("a per-thread and a global message budget both stop the autopilot", () => {
  const perThread = new Map([["T1", { count: 3, lastAt: NOW - 10 * 60_000, fingerprint: "other" }]]);
  assert.equal(decideAutoContinue(card(), policy({ maxPerThread: 3 }), { sent: perThread, total: 3 }, NOW).code, "thread-limit");
  const global = decideAutoContinue(card(), policy({ maxTotal: 2 }), { total: 2 }, NOW);
  assert.equal(global.code, "global-limit");
});

test("a minimum interval spaces two continuations of the same thread", () => {
  const sent = new Map([["T1", { count: 1, lastAt: NOW - 1_000, fingerprint: "other" }]]);
  const decision = decideAutoContinue(card(), policy({ minIntervalMs: 120_000 }), { sent, total: 1 }, NOW);
  assert.equal(decision.code, "min-interval");
  assert.match(decision.text, /Waiting 119s/);
});

test("a paused thread and a halted thread are both refused", () => {
  assert.equal(decideAutoContinue(card(), policy(), { paused: new Set(["T1"]) }, NOW).code, "paused");
  const halted = new Map([["T1", { reason: "the autopilot sent nothing after 2 attempts" }]]);
  const decision = decideAutoContinue(card(), policy(), { halted }, NOW);
  assert.equal(decision.code, "thread-halted");
  assert.match(decision.text, /2 attempts/);
});

test("the message names the goal when there is one, and says what it is otherwise", () => {
  const withGoal = continueMessage(card({ goal: { objective: "finish the migration", status: "active" } }));
  assert.equal(withGoal, CONTINUE_WITH_GOAL.split("{objective}").join("finish the migration"));
  assert.equal(continueMessage(card()), CONTINUE_PLAIN);
  const templated = continueMessage(card({ threadId: "T9", goal: { objective: "o" } }), "keep going on {objective} in {threadId}");
  assert.equal(templated, "keep going on o in T9");
});

test("the fingerprint identifies the stuck state, not the thread", () => {
  assert.equal(stuckFingerprint(card()), stuckFingerprint(card()));
  assert.notEqual(stuckFingerprint(card()), stuckFingerprint(card({ lastTurnId: "turn-2" })));
});

test("runPass sends one message per blocked card and records why", async () => {
  const autopilot = new Autopilot();
  autopilot.arm({ ttlMinutes: 5 }, NOW);
  const sent = [];
  const result = await autopilot.runPass([
    card({ threadId: "T1" }),
    card({ threadId: "T2", state: "running" }),
    card({ threadId: "T3", waitingCount: 2 }),
  ], {
    now: NOW + 60_000,
    send: async (entry, message) => {
      sent.push([entry.threadId, message]);
      return { id: "sub-1", detail: "queued as sub-1" };
    },
  });

  assert.deepEqual(sent.map(([threadId]) => threadId), ["T1"]);
  assert.equal(result.considered, 2, "only blocked and needs-human cards are even considered");
  assert.equal(result.sent, 1);
  assert.equal(result.skipped, 1);
  assert.equal(autopilot.total, 1);
  const codes = autopilot.status(NOW).log.map((entry) => entry.code);
  assert.ok(codes.includes("sent"), `expected a sent entry in ${codes.join(",")}`);
  assert.ok(codes.includes("approval-pending"));
  assert.ok(!codes.includes("state-running"), "a running card is not even considered, so it gets no skip line");
});

test("an expired window disarms on the next pass instead of sending", async () => {
  const autopilot = new Autopilot();
  autopilot.arm({ ttlMinutes: 1 }, NOW);
  let calls = 0;
  const result = await autopilot.runPass([card({ threadId: "T1" })], {
    now: NOW + 2 * 60_000,
    send: async () => { calls += 1; return { id: "x" }; },
  });
  assert.equal(result.reason, "window-expired");
  assert.equal(calls, 0);
  assert.equal(autopilot.status(NOW + 2 * 60_000).armed, false);
});

test("two failed sends stop that thread instead of retrying forever", async () => {
  const autopilot = new Autopilot();
  autopilot.arm({ ttlMinutes: 5, minIntervalMs: 0, settleMs: 0 }, NOW);
  const failing = async () => { throw new Error("thread T1 already has an active writer"); };

  await autopilot.runPass([card()], { now: NOW + 1, send: failing });
  assert.equal(autopilot.halted.size, 0, "one failure is a retry");
  await autopilot.runPass([card()], { now: NOW + 2, send: failing });
  assert.equal(autopilot.halted.size, 1, "two failures stop the thread");

  const status = autopilot.status(NOW + 3);
  assert.match(status.halted[0].reason, /already has an active writer/);
  const decision = decideAutoContinue(card(), autopilot.policy, autopilot, NOW + 4);
  assert.equal(decision.code, "thread-halted");
});

test("arm bounds the window and disarm ends it, both with a log line", () => {
  const autopilot = new Autopilot();
  const armed = autopilot.arm({ ttlMinutes: 10, maxTotal: 4 }, NOW);
  assert.equal(armed.armed, true);
  assert.equal(armed.remainingMs, 10 * 60_000);
  assert.equal(armed.limits.maxTotal, 4);
  assert.equal(autopilot.status(NOW).log.at(-1).code, "armed");

  const disarmed = autopilot.disarm("the human said stop", NOW + 1);
  assert.equal(disarmed.armed, false);
  assert.equal(disarmed.remainingMs, null);
  assert.equal(autopilot.status(NOW + 1).log.at(-1).code, "disarmed");
});

test("arming twice resets the counters but not the policy", () => {
  const autopilot = new Autopilot();
  autopilot.arm({ ttlMinutes: 5, maxPerThread: 1 }, NOW);
  autopilot.total = 7;
  autopilot.sent.set("T1", { count: 7, lastAt: NOW, fingerprint: "x" });
  const again = autopilot.arm({ ttlMinutes: 1 }, NOW + 1);
  assert.equal(autopilot.total, 0);
  assert.equal(again.limits.maxPerThread, 1, "a later arm keeps the settings it was not asked to change");
  assert.equal(again.remainingMs, 60_000);
});

test("the timer ticks only while armed, and stopTimer ends it", async () => {
  const autopilot = new Autopilot();
  let ticks = 0;
  autopilot.startTimer(async () => { ticks += 1; }, 10);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ticks, 0, "a disarmed autopilot must not touch Codex on a timer");
  autopilot.arm({ ttlMinutes: 1 }, Date.now());
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(ticks > 0, "an armed autopilot looks at the board on its own");
  autopilot.stopTimer();
  const seen = ticks;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ticks, seen, "stopTimer really stops it");
});

test("queueAutopilotMessage writes through thread/queue/add and re-reads the queue", async () => {
  const calls = [];
  const client = {
    async call(method, params) {
      calls.push([method, params]);
      if (method === "thread/queue/add") return { queuedSubmission: { id: "sub-9", input: params.input, clientUserMessageId: params.clientUserMessageId } };
      if (method === "thread/queue/list") return { data: [{ id: "sub-9" }] };
      throw new Error(`unexpected ${method}`);
    },
  };

  const detail = await queueAutopilotMessage(client, card(), "continue please");
  assert.deepEqual(calls.map(([method]) => method), ["thread/queue/add", "thread/queue/list"]);
  assert.equal(calls[0][1].threadId, "T1");
  assert.deepEqual(calls[0][1].input, [{ type: "text", text: "continue please" }]);
  assert.equal(detail.id, "sub-9");
  assert.equal(detail.visible, true);
  assert.match(detail.detail, /the queue now holds 1 message/);
});

test("queueAutopilotMessage reports a queue re-read that cannot see the message", async () => {
  const client = {
    async call(method) {
      if (method === "thread/queue/add") return { queuedSubmission: { id: "sub-9" } };
      if (method === "thread/queue/list") return { data: [] };
      throw new Error(`unexpected ${method}`);
    },
  };
  const detail = await queueAutopilotMessage(client, card(), "x");
  assert.equal(detail.visible, false);
  assert.equal(detail.id, "sub-9");
});
