/**
 * The read-only projection behind the Codex board panel.
 *
 * The panel is presentation only: every judgement about *what is true* is made
 * here, in pure functions, so the board can be unit-tested without a DOM and so
 * the panel cannot quietly invent a status the protocol never reported.
 *
 * The honesty rules this module exists to enforce:
 *  - the last column is "Nothing observed", never "idle": a notification
 *    only reaches the connection that owns the turn (docs/limitations.md), so
 *    silence in this process proves nothing about the thread;
 *  - a card's colour comes from `task-state.js`, which names the rule behind
 *    every state and marks each reason `reported` or `inferred`;
 *  - a turn counts as running only when Codex reports it that way, when *this*
 *    connection saw it start, or when the rollout was touched seconds ago —
 *    and the third case is labelled `inferred` on the card;
 *  - approval counts cover only the server requests this process is holding;
 *  - queue, item, turn and goal coverage is only as complete as the probes that
 *    actually ran, and the snapshot carries that coverage with it;
 *  - a card's "last" line is the newest item the rollout reports that is not
 *    encrypted reasoning, and its status is printed verbatim: neither is turned
 *    into a claim about the turn;
 *  - a progress bar appears only when Codex reported a denominator (a plan's
 *    steps, or a goal's token budget). Otherwise the card shows counts.
 *
 * @module dsh-codex-bridge/board
 */
import {
  clamp, compactLimits, listThreads, listTurns, readAccountState, readGoal, renderItem,
} from "./codex.js";
import {
  STATE_HINTS, STATE_LABELS, TASK_STATES, deriveTaskState, planFromNotifications, progressOf, turnStrip,
} from "./task-state.js";
import { budgetFromLimits } from "./quota.js";
import { classifyFailure } from "./supervise.js";

/** How many recent threads one snapshot looks at. */
export const DEFAULT_MAX_THREADS = 12;

/** How many of those threads get a `thread/queue/list` probe (each probe is one round trip). */
export const DEFAULT_MAX_QUEUE_PROBES = 6;

/** How many of those threads get a `thread/items/list` probe for their last action. */
export const DEFAULT_MAX_ITEM_PROBES = 6;

/**
 * How many threads get a turn probe (`thread/turns/list`) and a goal probe
 * (`thread/goal/get`).
 *
 * Turns decide the task state, so the default covers the whole listing rather
 * than an arbitrary subset; both calls read local rollout state and answer in
 * milliseconds.
 */
export const DEFAULT_MAX_TURN_PROBES = 12;

/** How many recent items one probe reads: enough to look past the trailing reasoning items. */
export const ITEM_PROBE_LIMIT = 3;

/** How much of an item's text reaches a card label. */
export const LAST_ITEM_CHARS = 180;

/** How much of Codex's own last message a card carries, for the supervision brief. */
export const LAST_SPOKEN_CHARS = 400;

/** How many turns `thread/turns/list` reads per thread: enough for the turn strip. */
export const TURN_PROBE_LIMIT = 8;

/**
 * Item types the card label skips.
 *
 * Reasoning items trail almost every turn and their text is encrypted, so the
 * newest non-reasoning item is the one that says what actually happened last.
 */
const UNLABELED_ITEM_TYPES = new Set(["reasoning"]);

/**
 * Board columns, in display order: one column per task state, so a reader sees
 * "needs you / blocked / running / nothing observed" instead of a queue listing
 * with a status hidden inside it.
 */
export const BOARD_COLUMNS = TASK_STATES.map((id) => ({ id, label: STATE_LABELS[id], hint: STATE_HINTS[id] }));

/** Notification methods that end a turn. */
const TURN_END_METHODS = new Set(["turn/completed", "turn/failed", "turn/cancelled", "turn/interrupted"]);

/**
 * Which thread each notification is about.
 * @param params - notification parameters.
 * @returns the thread id, or null when the payload names none.
 */
function threadIdOf(params) {
  if (!params || typeof params !== "object") return null;
  return params.threadId ?? params.turn?.threadId ?? params.thread?.id ?? null;
}

