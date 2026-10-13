/**
 * Task state and progress: the one place a card's colour comes from.
 *
 * The panel paints, this module judges. Every colour is produced by a named
 * rule with a printable reason, and every reason says whether Codex *reported*
 * it or this plugin *inferred* it — an inferred signal is never enough on its
 * own to keep a human away (see `needs-human` below), but it is enough to say
 * "this looks like it is running".
 *
 * The four states, in display order:
 *  - `needs-human` (red): a person has to act. An approval this connection is
 *    holding, a turn Codex marked failed, a system error, a goal Codex reported
 *    as blocked/errored, an autopilot that stopped on its own, or a turn that
 *    ended with a question.
 *  - `blocked` (orange): stopped, and nothing says a person is needed — an
 *    active goal with no turn running, a turn that stopped before finishing, a
 *    failed last command, or a queued message nobody consumed.
 *  - `running` (green): a turn is advancing. Reported when Codex says so or
 *    when this connection saw the turn start; inferred when the rollout was
 *    touched seconds ago and the newest turn has no completion time.
 *  - `no-activity` (grey): nothing observed. Not proof of idleness — see
 *    docs/limitations.md; this connection only hears about turns it owns.
 *
 * @module dsh-codex-bridge/task-state
 */

/** States, in display order. */
export const TASK_STATES = ["needs-human", "blocked", "running", "no-activity"];

/** Human labels for those states. */
export const STATE_LABELS = {
  "needs-human": "Needs you",
  blocked: "Blocked",
  running: "Running",
  "no-activity": "Nothing observed",
};

/** The one-line honesty note each column carries. */
export const STATE_HINTS = {
  "needs-human": "Something here wants a person: an approval this connection is holding, a failed turn, or a question Codex asked. Only what this process can see is counted.",
  blocked: "Stopped without a known person-action: an active goal with no turn running, a turn that ended early, a failed last command, or a queued message nobody consumed.",
  running: "A turn is advancing, as reported by Codex or by this connection's own notification stream. 'Inferred' rows rest on a recent rollout timestamp.",
  "no-activity": "Not proof of idleness — this connection only hears about turns it owns. Check the thread to know.",
};

/** Turn statuses that mean the turn is still advancing. */
export const TURN_RUNNING_STATUSES = new Set(["inprogress", "running", "active", "started"]);

/** Turn statuses that mean the turn is over, however it ended. */
export const TURN_ENDED_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "canceled", "aborted", "errored"]);

/** Goal statuses Codex uses for "this goal is not progressing". */
const GOAL_BLOCKED_STATUSES = new Set(["blocked", "paused", "cancelled", "canceled", "errored", "failed"]);

/** Item statuses that mean the recorded action failed. */
const ITEM_FAILED_STATUSES = new Set(["failed", "error", "errored"]);

/**
 * How recently a rollout must have been touched before a rollup with no
 * completion time is treated as an advancing turn. This is the weakest signal
 * this module accepts, and it is always labelled `inferred`.
 */
export const FRESH_ACTIVITY_MS = 90_000;

/**
 * How long a failed turn keeps a card in "Needs you".
 *
 * A failure the user watched happen (and chose not to retry) is not a task
 * waiting on them a week later: the board's first live run produced three red
 * cards whose newest failures were seconds, 3.6 days and 12.8 days old, and only
 * the first wanted anything. A thread that still carries a goal keeps its red at
 * any age, because a goal is Codex's standing statement about work that is meant
 * to be running; without one, an old failure stays on the card as evidence and
 * the card settles to "nothing observed" instead of shouting forever.
 */
export const FAILURE_ATTENTION_MS = 48 * 60 * 60_000;

/**
 * Render an age in the roughest unit that still says something.
 * @param ms - milliseconds.
 * @returns text like `12 minutes`, `4 hours`, `3.6 days`.
 */
