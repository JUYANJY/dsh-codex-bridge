/**
 * `codex_budget` — the signed-in account's own answer to "is Codex out of
 * quota", with the fields that make that answer checkable.
 *
 * @module dsh-codex-bridge/tools/budget
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DEFAULT_WARN_PCT, budgetLine, readBudget } from "../quota.js";

/**
 * Build the budget tool.
 * @param bridge - the shared bridge.
 * @param options - `{ timeoutMs, warnPct }`.
 * @returns a tool definition.
 */
export function budgetTool(bridge, options = {}) {
  const timeout = options.timeoutMs ?? 30_000;
  const defaultWarnPct = options.warnPct ?? DEFAULT_WARN_PCT;

  return defineTool({
    name: "codex_budget",
    description:
      "Read the local Codex account's real quota state — the account's own verdict, not a guess from "
      + "percentages. level=reached means the backend says included usage is over (ordinaryUsageAllowed "
      + "false, spendControlReached, or rateLimitReachedType); level=warn is only an advisory percentage "
      + "threshold. Check this before starting long Codex work, before arming the autopilot, and when "
      + "deciding whether DeepSeek Harness should take a Codex project over (codex_handoff).",
    parameters: {
      warnPct: { type: "number", description: `Advisory warning threshold in percent (default ${defaultWarnPct}).` },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          level: { type: "string", required: true },
          reason: { type: "string", required: true },
          line: { type: "string", required: true },
          planType: { type: "string", required: true },
          ordinaryUsageAllowed: { type: "string", required: true },
          rateLimitReachedType: { type: "string", required: true },
          spendControlReached: { type: "string", required: true },
          maxUsedPercent: { type: "integer", required: true },
          warnPct: { type: "integer", required: true },
          windows: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                limitId: { type: "string", required: true },
                which: { type: "string", required: true },
                usedPercent: { type: "integer", required: true },
                windowMins: { type: "integer", required: true },
                resetsAt: { type: "string", required: true },
              },
            },
          },
          resetCreditsAvailable: { type: "integer", required: true },
          resetCreditExpiries: { type: "array", required: true, items: { type: "string" } },
          error: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: [
          value.line,
          `level: ${value.level}${value.reason ? ` — ${value.reason}` : ""}`,
          `plan: ${value.planType || "unknown"} · ordinaryUsageAllowed: ${value.ordinaryUsageAllowed}`
            + ` · spendControlReached: ${value.spendControlReached}`
            + `${value.rateLimitReachedType ? ` · rateLimitReachedType: ${value.rateLimitReachedType}` : ""}`,
          ...value.windows.map((window) => `  ${window.limitId}/${window.which}: ${window.usedPercent}% of ${window.windowMins}min, resets ${window.resetsAt}`),
          value.resetCreditsAvailable >= 0
            ? `reset credits: ${value.resetCreditsAvailable}${value.resetCreditExpiries.length ? ` (expire ${value.resetCreditExpiries.join(", ")})` : ""}`
            : "reset credits: not reported",
          ...(value.error ? [`error: ${value.error}`] : []),
        ].join("\n"),
      }],
    },
    async execute(args) {
      const warnPct = Number.isFinite(args.warnPct) ? args.warnPct : defaultWarnPct;
      return bridge.withClient(async (client) => {
        const budget = await readBudget(client, { warnPct, timeoutMs: timeout });
        return {
          level: budget.level,
          reason: budget.reason ?? "",
          line: budgetLine(budget),
          planType: budget.planType ?? "",
          ordinaryUsageAllowed: budget.ordinaryUsageAllowed === null ? "not reported" : String(budget.ordinaryUsageAllowed),
          rateLimitReachedType: budget.rateLimitReachedType ?? "",
          spendControlReached: budget.spendControlReached === null ? "not reported" : String(budget.spendControlReached),
          maxUsedPercent: Number.isFinite(budget.maxUsedPercent) ? budget.maxUsedPercent : -1,
          warnPct: budget.warnPct,
          windows: budget.windows.map((window) => ({
            limitId: window.limitId ?? "codex",
            which: window.which,
            usedPercent: Number.isFinite(window.usedPercent) ? window.usedPercent : -1,
            windowMins: Number.isFinite(window.windowMins) ? window.windowMins : -1,
            resetsAt: window.resetsAtISO ?? "",
          })),
          resetCreditsAvailable: Number.isFinite(budget.resetCredits.availableCount) ? budget.resetCredits.availableCount : -1,
          resetCreditExpiries: budget.resetCredits.credits.map((credit) => `${credit.title ?? credit.id ?? "credit"} expires ${credit.expiresAtISO ?? "?"}`),
          error: budget.error ?? "",
        };
      });
    },
    presentCall: () => ({ card: "generic", title: "Codex quota", kind: "other" }),
  });
}
