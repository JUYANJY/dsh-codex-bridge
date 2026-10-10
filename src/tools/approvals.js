/**
 * `codex_approvals` — inspect and answer the inbound approval channel.
 *
 * This is the tool with the biggest gap between what the protocol looks like it
 * offers and what a foreign process actually gets. Approval questions are
 * `ServerRequest` frames, and app-server sends those only to the connection that
 * owns the turn. A bridge that merely attaches to the running app-server
 * therefore sees an empty queue; it can only approve turns it started itself
 * (i.e. `codex_send mode=turn` on a thread nothing else holds).
 *
 * @module dsh-codex-bridge/tools/approvals
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * Build the approvals tool.
 * @param bridge - the shared bridge.
 * @returns a tool definition.
 */
export function approvalsTool(bridge) {
  return defineTool({
    name: "codex_approvals",
    description:
      "List approval requests this bridge is holding from Codex, and answer them. Codex asks its client "
      + "before running a command it considers sensitive; only the client that owns the turn receives "
      + "those requests, so this queue is populated for turns this bridge started itself (codex_send "
      + "mode=turn) and stays empty for turns the Codex desktop app is running. action=list inspects the "
      + "queue; action=accept or action=decline answers one request (or every request when requestId is "
      + "omitted).",
    parameters: {
      action: { type: "string", description: "list (default) | accept | decline." },
      requestId: { type: "string", description: "Specific inbound request id to answer." },
      reason: { type: "string", description: "Reason recorded when declining." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", required: true },
          pending: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                method: { type: "string", required: true },
                ageMs: { type: "integer", required: true },
                summary: { type: "string", required: true },
              },
            },
          },
          answered: { type: "integer", required: true },
          note: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: [
          `action ${value.action} · answered ${value.answered}`,
          ...value.pending.map((p) => `#${p.id} ${p.method} (${p.ageMs}ms)\n   ${p.summary}`),
          value.note,
        ].filter(Boolean).join("\n"),
      }],
    },
    async execute(args) {
      const action = args.action ?? "list";
      return bridge.withClient(async (client) => {
        const describe = (request) => {
          const params = request.params ?? {};
          if (params.command) return `run: ${Array.isArray(params.command) ? params.command.join(" ") : params.command}`;
          if (params.itemId) return `item ${params.itemId} in thread ${params.threadId ?? "?"}`;
          return JSON.stringify(params).slice(0, 300);
        };
        const listPending = () => client.pendingServerRequests().map((request) => ({
          id: String(request.id),
          method: request.method,
          ageMs: Date.now() - request.receivedAt,
          summary: describe(request),
        }));
        if (action === "list") {
          return { action, pending: listPending(), answered: 0, note: "" };
        }
        const targets = client.pendingServerRequests().filter((request) =>
          args.requestId === undefined || String(request.id) === String(args.requestId));
        let answered = 0;
        for (const request of targets) {
          const decision = action === "accept" ? "accept" : "decline";
          const payload = request.method === "currentTime/read"
            ? { result: { unixMs: Date.now() } }
            : { result: { decision, ...(args.reason ? { reason: args.reason } : {}) } };
          client.respond(request.id, payload);
          answered += 1;
        }
        return {
          action,
          pending: listPending(),
          answered,
          note: targets.length ? "" : "nothing pending to answer",
        };
      });
    },
    presentCall: () => ({ card: "generic", title: "Codex approvals", kind: "other" }),
  });
}
