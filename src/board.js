/**
 * The read-only projection behind the Codex board panel.
 *
 * The panel is presentation only: every judgement about *what is true* is made
 * here, in pure functions, so the board can be unit-tested without a DOM and so
 * the panel cannot quietly invent a status the protocol never reported.
 *
 * The honesty rules this module exists to enforce:
 *  - the last column is "no observed activity", never "idle": a notification
 *    only reaches the connection that owns the turn (docs/limitations.md), so
 *    silence in this process proves nothing about the thread;
 *  - a turn is reported as running only when *this* connection saw it start and
 *    has not seen it finish;
 *  - approval counts cover only the server requests this process is holding;
 *  - queue counts are only as complete as the probes that actually ran, and the
 *    snapshot carries that coverage with it;
 *  - a card's "last" line is the newest item the rollout reports that is not
 *    encrypted reasoning, and its status is printed verbatim: neither is turned
 *    into a claim about the turn.
 *
 * @module dsh-codex-bridge/board
 */
import { clamp, compactLimits, listThreads, readAccountState, renderItem } from "./codex.js";

/** How many recent threads one snapshot looks at. */
export const DEFAULT_MAX_THREADS = 12;

/** How many of those threads get a `thread/queue/list` probe (each probe is one round trip). */
export const DEFAULT_MAX_QUEUE_PROBES = 6;

/** How many of those threads get a `thread/items/list` probe for their last action. */
export const DEFAULT_MAX_ITEM_PROBES = 6;

/** How many recent items one probe reads: enough to look past the trailing reasoning items. */
export const ITEM_PROBE_LIMIT = 3;

/** How much of an item's text reaches a card label. */
export const LAST_ITEM_CHARS = 180;

/**
 * Item types the card label skips.
 *
 * Reasoning items trail almost every turn and their text is encrypted, so the
 * newest non-reasoning item is the one that says what actually happened last.
 */
const UNLABELED_ITEM_TYPES = new Set(["reasoning"]);

/**
 * Board columns, in display order.
 *
 * A card lands in the first column whose question it answers "yes" to, so a
 * thread waiting for an approval is never hidden behind a queue entry.
 */
export const BOARD_COLUMNS = [
  {
    id: "waiting-approval",
    label: "Waiting for approval",
    hint: "An inbound server request this connection is holding and Codex is waiting on.",
  },
  {
    id: "running",
    label: "Turn observed here",
    hint: "This connection saw turn/started and has not seen it finish. Turns the desktop app runs are not visible here.",
  },
  {
    id: "queued",
    label: "Queued messages",
    hint: "thread/queue/list answered with at least one waiting submission.",
  },
  {
    id: "unobserved",
    label: "No observed activity",
    hint: "Not proof of idleness — this connection only hears about turns it owns. Check the thread to know.",
  },
];

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
 * @param input - `{ threads, queues, items, approvals, turns, now }`.
 * @returns `{ generatedAt, columns, totals, unattachedApprovals }`.
 */