export function formatAge(ms) {
  if (!Number.isFinite(ms)) return "an unknown time";
  const minutes = ms / 60_000;
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)} days`;
}

/**
 * Normalise a status string for comparison.
 * @param status - any status value from the protocol.
 * @returns lowercase, punctuation-free text.
 */
export function statusKey(status) {
  return String(status ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Which of the four states a thread is in, and why. Pure.
 * @param input - `{ thread, queue, item, waitingCount, turn, goal, observedTurn, now, freshMs, failureMs, autopilotStopped }`.
 * @returns `{ state, basis, reasons, evidence }`.
 */
export function deriveTaskState(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const freshMs = Number.isFinite(input.freshMs) ? input.freshMs : FRESH_ACTIVITY_MS;
  const failureMs = Number.isFinite(input.failureMs) ? input.failureMs : FAILURE_ATTENTION_MS;
  const thread = input.thread ?? {};
  const queue = Array.isArray(input.queue) ? input.queue : [];
  const waitingCount = Number(input.waitingCount ?? 0);
  const turn = input.turn ?? null;
  const goal = input.goal ?? null;
  const turnKey = statusKey(turn?.status);
  const goalKey = statusKey(goal?.status);
  const updatedMs = thread.updatedAt ? Date.parse(thread.updatedAt) : NaN;
  const activityAgeMs = Number.isFinite(updatedMs) ? Math.max(0, now - updatedMs) : null;

  const evidence = {
    turnId: turn?.id ?? null,
    turnStatus: turn?.status ?? null,
    goalStatus: goal?.status ?? null,
    lastItemStatus: input.item?.status ?? null,
    waitingCount,
    queuedCount: queue.length,
    activityAgeMs,
    threadStatus: thread.status ?? null,
  };

  const reasons = [];
  const state = decide();
  const basis = reasons.some((entry) => entry.basis === "inferred") ? "inferred" : "reported";
  return { state, basis, reasons, evidence };

  /** @returns the state id, filling `reasons` as it goes. */
  function decide() {
    const add = (code, text, why) => reasons.push({ code, text, basis: why });

    // A person has to act.
    if (waitingCount > 0) {
      add("approval", `Codex is waiting for ${waitingCount === 1 ? "an approval" : `${waitingCount} approvals`} this connection is holding.`, "reported");
      return "needs-human";
    }
    if (statusKey(thread.status) === "systemerror") {
      add("thread-system-error", `Codex reports this thread's own status as ${thread.status}.`, "reported");
      return "needs-human";
    }
    if (turnKey === "failed") {
      const detail = turn?.error?.message ? `: ${turn.error.message}` : " and recorded no detail";
      const stale = !goalKey && activityAgeMs !== null && activityAgeMs > failureMs;
      if (stale) {
        add("turn-failed-stale", `The newest turn failed${detail}. That was ${formatAge(activityAgeMs)} ago, the thread has no goal, and nothing has moved since — kept as history rather than a call for you.`, "reported");
        return "no-activity";
      }
      add("turn-failed", `The newest turn failed${detail}${activityAgeMs !== null ? ` (${formatAge(activityAgeMs)} ago)` : ""}.`, "reported");
      return "needs-human";
    }
    if (goalKey && GOAL_BLOCKED_STATUSES.has(goalKey)) {
      add("goal-stopped", `Codex reports the thread's goal as ${goal.status}${activityAgeMs !== null ? ` (last activity ${formatAge(activityAgeMs)} ago)` : ""}.`, "reported");
      return "needs-human";
    }
    if (input.autopilotStopped) {
      add("autopilot-stopped", String(input.autopilotStopped), "reported");
      return "needs-human";
    }

    // Running beats everything below it: a live turn is neither blocked nor idle.
    const observed = isObserved();
    const reported = observed || TURN_RUNNING_STATUSES.has(turnKey);
    const openEnded = Boolean(turn) && !turn.completedAt && !TURN_ENDED_STATUSES.has(turnKey);
    const fresh = activityAgeMs !== null && activityAgeMs <= freshMs;
    if (reported) {
      add("turn-running", observed
        ? "This connection saw this thread's turn start and has not seen it finish."
        : `Codex reports the newest turn as ${turn.status}.`, "reported");
      return "running";
    }
    if (openEnded && fresh) {
      add("activity-fresh", `No running status was reported, but the rollout was touched ${Math.round(activityAgeMs / 1000)}s ago and the newest turn has no completion time.`, "inferred");
      return "running";
    }

    // A question is the one "needs a person" signal that has no structured field,
    // so it is parsed from the newest answer and always labelled as an inference.
    const question = trailingQuestion(turn);
    if (question) {
      add("question-inferred", `The newest answer ends with a question — read as "Codex is waiting for you" (inferred from the text, not from a status field).`, "inferred");
      return "needs-human";
    }

    // Stopped, without anyone to page.
    if (goalKey === "active") {
      add("goal-active-no-turn", "The thread has an active goal but no turn is running, so nothing is advancing it.", "reported");
      return "blocked";
    }
    if (turn && (turnKey === "interrupted" || turnKey === "cancelled" || turnKey === "canceled") && !turn.completedAt) {
      add("turn-unfinished", `The newest turn is ${turn.status} with no completion time: it stopped before finishing${fresh ? " (the rollout was touched seconds ago, but an explicit stop beats that inference)" : ""}.`, "reported");
      return "blocked";
    }
    if (ITEM_FAILED_STATUSES.has(statusKey(input.item?.status))) {
      add("last-item-failed", `The last recorded action (${input.item?.last?.type ?? "item"}) is ${input.item.status} and no turn is running.`, "reported");
      return "blocked";
    }
    if (queue.length > 0) {
      add("queue-waiting", `${queue.length} queued ${queue.length === 1 ? "message is" : "messages are"} waiting and no turn is running to consume ${queue.length === 1 ? "it" : "them"}.`, "reported");
      return "blocked";
    }

    // Nothing to say.
    if (turn) {
      add("turn-settled", turn.completedAt
        ? `The newest turn is ${turn.status} and no goal is active.`
        : "The newest turn reports no activity and no goal is active.", "reported");
    } else {
      add("no-turn-report", "No turn was reported for this thread by any probe that ran.", "reported");
    }
    return "no-activity";
  }

  /** @returns the notification-derived open turn, when it matches the probed turn. */
  function isObserved() {
    const seen = input.observedTurn ?? null;
    if (!seen) return null;
    if (turn?.id && seen.turnId && seen.turnId !== turn.id) return null;
    return seen;
  }
}