/**
 * Fold the retained notification stream into "turns this connection believes are open".
 * @param notifications - `{ at, method, params }` records, oldest first.
 * @returns a `Map` of thread id -> `{ at, turnId }`.
 */
export function observeTurnState(notifications = []) {
  const open = new Map();
  for (const notice of notifications) {
    const threadId = threadIdOf(notice?.params);
    if (!threadId || typeof notice?.method !== "string") continue;
    if (notice.method === "turn/started") {
      open.set(threadId, { at: notice.at ?? 0, turnId: notice.params?.turn?.id ?? null });
    } else if (TURN_END_METHODS.has(notice.method)) {
      const known = open.get(threadId);
      if (known && known.at <= (notice.at ?? 0)) open.delete(threadId);
    }
  }
  return open;
}

/**
 * Milliseconds since an ISO timestamp.
 * @param updatedAt - ISO string or null.
 * @param now - reference time in milliseconds.
 * @returns the age in milliseconds, or null when there is no timestamp.
 */
function ageOf(updatedAt, now) {
  if (!updatedAt) return null;
  const at = Date.parse(updatedAt);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/**
 * Order cards newest-first.
 * @param a - a card.
 * @param b - a card.
 * @returns comparator result.
 */
function byRecency(a, b) {
  const left = a.ageMs ?? Number.MAX_SAFE_INTEGER;
  const right = b.ageMs ?? Number.MAX_SAFE_INTEGER;
  return left - right;
}

/**
 * Build the board from already-collected facts. Pure.
 * @param input - `{ threads, queues, items, approvals, turns, turnLists, goals, plans, takeovers, autopilotHalted, autopilotPaused, failureMs, now }`.
 * @returns `{ generatedAt, columns, cards, totals, unattachedApprovals }`.
 */
export function buildBoard(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const threads = Array.isArray(input.threads) ? input.threads : [];
  const queues = input.queues ?? {};
  const items = input.items ?? {};
  const approvals = Array.isArray(input.approvals) ? input.approvals : [];
  const observed = input.turns instanceof Map ? input.turns : new Map();
  const turnLists = input.turnLists ?? {};
  const goals = input.goals ?? {};
  const plans = input.plans ?? {};
  const halted = input.autopilotHalted instanceof Map
    ? input.autopilotHalted
    : new Map(Array.isArray(input.autopilotHalted) ? input.autopilotHalted : []);
  // A prepared takeover brief, per thread. Same shape either way, so callers
  // may hand over the Takeovers instance's Map or a plain pair list.
  const takeovers = input.takeovers instanceof Map
    ? input.takeovers
    : new Map(Array.isArray(input.takeovers) ? input.takeovers : []);

  const pausedIds = new Set(
    input.autopilotPaused instanceof Set
      ? [...input.autopilotPaused]
      : Array.isArray(input.autopilotPaused) ? input.autopilotPaused : [],
  );

  const waitingByThread = new Map();
  const knownThreadIds = new Set(threads.map((thread) => thread.id));
  const unattachedApprovals = [];
  for (const approval of approvals) {
    const threadId = approval?.threadId ?? null;
    if (threadId && knownThreadIds.has(threadId)) {
      waitingByThread.set(threadId, (waitingByThread.get(threadId) ?? 0) + 1);
    } else {
      unattachedApprovals.push({
        id: approval?.id ?? null,
        method: approval?.method ?? null,
        threadId,
      });
    }
  }

  const cards = threads.map((thread) => {
    const threadId = thread.id;
    const queued = Array.isArray(queues[threadId]) ? queues[threadId] : [];
    const waitingCount = waitingByThread.get(threadId) ?? 0;
    const observedTurn = observed.get(threadId) ?? null;
    const turns = Array.isArray(turnLists[threadId]) ? turnLists[threadId] : [];
    const newestTurn = turns[0] ?? null;
    const goal = goals[threadId] ?? null;
    const prepared = takeovers.get(threadId) ?? null;
    const takeover = prepared
      ? {
        prepared: true,
        claimed: prepared.claimedAt !== null && prepared.claimedAt !== undefined,
        path: prepared.path ?? "",
        preparedAt: prepared.preparedAt ?? null,
        claimedAt: prepared.claimedAt ?? null,
        claimedBy: prepared.claimedBy ?? "",
      }
      : null;
    const probed = items[threadId] ?? null;
    const halt = halted.get(threadId) ?? null;
    // Halted threads arrive either as `threadId -> reason` pairs (the channel) or
    // as a Map of records (a caller holding the autopilot itself).
    const haltReason = typeof halt === "string" ? halt : halt?.reason ?? null;
    const { state, basis, reasons, evidence } = deriveTaskState({
      thread,
      queue: queued,
      item: probed,
      waitingCount,
      turn: newestTurn,
      goal,
      observedTurn,
      now,
      failureMs: input.failureMs,
      autopilotStopped: haltReason,
    });

    // Codex's own words: the newest agent message of the newest turn. This is
    // what a supervision brief quotes, so it comes from the recorded items
    // rather than from anything this bridge composes.
    const messages = Array.isArray(newestTurn?.items?.messages) ? newestTurn.items.messages : [];
    const spoken = [...messages].reverse().find((entry) => entry?.type === "agentMessage") ?? null;

    const card = {
      threadId,
      shortId: String(threadId ?? "").slice(0, 8),
      title: thread.title ?? null,
      preview: thread.preview ?? "",
      cwd: thread.cwd ?? null,
      updatedAt: thread.updatedAt ?? null,
      ageMs: ageOf(thread.updatedAt, now),
      queuedCount: queued.length,
      waitingCount,
      turnStartedAt: observedTurn ? new Date(observedTurn.at).toISOString() : null,
      goal: goal
        ? {
          objective: goal.objective ?? "",
          status: goal.status ?? null,
          tokenBudget: goal.tokenBudget ?? null,
          tokensUsed: goal.tokensUsed ?? null,
          timeUsedSeconds: goal.timeUsedSeconds ?? null,
        }
        : null,
      lastTurnId: newestTurn?.id ?? null,
      turnStatus: newestTurn?.status ?? null,
      turnError: newestTurn?.error ?? null,
      turnStartedAtReported: newestTurn?.startedAt ?? null,
      turnCompletedAt: newestTurn?.completedAt ?? null,
      turnDurationMs: newestTurn?.durationMs ?? null,
      turnItemCount: newestTurn?.items?.count ?? null,
      turnItemCounts: newestTurn?.items?.counts ?? null,
      recentTurns: turnStrip(turns, 8),
      progress: progressOf({ plan: plans[threadId] ?? null, goal, turn: newestTurn }),
      state,
      stateBasis: basis,
      reasons,
      evidence,
      autopilotStopped: haltReason,
      autopilotPaused: pausedIds.has(threadId),
      lastItem: probed?.last
        ? {
          type: probed.last.type ?? null,
          text: clamp(probed.last.text ?? "", LAST_ITEM_CHARS),
          turnId: probed.last.turnId ?? null,
        }
        : null,
      lastItemStatus: probed?.status ?? null,
      takeover,
      lastSpoken: spoken ? clamp(String(spoken.text ?? "").replace(/\s+/g, " ").trim(), LAST_SPOKEN_CHARS) : null,
      lastSpokenPhase: spoken?.phase ?? null,
      column: state,
    };

    // When the newest turn failed: how long ago it stopped. task-state already
    // worked this out from the turn's own completion time (falling back to the
    // thread's last activity), so one number drives both the colour and the brief.
    card.failureAgeMs = String(card.turnStatus ?? "").toLowerCase() === "failed"
      ? (Number.isFinite(evidence?.failureAgeMs) ? evidence.failureAgeMs : ageOf(thread.updatedAt, now))
      : null;
    card.failure = classifyFailure(card);
    return card;
  });

  const columns = BOARD_COLUMNS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    hint: definition.hint,
    cards: cards.filter((card) => card.column === definition.id).sort(byRecency),
  }));

  const totals = { threads: cards.length, needsHuman: 0, blocked: 0, running: 0, noActivity: 0, queuedMessages: 0, waiting: 0 };
  for (const card of cards) {
    if (card.state === "needs-human") totals.needsHuman += 1;
    else if (card.state === "blocked") totals.blocked += 1;
    else if (card.state === "running") totals.running += 1;
    else totals.noActivity += 1;
    if (card.waitingCount > 0) totals.waiting += 1;
  }
  totals.queuedMessages = cards.reduce((sum, card) => sum + card.queuedCount, 0);

  return {
    generatedAt: new Date(now).toISOString(),
    columns,
    cards,
    totals,
    unattachedApprovals,
  };
}

