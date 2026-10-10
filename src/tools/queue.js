/**
 * `codex_queue` — inspect and cancel the messages waiting on a Codex thread.
 *
 * `thread/queue/add` is the only cross-process write path (see
 * docs/limitations.md), and a running session normally consumes a queued message
 * within moments, so cancellation is a race rather than an undo. This tool reports
 * what the server confirmed instead of assuming the delete landed.
 *
 * @module dsh-codex-bridge/tools/queue
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { clamp, extractText, resolveThreadId } from "../codex.js";

/** The actions this tool accepts. Anything else is a caller error, not a deletion. */
const ACTIONS = ["list", "delete"];

/**
 * Build the queue tool.
 * @param bridge - the shared bridge.
 * @param options - `{ timeoutMs }`.
 * @returns a tool definition.
 */
export function queueTool(bridge, options = {}) {
  const timeout = options.timeoutMs ?? 30_000;

  return defineTool({
    name: "codex_queue",
    description:
      "Inspect and cancel the messages queued for a Codex thread. action=list (default) shows what is "
      + "still waiting to be consumed. action=delete cancels one entry and needs both threadId and "
      + "queuedSubmissionId — the id codex_send reported when it queued the message. Cancellation is a "
      + "race, not an undo: a running session usually picks a queued message up within moments, so "
      + "delete reports whether the app-server actually confirmed the deletion rather than assuming it.",
    parameters: {
      action: { type: "string", description: "list (default) | delete. Any other value is rejected." },
      threadId: {
        type: "string",
        description:
          "Codex thread id. For action=list, omitting it uses the newest thread for this project; "
          + "action=delete requires it.",
      },
      queuedSubmissionId: { type: "string", description: "The queued submission id to cancel; required for action=delete." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", required: true },
          threadId: { type: "string", required: true },
          entries: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                text: { type: "string", required: true },
                clientUserMessageId: { type: "string", required: true },
              },
            },
          },
          deleted: { type: "boolean", required: true },
          note: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: [
          `action ${value.action} · thread ${value.threadId} · ${value.deleted ? "deleted" : `${value.entries.length} queued`}`,
          ...value.entries.map((entry) => `#${entry.id} ${entry.text}`),
          value.note,
        ].filter(Boolean).join("\n"),
      }],
    },
    async execute(args) {
      const action = args.action ?? "list";
      if (!ACTIONS.includes(action)) {
        throw new Error(`unknown action ${JSON.stringify(action)}: expected one of ${ACTIONS.join(", ")}`);
      }
      return bridge.withClient(async (client) => {
        if (action === "delete") {
          // A destructive call does not get to guess its target: unlike list, it
          // refuses to fall back to "the newest thread for this project".
          if (!args.threadId) throw new Error("action=delete requires threadId");
          if (!args.queuedSubmissionId) throw new Error("action=delete requires queuedSubmissionId");
          const result = await client.call("thread/queue/delete", {
            threadId: args.threadId,
            queuedSubmissionId: args.queuedSubmissionId,
          }, { timeoutMs: timeout });
          const deleted = result?.deleted === true;
          return {
            action,
            threadId: args.threadId,
            entries: [],
            deleted,
            note: deleted
              ? `cancelled ${args.queuedSubmissionId}`
              : `the app-server did not confirm deleting ${args.queuedSubmissionId} — the session may already have consumed it`,
          };
        }

        const threadId = await resolveThreadId(client, { threadId: args.threadId, cwd: process.cwd() });
        if (!threadId) throw new Error("no codex thread found");
        const result = await client.call("thread/queue/list", { threadId }, { timeoutMs: timeout });
        const entries = (result?.data ?? []).map((entry) => ({
          id: String(entry?.id ?? ""),
          text: clamp(extractText(entry?.input ?? entry?.text ?? entry) || "(no text)", 400),
          clientUserMessageId: String(entry?.clientUserMessageId ?? ""),
        }));
        return {
          action,
          threadId,
          entries,
          deleted: false,
          note: entries.length ? "" : "nothing queued",
        };
      });
    },
    presentCall: () => ({ card: "generic", title: "Codex queue", kind: "other" }),
  });
}
