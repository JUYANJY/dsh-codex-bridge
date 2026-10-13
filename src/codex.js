/**
 * Read-side helpers over the codex app-server protocol.
 *
 * Everything here is pure projection: codex items in, compact records out.
 * @module dsh-codex-bridge/codex
 */
import { execFile } from "node:child_process";

/** Cap one rendered string so a single huge diff cannot swamp the reader. */
const MAX_FIELD = 4000;

/**
 * Truncate a string with an explicit marker.
 * @param value - the text.
 * @param limit - maximum characters.
 * @returns the possibly truncated text.
 */
export function clamp(value, limit = MAX_FIELD) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

/**
 * Collect human-readable text from a codex content array or nested value.
 * @param value - any JSON value from an item.
 * @returns the concatenated text blocks.
 */
export function extractText(value) {
  const parts = [];
  const walk = (node, depth) => {
    if (depth > 8 || node === null || node === undefined) return;
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1);
      return;
    }
    if (typeof node === "object") {
      if (typeof node.text === "string") parts.push(node.text);
      else if (typeof node.content === "string") parts.push(node.content);
      else if (Array.isArray(node.content)) walk(node.content, depth + 1);
      else if (Array.isArray(node.summary)) walk(node.summary, depth + 1);
      else if (typeof node.message === "string") parts.push(node.message);
    }
  };
  walk(value, 0);
  return parts.join("\n").trim();
}

/**
 * Project one codex thread item into a compact, printable record.
 * @param item - a `ThreadItem` from `thread/items/list` or a notification payload.
 * @returns `{ type, text }` where `text` is the readable body.
 */
export function renderItem(item) {
  if (!item || typeof item !== "object") return { type: "unknown", text: "" };
  const type = item.type ?? "unknown";
  switch (type) {
    case "userMessage":
    case "agentMessage": {
      const text = extractText(item.content ?? item.text ?? item);
      return { type, text: clamp(text) };
    }
    case "reasoning": {
      const summary = extractText(item.summary ?? []);
      const content = extractText(item.content ?? []);
      const text = [summary, content].filter(Boolean).join("\n");
      return { type, text: clamp(text || "(reasoning not exposed: encrypted)") };
    }
    case "commandExecution": {
      const output = typeof item.aggregatedOutput === "string"
        ? item.aggregatedOutput
        : (typeof item.output === "string" ? item.output : extractText(item.aggregatedOutput ?? []));
      const head = `$ ${item.command ?? ""}  [${item.status ?? "?"}]`;
      return { type, text: clamp(output ? `${head}\n${output}` : head) };
    }
    case "fileChange": {
      const lines = (item.changes ?? []).map((change) => {
        const kind = change?.kind?.type ?? "update";
        const path = change?.path ?? "?";
        const diff = typeof change?.diff === "string" ? change.diff : "";
        return `[${kind}] ${path}${diff ? `\n${diff}` : ""}`;
      });
      return { type, text: clamp(lines.join("\n\n") || "(no changes)") };
    }
    case "mcpToolCall": {
      const head = `mcp ${item.server ?? ""}.${item.tool ?? ""} [${item.status ?? "?"}]`;
      const body = extractText(item.arguments ?? item.result ?? []);
      return { type, text: clamp(body ? `${head}\n${body}` : head) };
    }
    case "plan": {
      return { type, text: clamp(extractText(item.items ?? item.steps ?? item.content ?? item)) };
    }
    case "todoList":
    case "todo_list": {
      const lines = (item.items ?? []).map((entry) => `[${entry?.status ?? "?"}] ${entry?.content ?? ""}`);
      return { type, text: clamp(lines.join("\n") || JSON.stringify(item).slice(0, 800)) };
    }
    case "error": {
      return { type, text: clamp(item.message ?? JSON.stringify(item)) };
    }
    default: {
      const text = extractText(item);
      return { type, text: clamp(text || JSON.stringify(item).slice(0, 1200)) };
    }
  }
}