export function buildBoard(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const threads = Array.isArray(input.threads) ? input.threads : [];
  const queues = input.queues ?? {};
  const items = input.items ?? {};
  const approvals = Array.isArray(input.approvals) ? input.approvals : [];
  const turns = input.turns instanceof Map ? input.turns : new Map();

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
    const queued = Array.isArray(queues[thread.id]) ? queues[thread.id] : [];
    const waitingCount = waitingByThread.get(thread.id) ?? 0;
    const turn = turns.get(thread.id) ?? null;
    const probed = items[thread.id] ?? null;
    const column = waitingCount > 0
      ? "waiting-approval"
      : (turn ? "running" : (queued.length > 0 ? "queued" : "unobserved"));
    return {
      threadId: thread.id,
      shortId: String(thread.id ?? "").slice(0, 8),
      title: thread.title ?? null,
      preview: thread.preview ?? "",
      cwd: thread.cwd ?? null,
      updatedAt: thread.updatedAt ?? null,
      ageMs: ageOf(thread.updatedAt, now),
      queuedCount: queued.length,
      waitingCount,
      turnStartedAt: turn ? new Date(turn.at).toISOString() : null,
      lastItem: probed?.last
        ? {
          type: probed.last.type ?? null,
          text: clamp(probed.last.text ?? "", LAST_ITEM_CHARS),
          turnId: probed.last.turnId ?? null,
        }
        : null,
      lastItemStatus: probed?.status ?? null,
      column,
    };
  });

  const columns = BOARD_COLUMNS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    hint: definition.hint,
    cards: cards.filter((card) => card.column === definition.id).sort(byRecency),
  }));

  const totals = { threads: cards.length, waiting: 0, running: 0, queued: 0, unobserved: 0 };
  for (const card of cards) {
    if (card.waitingCount > 0) totals.waiting += 1;
    else if (card.column === "running") totals.running += 1;
    else if (card.queuedCount > 0) totals.queued += 1;
    else totals.unobserved += 1;
  }
  totals.queuedMessages = cards.reduce((sum, card) => sum + card.queuedCount, 0);

  return {
    generatedAt: new Date(now).toISOString(),
    columns,
    totals,
    unattachedApprovals,
  };
}

/**
 * Ask the app-server for one board snapshot.
 *
 * Read-only by construction: `thread/list`, `thread/items/list`,
 * `thread/queue/list`, `account/read` and `account/rateLimits/read` are all
 * reads, and the only other input is the in-process notification buffer.
 *
 * @param client - a started app-server client.
 * @param bridge - the shared bridge (for the retained notification stream).
 * @param options - `{ maxThreads, maxQueueProbes, maxItemProbes, includeAccount }`.
 * @returns the board plus a `probe` block saying what was and was not looked at.
 */
export async function collectBoard(client, bridge = null, options = {}) {
  const maxThreads = options.maxThreads ?? DEFAULT_MAX_THREADS;
  const maxQueueProbes = Math.min(options.maxQueueProbes ?? DEFAULT_MAX_QUEUE_PROBES, maxThreads);
  const maxItemProbes = Math.min(options.maxItemProbes ?? DEFAULT_MAX_ITEM_PROBES, maxThreads);
  const includeAccount = options.includeAccount !== false;

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

  const approvals = (client.pendingServerRequests?.() ?? []).map((request) => ({
    id: request?.id ?? null,
    method: request?.method ?? null,
    threadId: threadIdOf(request?.params),
  }));

  const turns = observeTurnState(bridge?.recentNotifications ?? []);
  const board = buildBoard({ threads, queues, items, approvals, turns });

  let account = null;
  if (includeAccount) {
    try {
      const state = await readAccountState(client);
      account = {
        email: state.account?.account?.email ?? state.account?.email ?? null,
        planType: compactLimits(state.limits)?.planType ?? null,
        limits: compactLimits(state.limits),
        error: state.account?.error ?? null,
      };
    } catch (error) {
      account = { email: null, planType: null, limits: null, error: String(error?.message ?? error) };
    }
  }

  const unprobed = threads.filter((thread) => !probed.includes(thread.id) && !probeErrors.some((entry) => entry.threadId === thread.id));
  const itemUnprobed = threads.filter((thread) => !itemProbed.includes(thread.id) && !itemProbeErrors.some((entry) => entry.threadId === thread.id));

  return {
    ...board,
    account,
    probe: {
      maxThreads,
      maxQueueProbes,
      maxItemProbes,
      threadsListed: threads.length,
      queueProbed: probed,
      queueProbeErrors: probeErrors,
      queueUnprobedThreadIds: unprobed.map((thread) => thread.id),
      queueCoverageComplete: unprobed.length === 0 && probeErrors.length === 0,
      itemProbed,
      itemProbeErrors,
      itemUnprobedThreadIds: itemUnprobed.map((thread) => thread.id),
      itemCoverageComplete: itemUnprobed.length === 0 && itemProbeErrors.length === 0,
      notificationsRetained: (bridge?.recentNotifications ?? []).length,
    },
  };
}
