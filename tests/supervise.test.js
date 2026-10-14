/**
 * Supervision: the classifier that decides whether a stopped run may be picked
 * up again, and the brief that hands it back. The two real error strings below
 * are quoted from this machine's own threads, so the classifier is tested
 * against text Codex actually produced rather than invented text.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BRIEF_CHARS,
  classifyFailure,
  supervisionBrief,
  supervisionFingerprint,
} from "../src/supervise.js";
import { decideAutoContinue } from "../src/autopilot.js";

const NOW = 1_791_900_000_000;

/** A board card with only what the classifier reads. */
function card(patch = {}) {
  return {
    threadId: "01a0f288-2222-7222-8222-222222222222",
    state: "needs-human",
    lastTurnId: "turn-9",
    turnStatus: "failed",
    turnError: null,
    lastSpoken: null,
    lastSpokenPhase: null,
    turnItemCounts: { commandExecution: 3, agentMessage: 1 },
    ageMs: 2 * 24 * 3_600_000,
    failureAgeMs: 2 * 24 * 3_600_000,
    queuedCount: 0,
    waitingCount: 0,
    goal: null,
    lastItem: { type: "commandExecution", text: "$ npm test" },
    ...patch,
  };
}

const TRANSPORT = "Error running remote compact task: stream disconnected before completion: Transport error: network error: error decoding response body";
const USAGE_LIMIT = "You've hit your usage limit. To get more access now, send a request to your admin or try again on 2026-10-27 at 09:00.";

test("a turn that did not fail has no failure to classify", () => {
  const verdict = classifyFailure(card({ turnStatus: "completed", turnError: { message: USAGE_LIMIT } }));
  assert.equal(verdict.kind, null);
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.text, "");
});

test("the transport failure this machine actually recorded is retryable", () => {
  const verdict = classifyFailure(card({ turnError: { message: TRANSPORT } }));
  assert.equal(verdict.kind, "transient");
  assert.equal(verdict.retryable, true);
  assert.match(verdict.quoted, /stream disconnected before completion/);
  assert.match(verdict.text, /transient transport or network failure/);
  assert.match(verdict.matched, /error decoding response body/);
});

test("the usage-limit failure this machine actually recorded is never retried", () => {
  const verdict = classifyFailure(card({ turnError: { message: USAGE_LIMIT } }));
  assert.equal(verdict.kind, "quota");
  assert.equal(verdict.retryable, false);
  assert.match(verdict.text, /quota or rate limit/);
});

test("the specific kinds win over the transient catch-all", () => {
  // Both of these are wrapped in a compact task, and the wrapper is not the cause.
  assert.equal(classifyFailure(card({ turnError: { message: TRANSPORT } })).kind, "transient");
  assert.equal(classifyFailure(card({ turnError: { message: USAGE_LIMIT } })).kind, "quota");
  assert.equal(classifyFailure(card({ turnError: { message: "401 Unauthorized: invalid api key" } })).kind, "auth");
  assert.equal(classifyFailure(card({ turnError: { message: "context_length_exceeded: too many tokens" } })).kind, "context");
  assert.equal(classifyFailure(card({ turnError: { message: "the model returned a shape we cannot read" } })).kind, "unknown");
});

test("only the kinds that need no decision are retryable", () => {
  const retryable = ["transient", "context"];
  const cases = {
    transient: TRANSPORT,
    context: "maximum context length exceeded",
    quota: USAGE_LIMIT,
    auth: "403 forbidden",
    unknown: "something new went wrong",
  };
  for (const [kind, message] of Object.entries(cases)) {
    const verdict = classifyFailure(card({ turnError: { message } }));
    assert.equal(verdict.kind, kind);
    assert.equal(verdict.retryable, retryable.includes(kind), `${kind} retryable`);
  }
});

test("with no recorded error text the classifier still says it does not know", () => {
  const verdict = classifyFailure(card({ turnError: null }));
  assert.equal(verdict.kind, "unknown");
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.quoted, "");
  assert.match(verdict.retryHint, /does not recognise/);
});