/**
 * List codex processes on this machine.
 * @returns `{pid, kind, command}` records for codex app-server / code-mode hosts.
 */
export function listCodexProcesses() {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,etime=,command="], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      const rows = [];
      for (const line of String(stdout).split("\n")) {
        const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!match) continue;
        const command = match[3];
        if (!/(^|\/|\s)codex(\s|$)/.test(command) && !command.includes("codex-code-mode-host")) continue;
        if (command.includes("ps -axo")) continue;
        const kind = command.includes("app-server")
          ? "app-server"
          : (command.includes("code-mode-host") ? "code-mode-host" : "cli");
        rows.push({ pid: Number(match[1]), uptime: match[2], kind, command: clamp(command, 300) });
      }
      resolve(rows);
    });
  });
}

/**
 * Read account identity and remaining rate-limit budget.
 * @param client - a started app-server client.
 * @returns `{ account, limits }` with a compact limit projection.
 */
export async function readAccountState(client) {
  const [account, limits] = await Promise.all([
    client.call("account/read", {}).catch((error) => ({ error: String(error.message ?? error) })),
    client.call("account/rateLimits/read", {}).catch((error) => ({ error: String(error.message ?? error) })),
  ]);
  return { account, limits };
}

/**
 * Project `account/rateLimits/read` into the numbers that decide "is codex out of budget".
 * @param limitsResult - the raw result.
 * @returns a compact shape or `null`.
 */
export function compactLimits(limitsResult) {
  const record = limitsResult?.rateLimits;
  if (!record) return null;
  return {
    planType: record.planType ?? null,
    ordinaryUsageAllowed: limitsResult.ordinaryUsageAllowed ?? null,
    reached: record.rateLimitReachedType ?? null,
    primary: record.primary
      ? { usedPercent: record.primary.usedPercent, windowMins: record.primary.windowDurationMins, resetsAt: record.primary.resetsAt }
      : null,
    secondary: record.secondary
      ? { usedPercent: record.secondary.usedPercent, windowMins: record.secondary.windowDurationMins, resetsAt: record.secondary.resetsAt }
      : null,
    resetCreditsAvailable: limitsResult.rateLimitResetCredits?.availableCount ?? null,
  };
}

/**
 * List threads, newest first.
 * @param client - a started app-server client.
 * @param params - `thread/list` filters.
 * @returns compact thread records.
 */
export async function listThreads(client, params = {}) {
  const result = await client.call("thread/list", { limit: 25, ...params });
  return (result?.data ?? []).map((thread) => ({
    id: thread.id,
    title: thread.title ?? thread.name ?? null,
    preview: clamp(String(thread.preview ?? "").replace(/\s+/g, " ").trim(), 240),
    cwd: thread.cwd ?? null,
    model: thread.model ?? null,
    effort: thread.reasoningEffort ?? null,
    status: thread.status?.type ?? null,
    updatedAt: thread.updatedAt ? new Date(thread.updatedAt * 1000).toISOString() : null,
    path: thread.path ?? null,
  }));
}

/**
 * Fetch item records for one thread.
 * @param client - a started app-server client.
 * @param params - `{ threadId, limit, turnId, sortDirection }`.
 * @returns `{ items, nextCursor, backwardsCursor }`.
 */
export async function listItems(client, params) {
  const result = await client.call("thread/items/list", {
    limit: 40,
    sortDirection: "desc",
    ...params,
  });
  const data = result?.data ?? [];
  const items = data.map((entry) => ({
    turnId: entry.turnId ?? null,
    itemId: entry.item?.id ?? null,
    ...renderItem(entry.item),
  }));
  return { items, nextCursor: result?.nextCursor ?? null, backwardsCursor: result?.backwardsCursor ?? null };
}

/**
 * Turn an epoch timestamp into ISO, accepting seconds or milliseconds.
 *
 * `thread/turns/list` and `thread/goal/get` both report epoch **seconds**
 * (verified against a live app-server), but the tolerance costs nothing and
 * keeps a millisecond payload from being read as 1970.
 *
 * @param value - epoch seconds or milliseconds.
 * @returns an ISO string, or null.
 */