/**
 * The newest agent answer, when it ends in a question.
 * @param turn - a compact turn record.
 * @returns the question text, or null.
 */
export function trailingQuestion(turn) {
  const messages = turn?.items?.messages ?? [];
  const answers = messages.filter((entry) => entry.type === "agentMessage" && entry.text);
  const last = answers[answers.length - 1];
  if (!last) return null;
  const text = String(last.text).trim();
  if (!text.endsWith("?") && !text.endsWith("？")) return null;
  const line = text.split("\n").filter(Boolean).pop() ?? text;
  return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}

/**
 * How far along a task is — only when Codex reports a denominator.
 *
 * Two honest sources exist: a plan Codex emitted (completed steps / steps) and
 * a goal's token budget (`thread/goal/get`). When neither is present this
 * returns `percent: null` and the panel shows counts instead of inventing a bar.
 *
 * @param input - `{ plan, goal, turn }`.
 * @returns `{ kind, percent, label, detail, source, steps }`.
 */
export function progressOf(input = {}) {
  const steps = Array.isArray(input.plan?.steps) ? input.plan.steps : [];
  if (steps.length > 0) {
    const done = steps.filter((step) => /done|complete|finish/i.test(statusKey(step.status))).length;
    const current = steps.find((step) => !/done|complete|finish/i.test(statusKey(step.status)));
    return {
      kind: "plan",
      percent: Math.round((done / steps.length) * 100),
      label: `${done}/${steps.length} steps`,
      detail: current ? `current: ${current.step}` : "every reported step is complete",
      source: input.plan?.at ? `a plan Codex reported at ${new Date(input.plan.at).toISOString()}` : "a plan Codex reported",
      steps,
    };
  }

  const used = input.goal?.tokensUsed;
  const budget = input.goal?.tokenBudget;
  if (Number.isFinite(used) && Number.isFinite(budget) && budget > 0) {
    const percent = Math.min(100, Math.round((used / budget) * 100));
    return {
      kind: "goal-budget",
      percent,
      label: `${percent}% of the goal's token budget`,
      detail: `${used} of ${budget} tokens used`,
      source: "thread/goal/get",
      steps: [],
    };
  }

  return { kind: "none", percent: null, label: "", detail: "", source: null, steps: [] };
}

/**
 * The last few turns, oldest first, for a strip of per-turn colours.
 * @param turns - compact turns, newest first.
 * @param limit - how many to keep.
 * @returns `[{ id, status }]`.
 */
export function turnStrip(turns, limit = 8) {
  const recent = (Array.isArray(turns) ? turns : []).slice(0, Math.max(0, limit));
  return recent.reverse().map((turn) => ({ id: turn?.id ?? null, status: turn?.status ?? null }));
}

/**
 * Pull the newest plan out of the retained notification stream.
 *
 * The payload shape of `turn/plan/updated` is not in the recorded protocol
 * notes, so this reads it defensively and returns null when nothing parses;
 * the caller labels the resulting bar with its source either way.
 *
 * @param notifications - `{ at, method, params }` records, oldest first.
 * @param threadId - the thread to look for.
 * @returns `{ at, steps: [{ step, status }] }` or null.
 */
export function planFromNotifications(notifications = [], threadId) {
  let found = null;
  for (const notice of notifications) {
    if (!notice || typeof notice.method !== "string") continue;
    if (notice.method !== "turn/plan/updated" && notice.method !== "item/plan/delta") continue;
    const params = notice.params ?? {};
    const owner = params.threadId ?? params.turn?.threadId ?? params.thread?.id ?? null;
    if (threadId && owner && owner !== threadId) continue;
    const steps = planSteps(params);
    if (steps.length > 0) found = { at: notice.at ?? 0, steps };
  }
  return found;
}

/**
 * Read `[{ step, status }]` out of a plan payload.
 * @param params - notification parameters.
 * @returns the parsed steps, possibly empty.
 */
export function planSteps(params = {}) {
  const candidates = [params.plan?.steps, params.plan?.items, params.steps, params.item?.steps, params.item?.items, params.plan];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const steps = candidate
      .map((entry) => ({
        step: String(entry?.step ?? entry?.text ?? entry?.content ?? entry?.title ?? "").trim(),
        status: entry?.status ?? "pending",
      }))
      .filter((entry) => entry.step.length > 0);
    if (steps.length > 0) return steps;
  }
  return [];
}
