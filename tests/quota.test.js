/**
 * The quota rule is the part that decides whether a project gets taken over, so
 * it is tested against the signals the protocol actually reports — including the
 * ones that must NOT count as a limit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WARN_PCT, BUDGET_LEVELS, budgetFromLimits, budgetLine } from "../src/quota.js";

/** A live-shaped rate-limit read. @param over - fields to override. @returns a result. */
function limits(over = {}) {
  const primary = { usedPercent: 12, windowDurationMins: 300, resetsAt: 1792000000, ...(over.primary ?? {}) };
  const bucket = {
    limitId: "codex",
    primary,
    secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1792600000, ...(over.secondary ?? {}) },
    planType: "plus",
    rateLimitReachedType: null,
    spendControlReached: null,
    ...(over.bucket ?? {}),
  };
  const result = {
    rateLimits: bucket,
    rateLimitsByLimitId: { codex: bucket },
    rateLimitResetCredits: { availableCount: 2, credits: [{ id: "c1", title: "Full reset", expiresAt: 1793000000, status: "available" }] },
    ordinaryUsageAllowed: true,
    ...(over.result ?? {}),
  };
  return result;
}

test("a healthy account reads as ok and keeps its numbers", () => {
  const budget = budgetFromLimits(limits(), { now: 1791900000000 });
  assert.equal(budget.level, "ok");
  assert.equal(budget.planType, "plus");
  assert.equal(budget.maxUsedPercent, 12);
  assert.deepEqual(budget.windows.map((window) => `${window.which}:${window.usedPercent}`), ["primary:12", "secondary:9"]);
  assert.equal(budget.resetCredits.availableCount, 2);
  assert.match(budget.resetCredits.credits[0].expiresAtISO, /^20/);
  assert.equal(budget.error, null);
});

test("ordinaryUsageAllowed:false is the account's final word", () => {
  const budget = budgetFromLimits(limits({ result: { ordinaryUsageAllowed: false } }));
  assert.equal(budget.level, "reached");
  assert.match(budget.reason, /ordinaryUsageAllowed: false/);
});

test("spendControlReached on any bucket is a limit even when the percentage looks fine", () => {
  const budget = budgetFromLimits(limits({ bucket: { spendControlReached: true, primary: { usedPercent: 3 } } }));
  assert.equal(budget.level, "reached");
  assert.match(budget.reason, /spendControlReached/);
});

test("rateLimitReachedType is quoted verbatim", () => {
  const budget = budgetFromLimits(limits({ bucket: { rateLimitReachedType: "workspace_member_usage_limit_reached" } }));
  assert.equal(budget.level, "reached");
  assert.equal(budget.rateLimitReachedType, "workspace_member_usage_limit_reached");
  assert.match(budget.reason, /workspace_member_usage_limit_reached/);
});

test("a high percentage is only a warning, never a limit", () => {
  const budget = budgetFromLimits(limits({ primary: { usedPercent: 97 } }));
  assert.equal(budget.level, "warn");
  assert.match(budget.reason, /97%/);
  assert.equal(budget.ordinaryUsageAllowed, true);
});

test("100% without a reached signal stays a warning — the schema forbids inferring recovery or a limit from percentages", () => {
  const budget = budgetFromLimits(limits({ primary: { usedPercent: 100 } }));
  assert.equal(budget.level, "warn");
});

test("a failed read is unknown, not ok", () => {
  const budget = budgetFromLimits({ error: "connection reset" }, { now: 1791900000000 });
  assert.equal(budget.level, "unknown");
  assert.match(budget.reason, /connection reset/);
  assert.equal(budget.maxUsedPercent, null);
  assert.equal(budget.checkedAt, "2026-10-13T14:00:00.000Z");
});

test("a result with no rateLimits at all is unknown too", () => {
  const budget = budgetFromLimits({});
  assert.equal(budget.level, "unknown");
  assert.match(budget.reason, /did not report rate limits/);
});

test("the per-limit-id view wins over the legacy single bucket when both are present", () => {
  const result = limits({ primary: { usedPercent: 12 } });
  result.rateLimitsByLimitId = {
    codex: { limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 300 }, secondary: null, rateLimitReachedType: null, spendControlReached: null },
    "codex-other": { limitId: "codex-other", primary: { usedPercent: 55, windowDurationMins: 60 }, secondary: null, rateLimitReachedType: null, spendControlReached: null },
  };
  const budget = budgetFromLimits(result);
  assert.equal(budget.maxUsedPercent, 55);
  assert.deepEqual(budget.windows.map((window) => window.limitId), ["codex", "codex-other"]);
});

test("the warn threshold is configurable and reported", () => {
  const budget = budgetFromLimits(limits({ primary: { usedPercent: 40 } }), { warnPct: 30 });
  assert.equal(budget.level, "warn");
  assert.equal(budget.warnPct, 30);
  assert.equal(DEFAULT_WARN_PCT, 80);
});

test("levels are exactly the four the panel colours", () => {
  assert.deepEqual(BUDGET_LEVELS, ["ok", "warn", "reached", "unknown"]);
  for (const over of [{}, { result: { ordinaryUsageAllowed: false } }, { primary: { usedPercent: 99 } }, { result: { ordinaryUsageAllowed: false } }]) {
    assert.ok(BUDGET_LEVELS.includes(budgetFromLimits(limits(over)).level));
  }
});

test("budgetLine says what was read and, when it matters, why", () => {
  assert.equal(budgetLine(budgetFromLimits(limits())), "quota: ok · 12% of 300min · 9% weekly · 2 reset credits");
  assert.match(budgetLine(budgetFromLimits(limits({ result: { ordinaryUsageAllowed: false } }))), /^quota: reached/);
  assert.match(budgetLine(budgetFromLimits({ error: "boom" })), /^quota: unknown \(the account read failed: boom\)$/);
  assert.equal(budgetLine(null), "quota: not read");
});

test("the projection carries its own one-line rendering, so no caller can drift", () => {
  const budget = budgetFromLimits(limits());
  assert.equal(budget.line, "quota: ok · 12% of 300min · 9% weekly · 2 reset credits");
  assert.equal(budget.line, budgetLine(budget), "the projection and the helper agree");
  // The failure path is a budget too: the panel shows it instead of a blank row.
  const failed = budgetFromLimits({ error: "boom" });
  assert.match(failed.line, /^quota: unknown \(the account read failed: boom\)$/);
});
