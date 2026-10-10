/**
 * Which `ServerNotification` methods carry signal, and how to squeeze a short
 * line out of one.
 *
 * Codex emits 82 notification methods; most of them are bookkeeping. These two
 * sets are the ones worth putting in front of a reader watching a live turn.
 *
 * @module dsh-codex-bridge/notifications
 */

/** Notification methods that carry meaningful live text. */
export const LIVE_DELTA_METHODS = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "item/fileChange/patchUpdated",
]);

/** Notification methods that mark structural progress. */
export const LIVE_MARKER_METHODS = new Set([
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "account/rateLimits/updated",
  "serverRequest/resolved",
]);

/**
 * Pull the printable text out of a notification payload.
 * @param method - notification method name.
 * @param params - notification parameters.
 * @returns a short human-readable string, or "" when the payload has no text.
 */
export function describeNotification(method, params = {}) {
  for (const key of ["delta", "text", "chunk", "message", "summary"]) {
    if (typeof params[key] === "string" && params[key]) return params[key];
  }
  if (params.item?.type) return `item ${params.item.type}`;
  if (params.status?.type) return `status ${params.status.type}`;
  if (params.tokenUsage) return `tokens ${JSON.stringify(params.tokenUsage).slice(0, 160)}`;
  return "";
}
