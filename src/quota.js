/**
 * Codex budget: the account's own answer to "is Codex out of quota", kept
 * separate from percentages because percentages are advisory.
 *
 * The honest predicate (verified against a live app-server, see
 * docs/limitations.md §12) is, in order:
 *
 *   1. `ordinaryUsageAllowed === false` — the backend's final say. The schema's
 *      own wording: "Null means unavailable; clients must not infer recovery
 *      from percentages or reset times."
 *   2. `spendControlReached === true` on any bucket.
 *   3. `rateLimitReachedType !== null` on any bucket.
 *   4. otherwise `usedPercent >= warnPct` is a *warning*, not a limit.
 *
 * Deliberately NOT used as a limit: `usedPercent >= 100`, `credits.balance ===
 * "0"` (normal for a non-unlimited plan), and anything derived from `resetsAt`.
 *
 * @module dsh-codex-bridge/quota
 */

/** Default advisory threshold, in percent of the busiest window. */
export const DEFAULT_WARN_PCT = 80;

/** The levels this module reports. */
export const BUDGET_LEVELS = ["ok", "warn", "reached", "unknown"];

/** `rateLimitReachedType` values the protocol defines. */
export const REACHED_TYPES = [
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
];

/**
 * Turn one `account/rateLimits/read` result into the shape the panel and the
 * tools quote from.
 *
 * @param limitsResult - the raw result, or an `{ error }` record.
 * @param options - `{ warnPct, now }`.
 * @returns a budget record; `level: "unknown"` when the read failed.
 */
export function budgetFromLimits(limitsResult, options = {}) {
  const warnPct = Number.isFinite(options.warnPct) ? options.warnPct : DEFAULT_WARN_PCT;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const checkedAt = new Date(now).toISOString();
  const error = limitsResult?.error ? String(limitsResult.error) : null;
  const single = limitsResult?.rateLimits ?? null;
  const byId = limitsResult?.rateLimitsByLimitId ?? null;

  if (error || !single) {
    const unknown = {
      checkedAt, level: "unknown", reason: error ? `the account read failed: ${error}` : "the account did not report rate limits", warnPct,
      ordinaryUsageAllowed: null, rateLimitReachedType: null, spendControlReached: null, planType: null,
      maxUsedPercent: null, windows: [], resetCredits: { availableCount: null, credits: [] }, error,
    };
    return { ...unknown, line: budgetLine(unknown) };
  }

  // Prefer the per-limit-id view; fall back to the single legacy bucket. The two
  // happen to hold the same content today, which is exactly why the code must
  // not assume they always will.
  const buckets = byId && typeof byId === "object" && Object.keys(byId).length > 0
    ? Object.entries(byId).map(([limitId, value]) => ({ limitId, ...value }))
    : Object.entries({ [single.limitId ?? "codex"]: single }).map(([limitId, value]) => ({ limitId, ...value }));

  const windows = [];
  for (const bucket of buckets) {
    for (const which of ["primary", "secondary"]) {
      const window = bucket[which];
      if (!window) continue;
      windows.push({
        limitId: bucket.limitId ?? null,
        which,
        usedPercent: Number.isFinite(window.usedPercent) ? window.usedPercent : null,
        windowMins: Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null,
        resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
        resetsAtISO: Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000).toISOString() : null,
        rateLimitReachedType: bucket.rateLimitReachedType ?? null,
        spendControlReached: bucket.spendControlReached ?? null,
      });
    }
  }

  const ordinaryUsageAllowed = limitsResult.ordinaryUsageAllowed ?? null;
  const spendControlReached = buckets.some((bucket) => bucket.spendControlReached === true) ? true
    : buckets.every((bucket) => bucket.spendControlReached === false) ? false : null;
  const reachedType = buckets.map((bucket) => bucket.rateLimitReachedType).find((value) => value != null) ?? null;
  const usedPercents = windows.map((window) => window.usedPercent).filter((value) => Number.isFinite(value));
  const maxUsedPercent = usedPercents.length > 0 ? Math.max(...usedPercents) : null;

  const credits = Array.isArray(limitsResult.rateLimitResetCredits?.credits)
    ? limitsResult.rateLimitResetCredits.credits.map((credit) => ({
      id: credit.id ?? null,
      title: credit.title ?? null,
      resetType: credit.resetType ?? null,
      status: credit.status ?? null,
      expiresAt: Number.isFinite(credit.expiresAt) ? credit.expiresAt : null,
      expiresAtISO: Number.isFinite(credit.expiresAt) ? new Date(credit.expiresAt * 1000).toISOString() : null,
    }))
    : [];

  const { level, reason } = classify({ ordinaryUsageAllowed, spendControlReached, reachedType, maxUsedPercent, warnPct });
  const budget = {
    checkedAt,
    level,
    reason,
    warnPct,
    ordinaryUsageAllowed,
    rateLimitReachedType: reachedType,
    spendControlReached,
    planType: single.planType ?? buckets[0]?.planType ?? null,
    maxUsedPercent,
    windows,
    resetCredits: {
      availableCount: Number.isFinite(limitsResult.rateLimitResetCredits?.availableCount) ? limitsResult.rateLimitResetCredits.availableCount : null,
      credits,
    },
    error: null,
  };
  // Every consumer gets the same one-line rendering, so the panel, the tool and
  // any future caller cannot drift apart on how a quota reads.
  return { ...budget, line: budgetLine(budget) };
}