/**
 * Ask the app-server for one board snapshot.
 *
 * Read-only by construction: `thread/list`, `thread/items/list`,
 * `thread/queue/list`, `thread/turns/list`, `thread/goal/get`, `account/read`
 * and `account/rateLimits/read` are all reads, and the only other inputs are
 * the in-process notification buffer and the autopilot's own counters.
 *
 * @param client - a started app-server client.
 * @param bridge - the shared bridge (for the retained notification stream).
 * @param options - `{ maxThreads, maxQueueProbes, maxItemProbes, maxTurnProbes, includeAccount, autopilotHalted, now }`.
 * @returns the board plus a `probe` block saying what was and was not looked at.
 */
export async function collectBoard(client, bridge = null, options = {}) {
  const maxThreads = options.maxThreads ?? DEFAULT_MAX_THREADS;
  const maxQueueProbes = Math.min(options.maxQueueProbes ?? DEFAULT_MAX_QUEUE_PROBES, maxThreads);
  const maxItemProbes = Math.min(options.maxItemProbes ?? DEFAULT_MAX_ITEM_PROBES, maxThreads);
  const maxTurnProbes = Math.min(options.maxTurnProbes ?? DEFAULT_MAX_TURN_PROBES, maxThreads);
  const includeAccount = options.includeAccount !== false;
  const warnPct = options.warnPct;
  const notifications = bridge?.recentNotifications ?? [];

  const threads = await listThreads(client, { limit: maxThreads });

  const queues = {};
  const probed = [];
  const probeErrors = [];
  await Promise.all(threads.slice(0, maxQueueProbes).map(async (thread) => {
    const threadId = thread.id;
    try {
      const result = await client.call("thread/queue/list", { threadId });
      queues[threadId] = Array.isArray(result?.data) ? result.data : [];
      probed.push(threadId);
    } catch (error) {
      queues[threadId] = [];
      probeErrors.push({ threadId, message: String(error?.message ?? error) });
    }
  }));

  const items = {};
  const itemProbed = [];
  const itemProbeErrors = [];
  await Promise.all(threads.slice(0, maxItemProbes).map(async (thread) => {
    const threadId = thread.id;
    try {
      const result = await client.call("thread/items/list", {
        threadId,
        limit: ITEM_PROBE_LIMIT,
        sortDirection: "desc",
      });
      const entries = (Array.isArray(result?.data) ? result.data : [])
        .map((entry) => ({ item: entry?.item, turnId: entry?.turnId ?? null }))
        .filter((entry) => entry.item && typeof entry.item === "object");
      const newest = entries[0] ?? null;
      const labelled = entries.find((entry) => !UNLABELED_ITEM_TYPES.has(entry.item.type)) ?? newest;
      items[threadId] = {
        last: labelled ? { ...renderItem(labelled.item), turnId: labelled.turnId } : null,
        status: labelled?.item?.status ?? null,
      };
      itemProbed.push(threadId);
    } catch (error) {
      items[threadId] = { last: null, status: null };
      itemProbeErrors.push({ threadId, message: String(error?.message ?? error) });
    }
  }));

  // Turns decide each card's state, and goals say whether a stopped task is
  // still supposed to be running. Both are separate round trips, so they fail
  // separately: a Codex build without `thread/goal/get` still yields a board.
  const turnLists = {};
  const goals = {};
  const turnProbed = [];
  const turnProbeErrors = [];
  const goalProbed = [];
  const goalProbeErrors = [];
  await Promise.all(threads.slice(0, maxTurnProbes).map(async (thread) => {
    const threadId = thread.id;
    try {
      turnLists[threadId] = await listTurns(client, { threadId, limit: TURN_PROBE_LIMIT });
      turnProbed.push(threadId);
    } catch (error) {
      turnLists[threadId] = [];
      turnProbeErrors.push({ threadId, message: String(error?.message ?? error) });
    }
    try {
      goals[threadId] = await readGoal(client, threadId);
      goalProbed.push(threadId);
    } catch (error) {
      goals[threadId] = null;
      goalProbeErrors.push({ threadId, message: String(error?.message ?? error) });
    }
  }));

  const plans = {};
  let plansFromNotifications = 0;
  for (const thread of threads.slice(0, maxTurnProbes)) {
    const plan = planFromNotifications(notifications, thread.id);
    if (plan) {
      plans[thread.id] = plan;
      plansFromNotifications += 1;
    }
  }

  const approvals = (client.pendingServerRequests?.() ?? []).map((request) => ({
    id: request?.id ?? null,
    method: request?.method ?? null,
    threadId: threadIdOf(request?.params),
  }));

  const turns = observeTurnState(notifications);
  const board = buildBoard({
    threads,
    queues,
    items,
    approvals,
    turns,
    turnLists,
    goals,
    plans,
    takeovers: options.takeovers,
    autopilotHalted: options.autopilotHalted,
    autopilotPaused: options.autopilotPaused,
    failureMs: options.failureMs,
    now: options.now,
  });

  let account = null;
  // The raw `account/rateLimits/read` answer, kept so the panel's budget line and
  // the `codex_budget` tool come from one predicate rather than two.
  let rawLimits = null;
  let accountError = null;
  if (includeAccount) {
    try {
      const state = await readAccountState(client);
      rawLimits = state.limits;
      accountError = state.account?.error ?? null;
      account = {
        email: state.account?.account?.email ?? state.account?.email ?? null,
        planType: compactLimits(state.limits)?.planType ?? null,
        limits: compactLimits(state.limits),
        error: accountError,
      };
    } catch (error) {
      accountError = String(error?.message ?? error);
      account = { email: null, planType: null, limits: null, error: accountError };
    }
  }

  const referenceNow = Number.isFinite(options.now) ? options.now : Date.now();
  const quota = includeAccount
    ? budgetFromLimits(rawLimits ? { ...rawLimits } : { error: accountError ?? "the account read returned nothing" }, { warnPct, now: referenceNow })
    : null;

  const unprobed = threads.filter((thread) => !probed.includes(thread.id) && !probeErrors.some((entry) => entry.threadId === thread.id));
  const itemUnprobed = threads.filter((thread) => !itemProbed.includes(thread.id) && !itemProbeErrors.some((entry) => entry.threadId === thread.id));
  const turnUnprobed = threads.filter((thread) => !turnProbed.includes(thread.id) && !turnProbeErrors.some((entry) => entry.threadId === thread.id));
  const goalUnprobed = threads.filter((thread) => !goalProbed.includes(thread.id) && !goalProbeErrors.some((entry) => entry.threadId === thread.id));

  return {
    ...board,
    account,
    quota,
    probe: {
      maxThreads,
      maxQueueProbes,
      maxItemProbes,
      maxTurnProbes,
      threadsListed: threads.length,
      queueProbed: probed,
      queueProbeErrors: probeErrors,
      queueUnprobedThreadIds: unprobed.map((thread) => thread.id),
      queueCoverageComplete: unprobed.length === 0 && probeErrors.length === 0,
      itemProbed,
      itemProbeErrors,
      itemUnprobedThreadIds: itemUnprobed.map((thread) => thread.id),
      itemCoverageComplete: itemUnprobed.length === 0 && itemProbeErrors.length === 0,
      turnProbed,
      turnProbeErrors,
      turnUnprobedThreadIds: turnUnprobed.map((thread) => thread.id),
      turnCoverageComplete: turnUnprobed.length === 0 && turnProbeErrors.length === 0,
      goalProbed,
      goalProbeErrors,
      goalUnprobedThreadIds: goalUnprobed.map((thread) => thread.id),
      goalCoverageComplete: goalUnprobed.length === 0 && goalProbeErrors.length === 0,
      plansFromNotifications,
      notificationsRetained: notifications.length,
    },
  };
}
