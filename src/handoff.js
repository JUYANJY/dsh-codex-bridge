/**
 * Handoff: what DeepSeek Harness needs to take a Codex project over when Codex
 * stops. The projection is deliberately deterministic Markdown — no summarising
 * model sits between Codex's records and the reader, so nothing can be invented.
 *
 * The unit is one thread: a Codex thread is the session, one conversation with
 * Codex. ("Task" stays the panel's word for a card, i.e. a thread with a state.)
 *
 * @module dsh-codex-bridge/handoff
 */
import { clamp, listThreads, renderItem, resolveThreadId } from "./codex.js";
import { budgetLine, readBudget } from "./quota.js";

/** How many turns the brief lists. */
export const HANDOFF_TURNS = 8;
/** How many items are read from the newest turns. */
export const HANDOFF_ITEMS = 40;
/** How much of any one item text is quoted. */
export const HANDOFF_ITEM_CHARS = 800;

/**
 * Render a handoff brief.
 *
 * @param input - `{ now, cwd, thread, goal, turns, items, approvals, queued, budget, probe, reason }`.
 * @returns `{ markdown, facts }`.
 */
export function buildHandoff(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const thread = input.thread ?? {};
  const goal = input.goal ?? null;
  const turns = Array.isArray(input.turns) ? input.turns : [];
  const items = Array.isArray(input.items) ? input.items : [];
  const approvals = Array.isArray(input.approvals) ? input.approvals : [];
  const queued = Array.isArray(input.queued) ? input.queued : [];
  const budget = input.budget ?? null;
  const reason = typeof input.reason === "string" && input.reason !== "" ? input.reason : "Codex stopped making progress and this project needs another pair of hands.";

  const cwd = input.cwd ?? thread.cwd ?? "";
  const title = thread.title || thread.name || thread.preview || "(untitled)";
  const counted = countItems(items);
  const paths = collectPaths(items);
  const lastTurn = turns[0] ?? null;
  const lastUserMessage = [...items].reverse().find((item) => item.type === "userMessage" && item.text) ?? null;
  const lastAgentMessages = items.filter((item) => item.type === "agentMessage" && item.text).slice(-3);
  const failures = turns.filter((turn) => turn.status === "failed" || turn.error?.message);

  const lines = [];
  lines.push(`# Codex handoff — ${title}`);
  lines.push("");
  lines.push(`- thread: \`${thread.id ?? "(unknown)"}\``);
  if (cwd) lines.push(`- working directory: \`${cwd}\``);
  if (thread.gitBranch || thread.gitSha) lines.push(`- git: ${thread.gitBranch ?? "?"} @ ${thread.gitSha ?? "?"}`);
  if (thread.path) lines.push(`- rollout: \`${thread.path}\``);
  lines.push(`- written: ${new Date(now).toISOString()}`);
  lines.push(`- why: ${reason}`);
  lines.push("");

  lines.push("## What Codex was asked to do");
  if (goal && goal.objective) {
    lines.push(`- goal (verbatim): ${goal.objective}`);
    lines.push(`- goal status: ${goal.status ?? "unknown"}`
      + `${Number.isFinite(goal.tokensUsed) ? ` · tokens used ${goal.tokensUsed}` : ""}`
      + `${Number.isFinite(goal.tokenBudget) ? ` of ${goal.tokenBudget}` : " · no token budget reported"}`
      + `${Number.isFinite(goal.timeUsedSeconds) ? ` · ${Math.round(goal.timeUsedSeconds / 60)}min elapsed` : ""}`);
  } else {
    lines.push("- no goal is set on this thread; the newest user message below is the instruction.");
  }
  if (lastUserMessage) {
    lines.push("");
    lines.push("Newest user instruction on this thread (verbatim):");
    lines.push("");
    lines.push("> " + clamp(lastUserMessage.text, HANDOFF_ITEM_CHARS).replace(/\n/g, "\n> "));
  }
  lines.push("");

  lines.push("## Where it stopped");
  if (turns.length === 0) {
    lines.push("- no turns are recorded on this thread.");
  } else {
    for (const turn of turns) {
      const status = turn.status ?? "unknown";
      const when = Number.isFinite(turn.startedAt) ? new Date(turn.startedAt * 1000).toISOString() : "?";
      const duration = Number.isFinite(turn.durationMs) ? ` · ${Math.round(turn.durationMs / 1000)}s` : "";
      lines.push(`- \`${turn.id ?? "?"}\` ${status} at ${when}${duration}`);
      if (turn.error?.message) lines.push(`  - error: ${turn.error.message}${turn.error.codexErrorInfo ? ` (${turn.error.codexErrorInfo})` : ""}`);
    }
  }
  if (failures.length > 0) {
    lines.push("");
    lines.push(`**${failures.length} turn(s) failed.**`);
  }
  if (approvals.length > 0) {
    lines.push("");
    lines.push(`**${approvals.length} approval request(s) are open** — a person has to decide them; this bridge never answers one on its own:`);
    for (const approval of approvals) {
      lines.push(`- \`${approval.id ?? "?"}\` ${approval.method ?? approval.kind ?? "request"}`);
    }
  }
  if (queued.length > 0) {
    lines.push("");
    lines.push(`${queued.length} message(s) are queued and not yet consumed.`);
  }
  lines.push("");

  lines.push("## What it already did");
  lines.push(`- items read: ${items.length} (${Object.entries(counted).map(([type, count]) => `${type} ${count}`).join(", ") || "none"})`);
  if (paths.length > 0) {
    lines.push(`- files touched (best effort, from recorded items):`);
    for (const path of paths.slice(0, 40)) lines.push(`  - \`${path}\``);
  }
  if (lastAgentMessages.length > 0) {
    lines.push("");
    lines.push("Last things Codex said (verbatim, truncated):");
    for (const message of lastAgentMessages) {
      lines.push("");
      lines.push("> " + clamp(message.text, HANDOFF_ITEM_CHARS).replace(/\n/g, "\n> "));
    }
  }
  lines.push("");

  lines.push("## Quota at handoff");
  lines.push(`- ${budget ? budgetLine(budget) : "the account's quota was not read"}`);
  if (budget?.windows?.length) {
    for (const window of budget.windows) {
      lines.push(`  - ${window.limitId ?? "codex"}/${window.which}: ${Number.isFinite(window.usedPercent) ? `${window.usedPercent}% of ${window.windowMins ?? "?"}min` : "not reported"}`
        + `${window.resetsAtISO ? `, resets ${window.resetsAtISO}` : ""}`);
    }
  }
  lines.push("");

  lines.push("## What this brief cannot know");
  lines.push(`- Only the newest ${items.length} recorded item(s) of ${turns.length} turn(s) were read; older work is not represented here.`);
  lines.push("- Codex's reasoning is encrypted; only its messages, commands and file changes are visible.");
  lines.push("- Nothing in this brief was paraphrased: every quoted line comes from Codex's own records.");
  lines.push("");

  lines.push("## Suggested next step");
  lines.push("- Continue from the newest user instruction above, in this working directory.");
  lines.push("- Check the current state of the files listed above before writing: Codex may have left the work half-applied.");
  lines.push("- If Codex's quota is the reason for the handoff, treat this as a fresh start rather than a resumed turn.");

  return {
    markdown: lines.join("\n"),
    facts: {
      threadId: thread.id ?? null,
      title,
      cwd: cwd || null,
      itemTypes: counted,
      filesTouched: paths,
      turns: turns.map((turn) => ({ id: turn.id ?? null, status: turn.status ?? null, error: turn.error?.message ?? null })),
      lastUserMessage: lastUserMessage?.text ?? null,
      failures: failures.length,
      approvals: approvals.length,
      queued: queued.length,
      budgetLevel: budget?.level ?? null,
      reason,
    },
  };
}