test("the brief quotes the goal, Codex's own last words and the failure", () => {
  const brief = supervisionBrief(card({
    goal: { objective: "finish the migration", status: "active" },
    lastSpoken: "我先备份，然后跑测试。",
    lastSpokenPhase: "final_answer",
    turnError: { message: TRANSPORT },
  }));
  assert.match(brief, /^【DeepSeek Harness 监督续跑】/);
  assert.match(brief, /目标：finish the migration/);
  assert.match(brief, /「我先备份，然后跑测试。」/);
  assert.match(brief, /phase final_answer/);
  assert.match(brief, /turn turn-9 = failed（transient）/);
  assert.match(brief, /结束于 2 days 前/);
  assert.match(brief, /Codex 记录的错误原文：「.*stream disconnected before completion.*」/);
  assert.match(brief, /这个 turn 记录到的动作：commandExecution 3, agentMessage 1/);
  assert.match(brief, /这类失败可以直接重试，不必等人/);
  assert.match(brief, /直接继续执行，不要复述本消息/);
});

test("a brief for something a person must decide tells Codex not to retry", () => {
  const brief = supervisionBrief(card({ turnError: { message: USAGE_LIMIT }, goal: { objective: "o", status: "active" } }));
  assert.match(brief, /failed（quota）/);
  assert.match(brief, /不要重试，直接在回复里说清楚需要什么/);
  assert.doesNotMatch(brief, /可以直接重试/);
});

test("a brief says what is missing instead of inventing it", () => {
  const brief = supervisionBrief(card({ goal: null, lastSpoken: null, turnStatus: "interrupted", turnError: null }));
  assert.match(brief, /（这个线程没有记录目标）/);
  assert.match(brief, /没有留下可读的回复文字/);
  assert.match(brief, /turn turn-9 = interrupted/);
  assert.doesNotMatch(brief, /Codex 记录的错误原文/);
});

test("a queued backlog is mentioned, and the brief stays inside its budget", () => {
  const brief = supervisionBrief(card({ queuedCount: 2 }));
  assert.match(brief, /队列里还有 2 条消息没被消费/);
  const long = supervisionBrief(card({
    goal: { objective: "x".repeat(5_000) },
    lastSpoken: "y".repeat(5_000),
    turnError: { message: "z".repeat(5_000) },
  }));
  // clamp() cuts to the budget and then appends its "…[truncated N chars]" note.
  assert.ok(long.length <= BRIEF_CHARS + 40, `brief was ${long.length} chars`);
  assert.match(long, /\[truncated \d+ chars\]/);
});

test("the fingerprint separates one stuck turn from another and one cause from another", () => {
  const base = card({ turnError: { message: TRANSPORT } });
  assert.equal(supervisionFingerprint(base), supervisionFingerprint(card({ turnError: { message: TRANSPORT } })));
  assert.notEqual(supervisionFingerprint(base), supervisionFingerprint(card({ lastTurnId: "turn-10", turnError: { message: TRANSPORT } })));
  assert.notEqual(supervisionFingerprint(base), supervisionFingerprint(card({ turnError: { message: USAGE_LIMIT } })));
});

test("the autopilot picks up a retryable failure and hands back the brief", () => {
  const decision = decideAutoContinue(
    card({ failure: classifyFailure(card({ turnError: { message: TRANSPORT } })) }),
    { armed: true, expiresAt: NOW + 60_000, template: null },
    {},
    NOW,
  );
  assert.equal(decision.action, "send");
  assert.equal(decision.code, "send-supervised-retry");
  assert.match(decision.text, /transient transport or network failure/);
  assert.match(decision.message, /stream disconnected before completion/);
});

test("the autopilot leaves a failure a person must decide alone", () => {
  const decision = decideAutoContinue(
    card({ failure: classifyFailure(card({ turnError: { message: USAGE_LIMIT } })) }),
    { armed: true, expiresAt: NOW + 60_000 },
    {},
    NOW,
  );
  assert.equal(decision.action, "skip");
  assert.equal(decision.code, "state-needs-human");
  assert.match(decision.text, /A person is needed here/);
});

test("a blocked card keeps working, and a configured template still wins", () => {
  const blocked = { ...card({ state: "blocked", turnStatus: "completed", turnError: null }), failure: classifyFailure({ turnStatus: "completed" }) };
  const plain = decideAutoContinue(blocked, { armed: true, expiresAt: NOW + 60_000 }, {}, NOW);
  assert.equal(plain.action, "send");
  assert.equal(plain.code, "send");
  assert.match(plain.message, /^【DeepSeek Harness 监督续跑】/);

  const templated = decideAutoContinue(
    blocked,
    { armed: true, expiresAt: NOW + 60_000, template: "keep going on {objective}" },
    {},
    NOW,
  );
  assert.equal(templated.message, "keep going on (no objective recorded)");
});