export function epochToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Date(number > 1e12 ? number : number * 1000).toISOString();
}

/**
 * Project one `thread/turns/list` entry into a compact record.
 *
 * Verified shape (live app-server, 2026-10-13): `{ id, items, itemsView, status,
 * error, startedAt, completedAt, durationMs }` with `status` one of
 * `completed | failed | interrupted` and `error` carried only by failed turns.
 *
 * @param turn - a raw turn.
 * @returns the compact turn.
 */
export function compactTurn(turn = {}) {
  return {
    id: turn.id ?? null,
    status: turn.status ?? null,
    error: turn.error
      ? {
        message: clamp(String(turn.error.message ?? "").replace(/\s+/g, " ").trim(), 400),
        info: turn.error.codexErrorInfo ?? null,
      }
      : null,
    startedAt: epochToIso(turn.startedAt),
    completedAt: epochToIso(turn.completedAt),
    durationMs: typeof turn.durationMs === "number" ? turn.durationMs : null,
    items: compactTurnItems(turn.items),
  };
}

/**
 * Count a turn's items by type and keep its message texts.
 * @param items - `turn.items`.
 * @returns `{ count, counts, messages }`.
 */
export function compactTurnItems(items) {
  const list = Array.isArray(items) ? items : [];
  const counts = {};
  const messages = [];
  for (const item of list) {
    const type = item?.type ?? "unknown";
    counts[type] = (counts[type] ?? 0) + 1;
    if (type === "agentMessage" || type === "userMessage") {
      messages.push({
        type,
        phase: item.phase ?? null,
        text: clamp(extractText(item.content ?? item), 800),
      });
    }
  }
  return { count: list.length, counts, messages };
}

/**
 * List a thread's turns, newest first.
 * @param client - a started app-server client.
 * @param params - `{ threadId, limit, itemsView, sortDirection }`.
 * @returns compact turn records.
 */
export async function listTurns(client, params = {}) {
  const result = await client.call("thread/turns/list", {
    limit: 8,
    sortDirection: "desc",
    itemsView: "summary",
    ...params,
  });
  return (result?.data ?? []).map((turn) => compactTurn(turn));
}

/**
 * Read a thread's goal, or null when it has none.
 *
 * Verified shape (live app-server, 2026-10-13):
 * `{ goal: { threadId, objective, status, tokenBudget, tokensUsed,
 * timeUsedSeconds, createdAt, updatedAt } }`, and `{ goal: null }` for most
 * threads. `tokenBudget` is null unless a budget was set.
 *
 * @param client - a started app-server client.
 * @param threadId - the thread.
 * @returns the compact goal, or null.
 */
export async function readGoal(client, threadId) {
  const result = await client.call("thread/goal/get", { threadId });
  const goal = result?.goal ?? null;
  if (!goal || typeof goal !== "object") return null;
  return {
    threadId: goal.threadId ?? threadId,
    objective: clamp(String(goal.objective ?? "").replace(/\s+/g, " ").trim(), 400),
    status: goal.status ?? null,
    tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : null,
    tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : null,
    timeUsedSeconds: typeof goal.timeUsedSeconds === "number" ? goal.timeUsedSeconds : null,
    createdAt: epochToIso(goal.createdAt),
    updatedAt: epochToIso(goal.updatedAt),
  };
}

/**
 * Pick the thread a caller most likely means: explicit id, else newest for `cwd`, else newest overall.
 * @param client - a started app-server client.
 * @param options - `{ threadId, cwd }`.
 * @returns the chosen thread id.
 */
export async function resolveThreadId(client, options = {}) {
  if (options.threadId) return options.threadId;
  const all = await listThreads(client, { limit: 50 });
  const fresh = await listThreads(client, { limit: 50, cwd: options.cwd ?? process.cwd() });
  return fresh[0]?.id ?? all[0]?.id ?? null;
}
