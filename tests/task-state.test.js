/**
 * Task-state tests: the colour rules, and the honesty of the evidence behind
 * them. Every state must name a rule, and every rule must say whether Codex
 * reported it or this plugin inferred it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FRESH_ACTIVITY_MS, STATE_LABELS, TASK_STATES, deriveTaskState, planFromNotifications, planSteps, progressOf, statusKey, trailingQuestion, turnStrip,
} from "../src/task-state.js";

const NOW = 1_700_000_000_000;

/** One thread row as `listThreads` projects it. */
function thread(overrides = {}) {
  return { id: "T1", title: "t", preview: "p", cwd: "/repo", status: "notLoaded", updatedAt: new Date(NOW - 10 * 60_000).toISOString(), ...overrides };
}

/** One compact turn as `listTurns` projects it. */
function turn(overrides = {}) {
  return { id: "turn-1", status: "completed", completedAt: 1, startedAt: 1, error: null, items: { count: 0, counts: {}, messages: [] }, ...overrides };
}

/** Codes of the reasons a derivation produced. */
function codes(result) {
  return result.reasons.map((reason) => reason.code);
}

test("the four states are the only states, in display order", () => {
  assert.deepEqual(TASK_STATES, ["needs-human", "blocked", "running", "no-activity"]);
  for (const state of TASK_STATES) assert.equal(typeof STATE_LABELS[state], "string");
});

test("statusKey normalises whatever Codex reports", () => {
  assert.equal(statusKey("inProgress"), "inprogress");
  assert.equal(statusKey("systemError"), "systemerror");
  assert.equal(statusKey(undefined), "");
  assert.equal(statusKey(null), "");
});

test("an approval this connection holds is needs-human, and says so", () => {
  const result = deriveTaskState({ thread: thread(), waitingCount: 1, now: NOW });
  assert.equal(result.state, "needs-human");
  assert.deepEqual(codes(result), ["approval"]);
  assert.equal(result.basis, "reported");
  assert.equal(result.evidence.waitingCount, 1);
});

test("a failed turn is needs-human and quotes the error", () => {
  const result = deriveTaskState({
    thread: thread(),
    turn: turn({ status: "failed", completedAt: 5, error: { message: "stream disconnected before completion" } }),
    now: NOW,
  });
  assert.equal(result.state, "needs-human");
  assert.match(result.reasons[0].text, /stream disconnected before completion/);
});

test("a system error on the thread itself is needs-human", () => {
  const result = deriveTaskState({ thread: thread({ status: "systemError" }), now: NOW });
  assert.equal(result.state, "needs-human");
  assert.deepEqual(codes(result), ["thread-system-error"]);
});

test("a goal Codex reports as stopped is needs-human", () => {
  const result = deriveTaskState({ thread: thread(), goal: { status: "blocked", objective: "o" }, now: NOW });
  assert.equal(result.state, "needs-human");
  assert.deepEqual(codes(result), ["goal-stopped"]);
});

test("an autopilot that stopped a thread is needs-human, with the reason", () => {
  const result = deriveTaskState({ thread: thread(), autopilotStopped: "the autopilot sent nothing after 2 attempts", now: NOW });
  assert.equal(result.state, "needs-human");
  assert.deepEqual(codes(result), ["autopilot-stopped"]);
  assert.match(result.reasons[0].text, /2 attempts/);
});

test("a reported running turn is running, on reported evidence", () => {
  const result = deriveTaskState({ thread: thread(), turn: turn({ status: "inProgress", completedAt: null }), now: NOW });
  assert.equal(result.state, "running");
  assert.equal(result.basis, "reported");
  assert.deepEqual(codes(result), ["turn-running"]);
});

test("a turn this connection saw start is running even with no turn probe", () => {
  const result = deriveTaskState({ thread: thread(), observedTurn: { at: NOW - 1000, turnId: "turn-9" }, now: NOW });
  assert.equal(result.state, "running");
  assert.deepEqual(codes(result), ["turn-running"]);
});

test("an observed turn that no longer matches the probed turn is not running", () => {
  const result = deriveTaskState({
    thread: thread(),
    observedTurn: { at: NOW - 1000, turnId: "turn-old" },
    turn: turn({ id: "turn-new", status: "completed", completedAt: 5 }),
    now: NOW,
  });
  assert.equal(result.state, "no-activity");
});

test("an explicit stop beats the freshness inference: interrupted stays blocked", () => {
  const result = deriveTaskState({
    thread: thread({ updatedAt: new Date(NOW - 5_000).toISOString() }),
    turn: turn({ status: "interrupted", completedAt: null }),
    now: NOW,
  });
  assert.equal(result.state, "blocked", "Codex said the turn stopped; a fresh timestamp must not paint that green");
  assert.equal(result.basis, "reported");
  assert.deepEqual(codes(result), ["turn-unfinished"]);
  assert.match(result.reasons[0].text, /explicit stop beats that inference/);
});

test("a fresh rollout with no status at all is running, but marked inferred", () => {
  const result = deriveTaskState({
    thread: thread({ updatedAt: new Date(NOW - 5_000).toISOString() }),
    turn: turn({ status: null, completedAt: null }),
    now: NOW,
  });
  assert.equal(result.state, "running", "no completion time plus a rollout touched seconds ago is the weak running signal");
  assert.equal(result.basis, "inferred");
  assert.deepEqual(codes(result), ["activity-fresh"]);
  assert.match(result.reasons[0].text, /touched 5s ago/);
});

