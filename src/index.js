/**
 * dsh-codex-bridge — observe and steer a Codex (OpenAI) session from DeepSeek Harness.
 *
 * The bridge speaks the Codex `app-server` protocol over stdio, which is the same
 * protocol the Codex app itself uses. That gives three things plain disk-reading
 * cannot: a live notification stream (agent message / reasoning summary / command
 * output deltas), the inbound approval channel, and a supported way to hand a
 * message to a session that another process is currently running.
 *
 * What each of those is actually worth in a cross-process setup is documented in
 * docs/limitations.md — read it before trusting the approval channel.
 *
 * @module dsh-codex-bridge
 */
import z from "@deepseek-ai/schemastery";
import { mountBoardChannel } from "./board-channel.js";
import { CodexBridge } from "./bridge.js";
import { allTools } from "./tools/index.js";

/** Loader plugin name. */
export const name = "codex-bridge";

/** Services this plugin consumes. */
export const inject = ["tools"];

/** Plugin configuration. */
export const Config = z.object({
  /** Explicit path to the codex executable; empty means auto-detect. */
  binary: z.string().default(""),
  /** Milliseconds to wait for one app-server response. */
  requestTimeoutMs: z.number().default(30000),
});

/**
 * Surface a channel problem without failing plugin activation.
 *
 * The duplicate-route warning is expected on a live patch reload (the copy that
 * already owns the route keeps serving), so it is not worth a console line.
 *
 * @param level - `"warn"` or `"error"`.
 * @param message - what happened.
 */
function reportChannelIssue(level, message) {
  if (level === "warn" && /yielded to a live copy/.test(message)) return;
  console.warn(`[dsh-codex-bridge] ${message}`);
}

/**
 * Register the bridge tools and the board route on one plugin context.
 * @param ctx - the cordis plugin context.
 * @param config - plugin configuration.
 */
export function apply(ctx, config = {}) {
  const bridge = new CodexBridge(config);
  const tools = allTools(bridge, { timeoutMs: config.requestTimeoutMs ?? 30000 });

  try {
    ctx.on?.("dispose", () => bridge.dispose());
  } catch {
    /* older contexts may not expose lifecycle events */
  }

  for (const tool of tools) ctx.tools.register(tool);

  try {
    mountBoardChannel(ctx, bridge, { log: reportChannelIssue });
  } catch (error) {
    reportChannelIssue("error", `board channel not mounted: ${String(error?.message ?? error)}`);
  }
}

export { ACTIVE_WRITER, ACTIVE_WRITER_HINT, isActiveWriterError } from "./errors.js";
export { CodexAppServer, newClientMessageId, resolveCodexBin } from "./app-server.js";
export { clamp, compactLimits, extractText, listCodexProcesses, listItems, listThreads, readAccountState, renderItem, resolveThreadId } from "./codex.js";
export { BOARD_COLUMNS, buildBoard, collectBoard, observeTurnState } from "./board.js";
export { RPC_CHANNEL, RPC_ROUTE, createRouteHandler, mountBoardChannel } from "./board-channel.js";
export { TOOL_NAMES } from "./tools/index.js";
