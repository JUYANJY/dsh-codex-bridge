/**
 * The tool set this plugin registers.
 * @module dsh-codex-bridge/tools
 */
import { approvalsTool } from "./approvals.js";
import { queueTool } from "./queue.js";
import { sendTool } from "./send.js";
import { statusTool } from "./status.js";
import { threadsTool } from "./threads.js";
import { transcriptTool } from "./transcript.js";
import { watchTool } from "./watch.js";

/** Every tool name this plugin owns, for install-time verification. */
export const TOOL_NAMES = [
  "codex_status",
  "codex_threads",
  "codex_transcript",
  "codex_watch",
  "codex_send",
  "codex_approvals",
  "codex_queue",
];

/**
 * Build every tool, bound to one bridge.
 * @param bridge - the shared bridge.
 * @param options - `{ timeoutMs }`.
 * @returns an array of tool definitions.
 */
export function allTools(bridge, options = {}) {
  return [
    statusTool(bridge),
    threadsTool(bridge),
    transcriptTool(bridge),
    watchTool(bridge),
    sendTool(bridge, options),
    approvalsTool(bridge),
    queueTool(bridge, options),
  ];
}
