/**
 * `codex_send` — hand a message to a Codex session.
 *
 * Three modes, and the ranking matters: `queue` is the only one guaranteed to
 * work against a session the desktop app is running. `turn` and `steer` need
 * this process to own the thread, which it generally cannot. See
 * docs/limitations.md.
 *
 * @module dsh-codex-bridge/tools/send
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { newClientMessageId } from "../app-server.js";
import { resolveThreadId } from "../codex.js";
import { ACTIVE_WRITER_HINT, isActiveWriterError } from "../errors.js";

/**
 * Build the send tool.
 * @param bridge - the shared bridge.
 * @param options - `{ timeoutMs }`.
 * @returns a tool definition.
 */
export function sendTool(bridge, options = {}) {
  const timeout = options.timeoutMs ?? 30_000;

  /** Add to the session queue — the cross-process write path. */
  const queue = async (client, threadId, input) => {
    const result = await client.call("thread/queue/add", {
      threadId,
      clientUserMessageId: newClientMessageId(),
      input,
    }, { timeoutMs: timeout });
    // Verified against a live app-server: the reply is
    // `{ queuedSubmission: { id, input, clientUserMessageId } }` — there is no
    // queue-order field, so report the id that does exist rather than inventing one.
    const submission = result?.queuedSubmission ?? result ?? {};
    return {
      threadId,
      mode: "queue",
      accepted: true,
      detail: submission.id
        ? `queued as ${submission.id}; the running Codex session will consume it`
        : "queued; the running Codex session will consume it",
    };
  };

  return defineTool({
    name: "codex_send",
    description:
      "Send a message to a Codex session. mode=queue (default) adds it to that session's queue: this is "
      + "the safe way to steer a Codex turn another process is running, and Codex picks it up as soon as "
      + "it can. mode=turn resumes the thread into this bridge and starts a turn immediately, and "
      + "mode=steer redirects an in-flight turn (requires turnId). Use this to hand Codex a correction, "
      + "a review finding, or the next step. Note: the Codex desktop app holds a write lock on every "
      + "thread it has open, so turn/steer usually report unavailable and fall back to the queue.",
    parameters: {
      message: { type: "string", description: "The message text to send.", required: true },
      threadId: { type: "string", description: "Codex thread id. Omit to use the newest thread for this project." },
      mode: { type: "string", description: "queue (default) | turn | steer." },
      turnId: { type: "string", description: "Required for mode=steer." },
      model: { type: "string", description: "Model override for mode=turn." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          threadId: { type: "string", required: true },
          mode: { type: "string", required: true },
          accepted: { type: "boolean", required: true },
          detail: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `${value.accepted ? "accepted" : "rejected"} · ${value.mode} → thread ${value.threadId}${value.detail ? `\n${value.detail}` : ""}`,
      }],
    },
    async execute(args) {
      const cwd = process.cwd();
      const mode = args.mode ?? "queue";
      return bridge.withClient(async (client) => {
        const threadId = await resolveThreadId(client, { threadId: args.threadId, cwd });
        if (!threadId) throw new Error("no codex thread found");
        const input = [{ type: "text", text: args.message }];

        if (mode === "queue") return queue(client, threadId, input);

        if (mode === "steer") {
          if (!args.turnId) throw new Error("mode=steer requires turnId");
          try {
            await client.call("turn/steer", {
              threadId,
              expectedTurnId: args.turnId,
              clientUserMessageId: newClientMessageId(),
              input,
            }, { timeoutMs: timeout });
          } catch (error) {
            if (isActiveWriterError(error)) return { threadId, mode, accepted: false, detail: ACTIVE_WRITER_HINT };
            throw error;
          }
          return { threadId, mode, accepted: true, detail: `steered turn ${args.turnId}` };
        }

        // mode=turn needs this bridge to own the thread. When the lock is taken,
        // queueing is the honest fallback rather than a hard failure.
        try {
          await client.call("thread/resume", { threadId }, { timeoutMs: timeout });
        } catch (error) {
          if (!isActiveWriterError(error)) throw error;
          const queued = await queue(client, threadId, input);
          return {
            ...queued,
            detail: `mode=turn unavailable → ${ACTIVE_WRITER_HINT} Fell back to the queue — ${queued.detail}`,
          };
        }
        const result = await client.call("turn/start", {
          threadId,
          input,
          ...(args.model ? { model: args.model } : {}),
        }, { timeoutMs: timeout });
        return {
          threadId,
          mode: "turn",
          accepted: true,
          detail: `turn ${result?.turn?.id ?? "started"}`,
        };
      });
    },
    presentCall: () => ({ card: "generic", title: "Send to Codex", kind: "other" }),
  });
}
