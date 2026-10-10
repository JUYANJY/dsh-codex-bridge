/**
 * `codex_status` — is Codex alive, who is signed in, and is it out of budget?
 * @module dsh-codex-bridge/tools/status
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveCodexBin } from "../app-server.js";
import { compactLimits, listCodexProcesses, listThreads, readAccountState } from "../codex.js";

/**
 * Build the status tool.
 * @param bridge - the shared bridge.
 * @returns a tool definition.
 */
export function statusTool(bridge) {
  return defineTool({
    name: "codex_status",
    description:
      "Report the state of the local Codex (OpenAI) installation as DeepSeek Harness sees it: "
      + "running codex processes, the signed-in account and plan, remaining rate-limit budget "
      + "(the number that says whether Codex is out of budget), the most recently active thread, "
      + "and any approval requests this bridge is holding. Use this before deciding to take over "
      + "work from Codex, or to check whether a Codex session is still alive.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          binary: { type: "string", required: true },
          processes: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                pid: { type: "integer", required: true },
                kind: { type: "string", required: true },
                uptime: { type: "string", required: true },
              },
            },
          },
          account: { type: "string", required: true },
          plan: { type: "string", required: true },
          budget: { type: "string", required: true },
          latestThread: { type: "string", required: true },
          pendingApprovals: { type: "integer", required: true },
          log: { type: "array", required: true, items: { type: "string" } },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: [
          `codex binary: ${value.binary}`,
          `processes: ${value.processes.length ? value.processes.map((p) => `${p.kind}#${p.pid}(${p.uptime})`).join(", ") : "none"}`,
          `account: ${value.account} · plan ${value.plan}`,
          `budget: ${value.budget}`,
          `latest thread: ${value.latestThread}`,
          `approvals held by bridge: ${value.pendingApprovals}`,
          ...value.log,
        ].join("\n"),
      }],
    },
    async execute() {
      const log = [];
      const processes = await listCodexProcesses();
      const binary = resolveCodexBin(bridge.config.binary || undefined);
      let account = "unknown";
      let plan = "unknown";
      let budget = "unavailable";
      let latestThread = "none";
      let pendingApprovals = 0;
      try {
        const client = await bridge.connection();
        const state = await readAccountState(client);
        account = state.account?.account?.email ?? state.account?.error ?? "unknown";
        plan = state.account?.account?.planType ?? "unknown";
        const limits = compactLimits(state.limits);
        budget = limits
          ? `${limits.primary?.usedPercent ?? "?"}% of ${limits.primary?.windowMins ?? "?"}min window, `
            + `${limits.secondary?.usedPercent ?? "?"}% weekly`
            + `${limits.reached ? ` · REACHED: ${limits.reached}` : ""}`
            + `${limits.resetCreditsAvailable ? ` · ${limits.resetCreditsAvailable} reset credits` : ""}`
          : "unavailable";
        const threads = await listThreads(client, { limit: 5 });
        latestThread = threads[0] ? `${threads[0].id} (${threads[0].status ?? "?"}, ${threads[0].updatedAt ?? "?"})` : "none";
        pendingApprovals = client.pendingServerRequests().length;
      } catch (error) {
        log.push(`bridge error: ${String(error?.message ?? error)}`);
      }
      return {
        binary,
        processes: processes.map((p) => ({ pid: p.pid, kind: p.kind, uptime: p.uptime })),
        account,
        plan,
        budget,
        latestThread,
        pendingApprovals,
        log,
      };
    },
    presentCall: () => ({ card: "generic", title: "Codex status", kind: "other" }),
  });
}
