/**
 * `codex_threads` — list Codex sessions, including ones the desktop app started.
 * @module dsh-codex-bridge/tools/threads
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { listThreads } from "../codex.js";

/**
 * Build the threads tool.
 * @param bridge - the shared bridge.
 * @returns a tool definition.
 */
export function threadsTool(bridge) {
  return defineTool({
    name: "codex_threads",
    description:
      "List Codex sessions (threads) visible to the local codex app-server, newest first. "
      + "Includes sessions started by the Codex desktop app. Filter by working directory to find "
      + "the session working on one project.",
    parameters: {
      limit: { type: "integer", description: "Maximum threads to return (default 15)." },
      cwd: { type: "string", description: "Only threads whose working directory equals this path." },
      search: { type: "string", description: "Case-insensitive substring filter over title and preview." },
      includeArchived: { type: "boolean", description: "Include archived threads (default false)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "integer", required: true },
          threads: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                title: { type: "string", required: true },
                status: { type: "string", required: true },
                model: { type: "string", required: true },
                cwd: { type: "string", required: true },
                updatedAt: { type: "string", required: true },
                preview: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.threads.length
          ? value.threads.map((t) => `${t.id}  [${t.status}] ${t.model}  ${t.updatedAt}\n    ${t.cwd}\n    ${t.title || t.preview}`).join("\n")
          : "no codex threads found",
      }],
    },
    async execute(args) {
      return bridge.withClient(async (client) => {
        const threads = await listThreads(client, {
          limit: args.limit ?? 15,
          ...(args.cwd ? { cwd: args.cwd } : {}),
          ...(args.includeArchived ? { archived: true } : {}),
        });
        const needle = args.search?.toLowerCase();
        const filtered = needle
          ? threads.filter((t) => `${t.title ?? ""} ${t.preview}`.toLowerCase().includes(needle))
          : threads;
        return {
          count: filtered.length,
          threads: filtered.map((t) => ({
            id: t.id,
            title: t.title ?? "",
            status: t.status ?? "unknown",
            model: t.model ?? "",
            cwd: t.cwd ?? "",
            updatedAt: t.updatedAt ?? "",
            preview: t.preview,
          })),
        };
      });
    },
    presentCall: () => ({ card: "generic", title: "Codex sessions", kind: "other" }),
  });
}