/**
 * Decide the level from the signals, in the order the protocol deserves.
 * @param input - the projected signals.
 * @returns `{ level, reason }`.
 */
function classify({ ordinaryUsageAllowed, spendControlReached, reachedType, maxUsedPercent, warnPct }) {
  if (ordinaryUsageAllowed === false) {
    return { level: "reached", reason: "the account reports ordinaryUsageAllowed: false — included usage is over" };
  }
  if (spendControlReached === true) {
    return { level: "reached", reason: "spendControlReached is true — this workspace's spend control is at its ceiling" };
  }
  if (reachedType !== null) {
    return { level: "reached", reason: `rateLimitReachedType: ${reachedType}` };
  }
  if (Number.isFinite(maxUsedPercent) && maxUsedPercent >= warnPct) {
    return { level: "warn", reason: `the busiest window is at ${maxUsedPercent}% (warning threshold ${warnPct}%)` };
  }
  return {
    level: "ok",
    reason: ordinaryUsageAllowed === null
      ? "no limit reached, but the account did not report ordinaryUsageAllowed"
      : null,
  };
}

/**
 * Read the budget straight from a live app-server.
 * @param client - a started client.
 * @param options - `{ warnPct, timeoutMs }`.
 * @returns the budget record (never throws; a failed read is `level: "unknown"`).
 */
export async function readBudget(client, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const result = await client.call("account/rateLimits/read", {}, { timeoutMs })
    .catch((error) => ({ error: String(error?.message ?? error) }));
  return budgetFromLimits(result, options);
}

/**
 * One line for a reader: what the account said, and what it means.
 * @param budget - a budget record.
 * @returns a short string.
 */
export function budgetLine(budget) {
  if (!budget) return "quota: not read";
  if (budget.level === "unknown") return `quota: unknown (${budget.reason})`;
  const primary = budget.windows.find((window) => window.which === "primary" && window.usedPercent !== null);
  const secondary = budget.windows.find((window) => window.which === "secondary" && window.usedPercent !== null);
  const parts = [`quota: ${budget.level}`];
  if (primary) parts.push(`${primary.usedPercent}% of ${primary.windowMins ?? "?"}min`);
  if (secondary) parts.push(`${secondary.usedPercent}% weekly`);
  if (Number.isFinite(budget.resetCredits.availableCount)) parts.push(`${budget.resetCredits.availableCount} reset credits`);
  if (budget.level !== "ok" && budget.reason) parts.push(budget.reason);
  return parts.join(" · ");
}