test("the same unfinished turn with stale activity is blocked instead", () => {
  const result = deriveTaskState({
    thread: thread({ updatedAt: new Date(NOW - FRESH_ACTIVITY_MS - 1).toISOString() }),
    turn: turn({ status: "interrupted", completedAt: null }),
    now: NOW,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.basis, "reported");
  assert.deepEqual(codes(result), ["turn-unfinished"]);
});

test("an active goal with no turn running is blocked — the case the autopilot exists for", () => {
  const result = deriveTaskState({
    thread: thread({ updatedAt: new Date(NOW - 10 * 60_000).toISOString() }),
    goal: { status: "active", objective: "keep going", tokensUsed: 10, tokenBudget: null },
    turn: turn({ status: "completed", completedAt: 5 }),
    now: NOW,
  });
  assert.equal(result.state, "blocked");
  assert.deepEqual(codes(result), ["goal-active-no-turn"]);
  assert.equal(result.evidence.goalStatus, "active");
});

test("a failed last command is blocked when nothing is running", () => {
  const result = deriveTaskState({
    thread: thread(),
    item: { status: "failed", last: { type: "commandExecution" } },
    turn: turn({ status: "completed", completedAt: 5 }),
    now: NOW,
  });
  assert.equal(result.state, "blocked");
  assert.deepEqual(codes(result), ["last-item-failed"]);
});

test("a queued message nobody consumed is blocked, not silent", () => {
  const result = deriveTaskState({ thread: thread(), queue: [{ id: "q1" }], now: NOW });
  assert.equal(result.state, "blocked");
  assert.deepEqual(codes(result), ["queue-waiting"]);
  assert.match(result.reasons[0].text, /1 queued message is waiting/);
});

test("a settled thread with nothing outstanding is grey, and says why", () => {
  const settled = deriveTaskState({ thread: thread(), turn: turn({ status: "completed", completedAt: 5 }), now: NOW });
  assert.equal(settled.state, "no-activity");
  assert.deepEqual(codes(settled), ["turn-settled"]);

  const unprobed = deriveTaskState({ thread: thread(), now: NOW });
  assert.equal(unprobed.state, "no-activity");
  assert.deepEqual(codes(unprobed), ["no-turn-report"]);
});

test("a question at the end of the newest answer is needs-human, and labelled inferred", () => {
  const text = "I rewrote the parser.\nShall I run the full suite now?";
  const result = deriveTaskState({
    thread: thread(),
    turn: turn({ id: "turn-2", status: "completed", completedAt: 5, items: { count: 1, counts: {}, messages: [{ type: "agentMessage", text }] } }),
    now: NOW,
  });
  assert.equal(result.state, "needs-human");
  assert.equal(result.basis, "inferred");
  assert.deepEqual(codes(result), ["question-inferred"]);
  assert.equal(trailingQuestion(turn({ items: { messages: [{ type: "agentMessage", text }] } })), "Shall I run the full suite now?");
});

test("trailingQuestion only fires on the newest message, and only on a question", () => {
  const messages = [
    { type: "agentMessage", text: "Is this right?" },
    { type: "agentMessage", text: "Done — the tests pass." },
  ];
  assert.equal(trailingQuestion(turn({ items: { messages } })), null, "an earlier question is answered, not pending");
  assert.equal(trailingQuestion(turn({ items: { messages: [{ type: "reasoning", text: "hmm?" }] } })), null);
  assert.equal(trailingQuestion(null), null);
});

test("progress comes only from a reported denominator", () => {
  const none = progressOf({});
  assert.equal(none.kind, "none");
  assert.equal(none.percent, null, "no denominator means no bar, not a made-up one");

  const plan = progressOf({ plan: { at: 1234, steps: [{ step: "one", status: "completed" }, { step: "two", status: "inProgress" }, { step: "three", status: "pending" }] } });
  assert.equal(plan.kind, "plan");
  assert.equal(plan.percent, 33);
  assert.equal(plan.label, "1/3 steps");
  assert.match(plan.detail, /current: two/);
  assert.match(plan.source, /plan Codex reported/);

  const budget = progressOf({ goal: { tokensUsed: 25, tokenBudget: 100 } });
  assert.equal(budget.kind, "goal-budget");
  assert.equal(budget.percent, 25);
  assert.equal(budget.source, "thread/goal/get");

  const noBudget = progressOf({ goal: { tokensUsed: 25, tokenBudget: null } });
  assert.equal(noBudget.kind, "none", "a goal without a budget cannot be drawn as a bar");
});

test("a plan is read defensively, and only from the notified stream", () => {
  const shaped = planFromNotifications([
    { at: 1, method: "item/agentMessage/delta", params: { threadId: "T1", delta: "hi" } },
    { at: 2, method: "turn/plan/updated", params: { threadId: "T1", plan: { steps: [{ step: "a", status: "done" }] } } },
  ], "T1");
  assert.deepEqual(shaped, { at: 2, steps: [{ step: "a", status: "done" }] });

  assert.equal(planFromNotifications([{ at: 2, method: "turn/plan/updated", params: { threadId: "T2", plan: { steps: [{ step: "a" }] } } }], "T1"), null);
  assert.equal(planFromNotifications([{ at: 3, method: "turn/plan/updated", params: { steps: "not an array" } }], "T1"), null);
  assert.deepEqual(planSteps({ steps: [{ text: "from text", status: "pending" }, { nothing: true }] }), [{ step: "from text", status: "pending" }]);
});

test("the turn strip reads oldest-first and keeps the statuses verbatim", () => {
  const strip = turnStrip([
    { id: "t3", status: "inProgress" },
    { id: "t2", status: "failed" },
    { id: "t1", status: "completed" },
  ], 8);
  assert.deepEqual(strip, [
    { id: "t1", status: "completed" },
    { id: "t2", status: "failed" },
    { id: "t3", status: "inProgress" },
  ]);
  assert.deepEqual(turnStrip([], 3), []);
});