/**
 * Count items by type.
 * @param items - projected items.
 * @returns a `{ type: count }` map.
 */
function countItems(items) {
  const counted = {};
  for (const item of items) {
    const type = item?.type ?? "unknown";
    counted[type] = (counted[type] ?? 0) + 1;
  }
  return counted;
}

/**
 * Best-effort file paths from recorded items. Raw items carry these fields in
 * more than one shape across Codex versions, so every candidate is inspected and
 * a missing field simply yields nothing.
 * @param items - projected items.
 * @returns unique paths, in order of appearance.
 */
function collectPaths(items) {
  const paths = [];
  const push = (value) => {
    if (typeof value !== "string" || value === "") return;
    if (!paths.includes(value)) paths.push(value);
  };
  for (const item of items) {
    push(item.path);
    if (Array.isArray(item.changes)) {
      for (const change of item.changes) push(typeof change === "string" ? change : change?.path);
    }
    if (Array.isArray(item.files)) {
      for (const file of item.files) push(typeof file === "string" ? file : file?.path);
    }
    if (Array.isArray(item.command)) push(item.command.find?.((part) => typeof part === "string" && part.includes("/")) ?? null);
  }
  return paths;
}

/**
 * Read everything the brief needs, then render it.
 *
 * @param client - a started app-server client.
 * @param options - `{ threadId, cwd, turns, items, reason, warnPct, timeoutMs }`.
 * @returns `{ ok, threadId, markdown, facts, budget, thread, reason }`.
 */
