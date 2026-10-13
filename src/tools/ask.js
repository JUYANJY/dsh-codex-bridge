/**
 * `codex_ask` — ask Codex a direction question on a throwaway thread with the
 * strongest model available, then (by default) hand its answer back to a
 * development thread **verbatim**.
 *
 * Why this shape (measured, see docs/research/pm-review-quick-chat-and-quota-handoff.md):
 *  - the fast-chat flow is `thread/start { ephemeral: true }` → `turn/start`;
 *  - a `thread/read` right after `turn/start` returns before the final answer
 *    exists (the upstream TUI showed an interim message that way), so the
 *    answer is taken from the completion signal, with a poll as a second path;
 *  - `thread/start` may ignore a `model` override, so the model that actually
 *    ran is reported next to the one requested, and an unhonoured override
 *    fails the call unless `allowOverride` is set;
 *  - the reply is relayed byte-for-byte: provenance and model metadata stay in
 *    this tool's result, never in the text Codex receives.
 *
 * @module dsh-codex-bridge/tools/ask
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { newClientMessageId } from "../app-server.js";
import { clamp, resolveThreadId } from "../codex.js";

/** How often the poll fallback re-reads the throwaway thread. */
export const ASK_POLL_MS = 1500;
/** Per-request timeout for the small app-server calls. */
const RPC_TIMEOUT_MS = 30_000;

/**
 * Build the direction-consult tool.
 * @param bridge - the shared bridge.
 * @param options - `{ model, effort, answerTimeoutMs, pollMs }`.
 * @returns a tool definition.
 */
