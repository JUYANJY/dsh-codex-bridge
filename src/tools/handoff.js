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
 * @param options - `{ timeoutMs, warnPct }`.
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
      const result = await bridge.withClient(async (client) => collectHandoff(client, {
        threadId: args.threadId,
        cwd,
        turns: Number.isFinite(args.turns) ? args.turns : undefined,
        items: Number.isFinite(args.items) ? args.items : undefined,
        reason: typeof args.reason === "string" && args.reason !== "" ? args.reason : undefined,
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
