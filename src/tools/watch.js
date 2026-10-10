/**
 * `codex_watch` — observe a turn while it is in flight.
 *
 * Two sources are merged, because neither is sufficient alone:
 *  - the notification stream, which is the only place live deltas appear, but
 *    which only reaches the connection that owns the turn (see docs/limitations.md);
 *  - polling `thread/items/list`, which always works, and is what catches a turn
 *    the desktop app is running.
 *
 * @module dsh-codex-bridge/tools/watch
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { clamp, listItems, resolveThreadId } from "../codex.js";
import { LIVE_DELTA_METHODS, LIVE_MARKER_METHODS, describeNotification } from "../notifications.js";

/** How long a single watch call may run. */
const MAX_SECONDS = 120;

/** How often to poll the transcript while watching. */
const POLL_INTERVAL_MS = 1200;

/**
 * Build the watch tool.
 * @param bridge - the shared bridge.
 * @returns a tool definition.
 */
export function watchTool(bridge) {
  return defineTool({
    name: "codex_watch",
    description:
      "Watch a Codex session live for a few seconds and return what streamed past: agent message "
      + "deltas, reasoning summary deltas (the closest thing to Codex's live thinking), plan updates, "
      + "command output, and new transcript items. This is the only way to see a Codex turn that is "
      + "in flight before it is written to disk. Returns as soon as the budget elapses.",
    parameters: {
      threadId: { type: "string", description: "Codex thread id. Omit to use the newest thread for this project." },
      seconds: { type: "integer", description: "How long to watch, 1-120 (default 20)." },
      maxEvents: { type: "integer", description: "Stop early after this many events (default 120)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          threadId: { type: "string", required: true },
          watchedMs: { type: "integer", required: true },
          events: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                source: { type: "string", required: true },
                method: { type: "string", required: true },
                text: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.events.length
          ? `thread ${value.threadId} · ${value.watchedMs}ms\n` + value.events.map((e) => `[${e.source}] ${e.method}${e.text ? `: ${e.text}` : ""}`).join("\n")
          : `thread ${value.threadId} · ${value.watchedMs}ms · no activity observed`,
      }],
    },
    async execute(args) {
      const seconds = Math.min(Math.max(args.seconds ?? 20, 1), MAX_SECONDS);
      const maxEvents = args.maxEvents ?? 120;
      const cwd = process.cwd();
      return bridge.withClient(async (client) => {
        const threadId = await resolveThreadId(client, { threadId: args.threadId, cwd });
        if (!threadId) throw new Error("no codex thread found");
        const events = [];
        const onNotification = (message) => {
          if (events.length >= maxEvents) return;
          const params = message.params ?? {};
          const belongs = params.threadId === undefined || params.threadId === threadId;
          if (!belongs) return;
          if (!LIVE_DELTA_METHODS.has(message.method) && !LIVE_MARKER_METHODS.has(message.method)) return;
          events.push({
            source: "stream",
            method: message.method,
            text: clamp(describeNotification(message.method, params), 400),
          });
        };
        client.on("notification", onNotification);
        const started = Date.now();
        try {
          const known = new Set();
          const seed = await listItems(client, { threadId, limit: 30, sortDirection: "desc" });
          for (const item of seed.items) if (item.itemId) known.add(item.itemId);

          const deadline = started + seconds * 1000;
          while (Date.now() < deadline && events.length < maxEvents) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            try {
              // The poll is what catches a turn owned by another client, which never
              // sends this connection a notification.
              const polled = await listItems(client, { threadId, limit: 15, sortDirection: "desc" });
              for (const item of polled.items.slice().reverse()) {
                if (!item.itemId || known.has(item.itemId)) continue;
                known.add(item.itemId);
                events.push({ source: "transcript", method: item.type, text: clamp(item.text, 600) });
              }
            } catch (error) {
              events.push({ source: "error", method: "thread/items/list", text: String(error?.message ?? error) });
              break;
            }
          }
        } finally {
          client.off("notification", onNotification);
        }
        return { threadId, watchedMs: Date.now() - started, events: events.slice(0, maxEvents) };
      });
    },
    presentCall: (args) => ({ card: "generic", title: `Watch codex ${args.seconds ?? 20}s`, kind: "other" }),
  });
}