export function askTool(bridge, options = {}) {
  const defaultModel = options.model ?? "";
  const defaultEffort = options.effort ?? "max";
  const defaultAnswerTimeoutMs = options.answerTimeoutMs ?? 180_000;
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : ASK_POLL_MS;

  return defineTool({
    name: "codex_ask",
    description:
      "Ask Codex a direction question on a throwaway (ephemeral) thread using the strongest configured "
      + "model and effort, then hand the answer back to a development thread VERBATIM by default. Use it "
      + "when you need Codex's own plan before implementing, or when Codex appears stuck and you want a "
      + "fresh direction to feed it. The reply is relayed byte-for-byte — no commentary is added to the "
      + "text Codex receives. Set feed:false to only read the answer.",
    parameters: {
      question: { type: "string", required: true, description: "The direction question, in Codex's own terms. Be specific about the goal and the constraints." },
      feedThreadId: { type: "string", description: "Thread to hand the answer to. Omit to resolve the newest thread for the working directory." },
      cwd: { type: "string", description: "Working directory for the throwaway thread (default: this session's directory)." },
      feed: { type: "boolean", description: "Hand the answer back to a development thread verbatim (default true)." },
      model: { type: "string", description: `Model for the question thread (default: the plugin's configured consult model, ${defaultModel || "none"}).` },
      effort: { type: "string", description: `Reasoning effort for the question thread (default ${defaultEffort}).` },
      allowOverride: { type: "boolean", description: "Proceed even when thread/start did not honour the requested model." },
      timeoutMs: { type: "number", description: `Give up waiting for the answer after this long (default ${defaultAnswerTimeoutMs}).` },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          reason: { type: "string", required: true },
          threadId: { type: "string", required: true },
          reply: { type: "string", required: true },
          replyChars: { type: "integer", required: true },
          requestedModel: { type: "string", required: true },
          modelReported: { type: "string", required: true },
          overrideHonoured: { type: "boolean", required: true },
          effort: { type: "string", required: true },
          answerSource: { type: "string", required: true },
          waitedMs: { type: "integer", required: true },
          notificationsSeen: { type: "integer", required: true },
          fed: { type: "boolean", required: true },
          fedThreadId: { type: "string", required: true },
          fedSubmissionId: { type: "string", required: true },
          feedDetail: { type: "string", required: true },
          detail: { type: "string", required: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          value.ok ? `Codex answered on throwaway thread ${value.threadId || "(unknown)"}.` : `No answer: ${value.reason}`,
          `model: requested ${value.requestedModel || "(default)"} · reported ${value.modelReported || "(not reported)"}`
            + `${value.overrideHonoured ? "" : " · OVERRIDE NOT HONOURED"}`,
          `effort: ${value.effort} · answer from ${value.answerSource} after ${value.waitedMs}ms · ${value.notificationsSeen} notification(s) seen`,
          value.fed ? `handed back verbatim to ${value.fedThreadId}${value.fedSubmissionId ? ` (submission ${value.fedSubmissionId})` : ""}` : "not fed back (feed:false)",
          ...(value.feedDetail ? [`feed: ${value.feedDetail}`] : []),
        ];
        if (value.reply) lines.push("", "─".repeat(12), value.reply);
        if (value.detail) lines.push("", value.detail);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const started = Date.now();
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) {
        return failure({ reason: "no question was given", requestedModel: args.model ?? defaultModel, effort: args.effort ?? defaultEffort, waitedMs: 0 });
      }
      const requestedModel = typeof args.model === "string" && args.model !== "" ? args.model : defaultModel;
      const effort = typeof args.effort === "string" && args.effort !== "" ? args.effort : defaultEffort;
      const answerTimeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : defaultAnswerTimeoutMs;
      const cwd = typeof args.cwd === "string" && args.cwd !== "" ? args.cwd : process.cwd();

      return bridge.withClient(async (client) => {
        const seen = [];
        let threadId = null;
        let settle = null;
        // The last diagnostic the server volunteered. Measured: a failed throwaway
        // turn reports its real cause here (and in turn/completed.turn.error), so a
        // failure is never described as merely "no agentMessage payload".
        let lastError = "";
        let threadStatus = "";
        const settled = new Promise((resolve) => { settle = resolve; });
        const forThisThread = (id) => !threadId || !id || id === threadId;
        const textOf = (value) => (typeof value === "string" ? value : "");

        const onNotification = (message) => {
          const method = message?.method;
          const params = message?.params ?? {};
          seen.push({ method, threadId: params.threadId ?? params.turn?.threadId ?? null });
          if (seen.length > 400) seen.splice(0, seen.length - 400);
          const id = params.threadId ?? params.turn?.threadId ?? null;
          if (!forThisThread(id)) return;
          if (method === "error") {
            lastError = textOf(params.error?.message) || textOf(params.message) || lastError;
          } else if (method === "thread/status/changed") {
            threadStatus = textOf(params.status?.type) || threadStatus;
          } else if (method === "item/completed" && params.item?.type === "agentMessage" && textOf(params.item.text).trim() !== "") {
            settle?.({ ok: true, reply: params.item.text, answerSource: "notification:item/completed" });
          } else if (method === "turn/completed") {
            const turn = params.turn ?? {};
            const inTurn = (Array.isArray(turn.items) ? turn.items : []).find((item) => item?.type === "agentMessage" && textOf(item.text).trim() !== "");
            if (inTurn) {
              settle?.({ ok: true, reply: inTurn.text, answerSource: "notification:turn/completed" });
            } else {
              settle?.({
                ok: false,
                reply: "",
                answerSource: "notification:turn/completed",
                reason: turn.status === "failed"
                  ? `the turn failed: ${textOf(turn.error?.message) || lastError || "no detail"}`
                  : `the turn completed without an agentMessage payload${lastError ? `: ${lastError}` : ""}`,
              });
            }
          } else if (method === "turn/failed") {
            settle?.({ ok: false, reply: "", answerSource: "notification:turn/failed", reason: String(params.error?.message ?? params.error?.codexErrorInfo ?? "the turn failed") });
          }
        };
        client.on("notification", onNotification);

        const timer = setTimeout(() => {
          settle?.({
            ok: false,
            reply: "",
            answerSource: "timeout",
            reason: `no answer within ${answerTimeoutMs}ms${lastError ? ` (last diagnostic: ${lastError})` : ""}`,
          });
        }, answerTimeoutMs);
        timer.unref?.();

        // Reading the thread back is a second, independent path to the answer.
        // Measured: a throwaway thread refuses both read paths (`ephemeral threads
        // do not support thread/turns/list`, `thread/items/list is not supported
        // yet`), so there it only reports status; a non-ephemeral thread also gets
        // the answer read from its recorded turns.
        const poll = setInterval(async () => {
          if (!threadId) return;
          try {
            const read = await client.call("thread/read", { threadId }, { timeoutMs: RPC_TIMEOUT_MS });
            const thread = read?.thread ?? null;
            const status = thread?.status?.type ?? null;
            if (status === "systemError") {
              settle?.({
                ok: false, reply: "", answerSource: "poll:thread/read",
                reason: `the thread reported systemError${lastError ? `: ${lastError}` : ""}`,
              });
              return;
            }
            if (thread?.ephemeral) return;
          } catch {
            // No thread/read on this server: the turn read below is still worth a try.
          }
          try {
            const result = await client.call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "summary" }, { timeoutMs: RPC_TIMEOUT_MS });
            const turn = result?.data?.[0];
            if (!turn) return;
            const messages = (Array.isArray(turn.items) ? turn.items : []).filter((item) => item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim() !== "");
            const final = messages.filter((item) => item.phase === "final_answer").at(-1) ?? null;
            const terminal = ["completed", "failed", "interrupted", "cancelled"].includes(turn.status);
            if (final) {
              settle?.({ ok: true, reply: final.text, answerSource: "poll:thread/turns/list" });
            } else if (terminal) {
              settle?.({
                ok: false,
                reply: "",
                answerSource: "poll:thread/turns/list",
                reason: turn.status === "failed"
                  ? `the turn failed: ${turn.error?.message ?? turn.error?.codexErrorInfo ?? "no detail"}`
                  : `the turn ended as ${turn.status} without a final answer`,
              });
            }
          } catch {
            // The poll is a fallback; a failing read must not end the wait.
          }
        }, pollMs);
        poll.unref?.();

        try {
          let startedTurn;
          try {
            startedTurn = await client.call("thread/start", {
              ephemeral: true,
              cwd,
              ...(requestedModel ? { model: requestedModel } : {}),
            }, { timeoutMs: RPC_TIMEOUT_MS });
          } catch (error) {
            return failure({
              reason: `thread/start failed: ${String(error?.message ?? error)}`,
              requestedModel, effort, waitedMs: Date.now() - started, seen: seen.length, detail: "The throwaway thread could not be created, so nothing was asked.",
            });
          }
          threadId = startedTurn?.thread?.id ?? null;
          if (!threadId) {
            return failure({ reason: "thread/start did not return a thread id", requestedModel, effort, waitedMs: Date.now() - started, seen: seen.length });
          }
          const modelReported = typeof startedTurn?.model === "string" ? startedTurn.model : "";
          const overrideHonoured = !requestedModel || modelReported === "" || modelReported === requestedModel;
          if (!overrideHonoured && args.allowOverride !== true) {
            return {
              ok: false,
              reason: `thread/start honoured model ${modelReported}, not the requested ${requestedModel}`,
              threadId,
              reply: "",
              replyChars: 0,
              requestedModel,
              modelReported,
              overrideHonoured: false,
              effort,
              answerSource: "none",
              waitedMs: Date.now() - started,
              notificationsSeen: seen.length,
              fed: false,
              fedThreadId: "",
              fedSubmissionId: "",
              feedDetail: "",
              detail: "Nothing was asked: the strong model could not be confirmed. Pass allowOverride:true to ask anyway, or set the plugin's consultModel config to a model this account can use.",
            };
          }

          try {
            await client.call("turn/start", {
              threadId,
              effort,
              clientUserMessageId: newClientMessageId(),
              input: [{ type: "text", text: question }],
            }, { timeoutMs: RPC_TIMEOUT_MS });
          } catch (error) {
            return failure({ reason: `turn/start failed: ${String(error?.message ?? error)}`, threadId, requestedModel, modelReported, overrideHonoured, effort, waitedMs: Date.now() - started, seen: seen.length });
          }

          const answer = await settled;
          const waitedMs = Date.now() - started;
          if (!answer.ok || !answer.reply) {
            // A failure a reader can act on: the provider's own words, the thread
            // status, and which notifications did arrive.
            const diagnostics = [
              lastError ? `server error: ${lastError.slice(0, 400)}` : "",
              threadStatus ? `thread status: ${threadStatus}` : "",
              `notifications: ${[...new Set(seen.map((entry) => entry.method))].slice(0, 12).join(", ") || "none"}`,
            ].filter(Boolean).join(" · ");
            return failure({
              reason: answer.reason ?? "no answer arrived",
              threadId, requestedModel, modelReported, overrideHonoured, effort,
              answerSource: answer.answerSource, waitedMs, seen: seen.length,
              detail: [answer.reply ? "A partial reply arrived but no final answer did." : "", diagnostics].filter(Boolean).join("\n"),
            });
          }

          const reply = answer.reply;
          let fed = false;
          let fedThreadId = "";
          let fedSubmissionId = "";
          let feedDetail = "feeding was not requested (feed:false)";
          if (args.feed !== false) {
            try {
              const target = typeof args.feedThreadId === "string" && args.feedThreadId !== ""
                ? args.feedThreadId
                : await resolveThreadId(client, { cwd });
              if (!target) {
                feedDetail = "no development thread could be resolved for this directory, so the answer was not handed back";
              } else {
                const added = await client.call("thread/queue/add", {
                  threadId: target,
                  clientUserMessageId: newClientMessageId(),
                  input: [{ type: "text", text: reply }],
                }, { timeoutMs: RPC_TIMEOUT_MS });
                fed = true;
                fedThreadId = target;
                fedSubmissionId = added?.queuedSubmission?.id ?? "";
                feedDetail = `relayed verbatim (${reply.length} chars) to the thread's queue`;
              }
            } catch (error) {
              feedDetail = `the answer could not be handed back: ${String(error?.message ?? error)}`;
            }
          }

          return {
            ok: true,
            reason: "",
            threadId,
            reply: clamp(reply, 20_000),
            replyChars: reply.length,
            requestedModel,
            modelReported,
            overrideHonoured,
            effort,
            answerSource: answer.answerSource ?? "unknown",
            waitedMs,
            notificationsSeen: seen.length,
            fed,
            fedThreadId,
            fedSubmissionId,
            feedDetail,
            detail: "",
          };
        } finally {
          clearTimeout(timer);
          clearInterval(poll);
          client.off?.("notification", onNotification);
        }
      });
    },
    presentCall: (args) => ({ card: "generic", title: `Ask Codex: ${clamp(String(args.question ?? ""), 120)}`, kind: "other" }),
  });
}

/**
 * A failed result, in the shape the output schema requires.
 * @param input - the fields to fill.
 * @returns a complete failure record.
 */
function failure(input) {
  return {
    ok: false,
    reason: input.reason ?? "the question was not answered",
    threadId: input.threadId ?? "",
    reply: "",
    replyChars: 0,
    requestedModel: input.requestedModel ?? "",
    modelReported: input.modelReported ?? "",
    overrideHonoured: input.overrideHonoured ?? false,
    effort: input.effort ?? "",
    answerSource: input.answerSource ?? "none",
    waitedMs: input.waitedMs ?? 0,
    notificationsSeen: input.seen ?? 0,
    fed: false,
    fedThreadId: "",
    fedSubmissionId: "",
    feedDetail: "",
    detail: input.detail ?? "",
  };
}