export async function collectHandoff(client, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cwd = options.cwd ?? process.cwd();
  const turnLimit = options.turns ?? HANDOFF_TURNS;
  const itemLimit = options.items ?? HANDOFF_ITEMS;
  const reason = options.reason ?? "";

  const threads = await listThreads(client, { limit: 50 });
  const threadId = typeof options.threadId === "string" && options.threadId !== ""
    ? options.threadId
    : await resolveThreadId(client, { cwd });
  if (!threadId) {
    return { ok: false, threadId: "", markdown: "", facts: null, budget: null, thread: null, reason: "no thread could be resolved for this directory" };
  }
  const listed = threads.find((thread) => thread.id === threadId) ?? null;
  let thread = { id: threadId, ...(listed ?? {}) };
  try {
    const read = await client.call("thread/read", { threadId }, { timeoutMs });
    const full = read?.thread ?? null;
    if (full) {
      thread = {
        ...thread,
        id: threadId,
        title: full.name || full.title || thread.title || "",
        name: full.name ?? null,
        path: full.path ?? thread.path ?? null,
        cwd: full.cwd ?? thread.cwd ?? cwd,
        gitBranch: full.gitInfo?.branch ?? null,
        gitSha: full.gitInfo?.sha ?? null,
        statusType: full.status?.type ?? thread.status ?? null,
      };
    }
  } catch {
    // A thread that cannot be re-read is not a reason to refuse a handoff.
  }

  const [turnsResult, itemsResult, goalResult, queueResult, budget] = await Promise.all([
    client.call("thread/turns/list", { threadId, limit: turnLimit, sortDirection: "desc", itemsView: "summary" }, { timeoutMs }).catch(() => ({ data: [] })),
    client.call("thread/items/list", { threadId, limit: itemLimit, sortDirection: "desc" }, { timeoutMs }).catch(() => ({ data: [] })),
    client.call("thread/goal/get", { threadId }, { timeoutMs }).catch(() => ({ goal: null })),
    client.call("thread/queue/list", { threadId }, { timeoutMs }).catch(() => ({ data: [] })),
    readBudget(client, { timeoutMs, warnPct: options.warnPct }),
  ]);

  const turns = (turnsResult?.data ?? []).map((turn) => ({
    id: turn?.id ?? null,
    status: turn?.status ?? null,
    startedAt: Number.isFinite(turn?.startedAt) ? turn.startedAt : null,
    completedAt: Number.isFinite(turn?.completedAt) ? turn.completedAt : null,
    durationMs: Number.isFinite(turn?.durationMs) ? turn.durationMs : null,
    error: turn?.error?.message ? { message: turn.error.message, codexErrorInfo: turn.error.codexErrorInfo ?? null } : null,
  }));
  const items = (itemsResult?.data ?? []).map((entry) => {
    const raw = entry?.item ?? entry ?? {};
    const rendered = renderItem(raw);
    return {
      turnId: entry?.turnId ?? raw.turnId ?? null,
      itemId: raw.id ?? null,
      type: rendered.type,
      text: rendered.text,
      status: raw.status ?? null,
      phase: raw.phase ?? null,
      path: typeof raw.path === "string" ? raw.path : null,
      changes: Array.isArray(raw.changes) ? raw.changes : null,
      files: Array.isArray(raw.files) ? raw.files : null,
      command: Array.isArray(raw.command) ? raw.command : null,
    };
  });
  const approvals = (client.pendingServerRequests?.() ?? []).filter((request) => {
    const id = request?.params?.threadId ?? request?.params?.turn?.threadId ?? null;
    return !id || id === threadId;
  }).map((request) => ({ id: request?.id ?? null, method: request?.method ?? null }));
  const queued = Array.isArray(queueResult?.data) ? queueResult.data : [];

  const { markdown, facts } = buildHandoff({
    now: Date.now(),
    cwd: thread.cwd ?? cwd,
    thread,
    goal: goalResult?.goal ?? null,
    turns,
    items,
    approvals,
    queued,
    budget,
    reason,
  });
  return { ok: true, threadId, markdown, facts, budget, thread, reason: "" };
}
