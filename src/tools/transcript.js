/**
 * `codex_transcript` — read a session's items: messages, commands, diffs, reasoning summaries.
 * @module dsh-codex-bridge/tools/transcript
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { clamp, listItems, resolveThreadId } from "../codex.js";

/**
 * Build the transcript tool.
 * @param bridge - the shared bridge.
 * @returns a tool definition.
 */
export function transcriptTool(bridge) {
  return defineTool({
    name: "codex_transcript",
    description:
      "Read the transcript of one Codex session: user and agent messages, reasoning summaries, "
      + "shell commands with their output, and file changes with diffs. Defaults to the newest "
      + "Codex thread for the current working directory. Set sortDirection=asc and raise limit to "
      + "read a session forward. Reasoning bodies are encrypted by the model provider, so only the "
      + "summary text Codex itself records is available here — use codex_watch for live thinking.",
    parameters: {
      threadId: { type: "string", description: "Codex thread id. Omit to use the newest thread for this project." },
      limit: { type: "integer", description: "How many items to return (default 30)." },
      sortDirection: { type: "string", description: "desc (newest first, default) or asc (oldest first)." },
      turnId: { type: "string", description: "Restrict to one turn." },
      maxCharsPerItem: { type: "integer", description: "Per-item character cap (default 2000)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          threadId: { type: "string", required: true },
          count: { type: "integer", required: true },
          nextCursor: { type: "string", required: true },
          entries: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                turnId: { type: "string", required: true },
                itemId: { type: "string", required: true },
                type: { type: "string", required: true },
                text: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.count
          ? `${value.threadId}\n\n` + value.entries.map((e) => `### ${e.type}\n${e.text}`).join("\n\n")
          : `thread ${value.threadId} has no items`,
      }],
    },
    async execute(args) {
      const cwd = process.cwd();
      return bridge.withClient(async (client) => {
        const threadId = await resolveThreadId(client, { threadId: args.threadId, cwd });
        if (!threadId) throw new Error("no codex thread found");
        const { items, nextCursor } = await listItems(client, {
          threadId,
          limit: args.limit ?? 30,
          sortDirection: args.sortDirection === "asc" ? "asc" : "desc",
          ...(args.turnId ? { turnId: args.turnId } : {}),
        });
        const cap = args.maxCharsPerItem ?? 2000;
        return {
          threadId,
          count: items.length,
          nextCursor: nextCursor ?? "",
          entries: items.map((item) => ({
            turnId: item.turnId ?? "",
            itemId: item.itemId ?? "",
            type: item.type,
            text: clamp(item.text, cap),
          })),
        };
      });
    },
    presentCall: () => ({ card: "generic", title: "Codex transcript", kind: "other" }),
  });
}
