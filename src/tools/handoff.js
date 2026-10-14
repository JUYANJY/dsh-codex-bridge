/**
 * `codex_handoff` — produce the brief DeepSeek Harness needs to take a Codex
 * project over once Codex stops (quota reached, turns failing, or a stuck goal).
 *
 * @module dsh-codex-bridge/tools/handoff
 */
import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { collectHandoff } from "../handoff.js";

/**
 * Build the handoff tool.
 * @param bridge - the shared bridge.
 * @param options - `{ timeoutMs, warnPct, takeovers }`.
 * @returns a tool definition.
 */
export function handoffTool(bridge, options = {}) {
  const timeout = options.timeoutMs ?? 30_000;

  return defineTool({
    name: "codex_handoff",
    description:
      "Write a handoff brief for a Codex thread so this session can continue the work: the goal Codex "
      + "was given, the newest instruction verbatim, the last turns with their statuses and errors, what "
      + "Codex already did, the files it touched, the quota state, and an explicit list of what the brief "
      + "cannot know. Nothing is paraphrased by a model — every quoted line comes from Codex's records. "
      + "Call this when Codex reaches its quota or reports a stop, then continue the work from the brief.",
    parameters: {
      threadId: { type: "string", description: "Codex thread id. Omit to use the newest thread for the working directory." },
      cwd: { type: "string", description: "Working directory used to resolve the thread (default: this session's directory)." },
      turns: { type: "integer", description: "How many turns to list (default 8)." },
      items: { type: "integer", description: "How many recorded items to read (default 40)." },
      reason: { type: "string", description: "Why the handoff exists, quoted into the brief (defaults to a quota/stop explanation)." },
      saveTo: { type: "string", description: "Optional path to write the brief to (relative paths resolve against the working directory)." },
      action: {
        type: "string",
        enum: ["read", "prepare", "claim"],
        description: "read (default) returns the brief; prepare writes it as a takeover of a thread whose quota is "
          + "reached; claim records that a person or this session has actually taken a prepared brief over. A prepared "
          + "brief nobody claimed is not a handover, and the panel keeps saying so.",
      },
      claimedBy: { type: "string", description: "For action=claim: who is taking it over (default: a DeepSeek Harness turn)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          reason: { type: "string", required: true },
          threadId: { type: "string", required: true },
          title: { type: "string", required: true },
          cwd: { type: "string", required: true },
          budgetLevel: { type: "string", required: true },
          itemTypes: { type: "string", required: true },
          filesTouched: { type: "array", required: true, items: { type: "string" } },
          turns: { type: "integer", required: true },
          failures: { type: "integer", required: true },
          approvals: { type: "integer", required: true },
          queued: { type: "integer", required: true },
          savedTo: { type: "string", required: true },
          markdown: { type: "string", required: true },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: "text", text: `No handoff: ${value.reason}` }];
        return [{
          type: "text",
          text: [
            `Handoff for \`${value.threadId}\` — ${value.title}`,
            `items: ${value.itemTypes || "none"} · turns: ${value.turns} · failed: ${value.failures}`
              + ` · open approvals: ${value.approvals} · queued: ${value.queued} · quota: ${value.budgetLevel}`,
            value.savedTo ? `written to ${value.savedTo}` : "",
            "",
            value.markdown,
          ].filter((line) => line !== "").join("\n"),
        }];
      },
    },
    async execute(args) {
      const cwd = typeof args.cwd === "string" && args.cwd !== "" ? args.cwd : process.cwd();

      // Claiming is bookkeeping, not a read: it needs no Codex call at all.
      if (args.action === "claim") {
        if (!options.takeovers) {
          return {
            ok: false, reason: "this build carries no takeover store", threadId: args.threadId ?? "", title: "", cwd,
            budgetLevel: "", itemTypes: "", filesTouched: [], turns: 0, failures: 0, approvals: 0, queued: 0, savedTo: "", markdown: "",
          };
        }
        const claim = options.takeovers.claim({
          threadId: typeof args.threadId === "string" && args.threadId !== "" ? args.threadId : null,
          path: typeof args.saveTo === "string" && args.saveTo !== "" ? args.saveTo : null,
          claimedBy: typeof args.claimedBy === "string" && args.claimedBy !== "" ? args.claimedBy : "a DeepSeek Harness turn",
        });
        const record = claim.record ?? null;
        return {
          ok: claim.ok,
          reason: claim.ok ? "" : claim.detail,
          threadId: record?.threadId ?? args.threadId ?? "",
          title: "takeover",
          cwd,
          budgetLevel: "",
          itemTypes: "",
          filesTouched: record?.path ? [record.path] : [],
          turns: 0,
          failures: 0,
          approvals: 0,
          queued: 0,
          savedTo: record?.path ?? "",
          markdown: claim.ok ? `${claim.detail}\n\nThe takeover of \`${record.threadId}\` is now recorded as claimed.` : claim.detail,
        };
      }

      const result = await bridge.withClient(async (client) => collectHandoff(client, {
        threadId: args.threadId,
        cwd,
        turns: Number.isFinite(args.turns) ? args.turns : undefined,
        items: Number.isFinite(args.items) ? args.items : undefined,
        reason: args.action === "prepare" && !(typeof args.reason === "string" && args.reason !== "")
          ? "Codex's quota is reached; DeepSeek Harness is taking this over"
          : (typeof args.reason === "string" && args.reason !== "" ? args.reason : undefined),
        warnPct: options.warnPct,
        timeoutMs: timeout,
      }));
      if (!result.ok) {
        return {
          ok: false, reason: result.reason, threadId: "", title: "", cwd, budgetLevel: "",
          itemTypes: "", filesTouched: [], turns: 0, failures: 0, approvals: 0, queued: 0, savedTo: "", markdown: "",
        };
      }

      let savedTo = "";
      if (typeof args.saveTo === "string" && args.saveTo !== "") {
        const target = isAbsolute(args.saveTo) ? args.saveTo : resolve(result.facts?.cwd ?? cwd, args.saveTo);
        try {
          writeFileSync(target, result.markdown, "utf8");
          savedTo = target;
        } catch (error) {
          savedTo = "";
          result.markdown += `\n\n<!-- could not write ${target}: ${String(error?.message ?? error)} -->`;
        }
      }

      return {
        ok: true,
        reason: "",
        threadId: result.threadId,
        title: result.facts?.title ?? "",
        cwd: result.facts?.cwd ?? cwd,
        budgetLevel: result.budget?.level ?? "unknown",
        itemTypes: Object.entries(result.facts?.itemTypes ?? {}).map(([type, count]) => `${type} ${count}`).join(", "),
        filesTouched: result.facts?.filesTouched ?? [],
        turns: result.facts?.turns?.length ?? 0,
        failures: result.facts?.failures ?? 0,
        approvals: result.facts?.approvals ?? 0,
        queued: result.facts?.queued ?? 0,
        savedTo,
        markdown: result.markdown,
      };
    },
    presentCall: () => ({ card: "generic", title: "Codex handoff brief", kind: "other" }),
  });
}
