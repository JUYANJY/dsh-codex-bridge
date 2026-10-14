/**
 * Auto-continue: the one write this plugin performs on its own.
 *
 * The board (docs/limitations.md) can see a task that stopped without needing a
 * person: the goal is still active, the last turn simply ended. The useful
 * thing to do about that is to hand Codex one more message — so the panel can
 * arm a *bounded, observable, reversible* autopilot that does exactly that and
 * nothing else:
 *
 *  - it is off until a human arms it in the panel, and the arming expires;
 *  - it never answers an approval — an inbound request means "a person", and a
 *    person is what the card says;
 *  - it only ever writes through `thread/queue/add`, the one path that works
 *    against a session another process owns (docs/limitations.md);
 *  - it sends at most `maxPerThread` / `maxTotal` messages per window and never
 *    twice for the same stuck turn (fingerprint), never while a turn runs,
 *    never while a message is already queued, and never until the thread has
 *    been quiet for `settleMs`;
 *  - every decision — sent or skipped, and why — is appended to a bounded log
 *    the panel shows, so "why did it not continue?" always has an answer;
 *  - two consecutive send failures for one thread stop that thread and turn its
 *    card red, instead of retrying quietly forever.
 *
 * @module dsh-codex-bridge/autopilot
 */
import { newClientMessageId } from "./app-server.js";
import { clamp } from "./codex.js";
import { classifyFailure, supervisionBrief } from "./supervise.js";
import { replayGuard } from "./workspace.js";

/** Policy defaults. `ttlMs` is how long one arming lasts. */
export const AUTOPILOT_DEFAULTS = {
  armed: false,
  ttlMs: 30 * 60_000,
  maxPerThread: 3,
  maxTotal: 10,
  minIntervalMs: 120_000,
  settleMs: 30_000,
  messageChars: 1500,
};

/** The message used when the thread has a goal objective. */
export const CONTINUE_WITH_GOAL = "继续（DeepSeek Harness 自动续跑）：{objective}";

/** The message used when it does not. */
export const CONTINUE_PLAIN = "继续（DeepSeek Harness 自动续跑）";

/** How many log entries and per-thread records to keep. */
const MAX_LOG = 80;

/** How many consecutive send failures stop a thread. */
export const MAX_SEND_FAILURES = 2;

/**
 * Collapse a value to one short line.
 * @param value - anything printable.
 * @param limit - maximum characters.
 * @returns the collapsed text.
 */
function oneLine(value, limit) {
  return clamp(String(value ?? "").replace(/\s+/g, " ").trim(), limit);
}

/**
 * The message the autopilot hands Codex.
 * @param card - a board card.
 * @param template - optional `{objective}` / `{lastMessage}` / `{threadId}` template.
 * @returns the message text.
 */
export function continueMessage(card = {}, template = null) {
  const objective = oneLine(card.goal?.objective, 400);
  const custom = typeof template === "string" && template.trim() ? template.trim() : null;
  if (custom) {
    const text = custom
      .split("{objective}").join(objective || "(no objective recorded)")
      .split("{lastMessage}").join(oneLine(card.lastItem?.text, 400))
      .split("{threadId}").join(String(card.threadId ?? ""));
    return clamp(text, AUTOPILOT_DEFAULTS.messageChars);
  }
  return clamp(objective ? CONTINUE_WITH_GOAL.split("{objective}").join(objective) : CONTINUE_PLAIN, AUTOPILOT_DEFAULTS.messageChars);
}

/**
 * The identity of "this stuck state", so one stuck turn is continued once.
 * @param card - a board card.
 * @returns a short fingerprint.
 */
export function stuckFingerprint(card = {}) {
  return [
    card.lastTurnId ?? "no-turn",
    card.goal?.status ?? "-",
    card.lastItem?.type ?? "-",
  ].join(":");
}

/**
 * Should this card get one more message? Pure; the engine passes its own state in.
 *
 * @param card - a board card (`state`, `waitingCount`, `queuedCount`, `ageMs`, …).
 * @param policy - the active policy (`{ armed, expiresAt, maxPerThread, maxTotal, minIntervalMs, settleMs }`).
 * @param state - `{ paused: Set, sent: Map, total: number, halted: Map }`.
 * @param now - reference time in milliseconds.
 * @returns `{ action: "send" | "skip", code, text, message?, fingerprint }`.
 */
export function decideAutoContinue(card, policy = {}, state = {}, now = Date.now()) {
  const skip = (code, text) => ({ action: "skip", code, text, fingerprint: stuckFingerprint(card) });
  const threadId = card?.threadId ?? "";
  const paused = state.paused instanceof Set ? state.paused : new Set(state.paused ?? []);
  const halted = state.halted instanceof Map ? state.halted : new Map(Object.entries(state.halted ?? {}));
  const sent = state.sent instanceof Map ? state.sent : new Map(Object.entries(state.sent ?? {}));
  const record = sent.get(threadId) ?? { count: 0, lastAt: null, fingerprint: null };

  if (!policy.armed) return skip("not-armed", "The autopilot is not armed.");
  if (Number.isFinite(policy.expiresAt) && now >= policy.expiresAt) return skip("window-expired", "The arming window has expired.");
  if (paused.has(threadId)) return skip("paused", "This thread is paused by hand.");
  if (halted.has(threadId)) return skip("thread-halted", `This thread was stopped after repeated send failures: ${halted.get(threadId)?.reason ?? "unknown"}.`);
  // Two states may be picked up: a task simply stopped with a person-action
  // reported as unnecessary ("blocked"), or a task stopped on a failure whose
  // own error text says it was transient ("needs-human" + retryable). Anything
  // else that is red stays red — that is the whole point of the colour.
  const failure = card.failure ?? classifyFailure(card);
  if (card.state === "needs-human") {
    if (!failure.retryable) {
      return skip("state-needs-human", `A person is needed here: ${failure.text || "the board reported no retryable failure"}.`);
    }
  } else if (card.state !== "blocked") {
    return skip(`state-${card.state ?? "unknown"}`, `The task is ${card.state ?? "unknown"}; the autopilot only continues from "blocked" or a retryable "needs-human".`);
  }
  if (card.waitingCount > 0) return skip("approval-pending", "An approval is waiting: that is work for a person, not for the autopilot.");
  if (String(card.turnStatus ?? "").toLowerCase() === "failed" && !failure.retryable) {
    return skip("turn-failed", `The newest turn failed (${failure.kind ?? "unknown"}): someone has to look at why.`);
  }
  if (card.queuedCount > 0) return skip("already-queued", "A message is already queued and nobody has consumed it.");
  const settleMs = Number.isFinite(policy.settleMs) ? policy.settleMs : AUTOPILOT_DEFAULTS.settleMs;
  if (typeof card.ageMs === "number" && card.ageMs < settleMs) {
    return skip("settling", `The thread was active ${Math.round(card.ageMs / 1000)}s ago; letting it settle first.`);
  }
  const fingerprint = stuckFingerprint(card);
  if (record.fingerprint === fingerprint) return skip("already-continued", "This same unfinished turn was already continued once.");
  const maxPerThread = Number.isFinite(policy.maxPerThread) ? policy.maxPerThread : AUTOPILOT_DEFAULTS.maxPerThread;
  if (record.count >= maxPerThread) return skip("thread-limit", `This thread already used its ${maxPerThread} automatic message(s) in this window.`);
  const maxTotal = Number.isFinite(policy.maxTotal) ? policy.maxTotal : AUTOPILOT_DEFAULTS.maxTotal;
  const total = Number.isFinite(state.total) ? state.total : 0;
  if (total >= maxTotal) return skip("global-limit", `The autopilot already sent its ${maxTotal} message(s) in this window.`);
  const minIntervalMs = Number.isFinite(policy.minIntervalMs) ? policy.minIntervalMs : AUTOPILOT_DEFAULTS.minIntervalMs;
  if (record.lastAt && now - record.lastAt < minIntervalMs) {
    return skip("min-interval", `Waiting ${Math.ceil((minIntervalMs - (now - record.lastAt)) / 1000)}s before this thread can be continued again.`);
  }
  const supervised = failure.retryable && Boolean(failure.kind);
  return {
    action: "send",
    code: supervised ? "send-supervised-retry" : "send",
    text: supervised
      ? `The newest turn stopped on ${failure.text}, which is not a decision for a person, so a supervision message is queued.`
      : "The task is blocked with no person-action reported, so one more message is queued.",
    // Default to the supervision brief: it quotes what Codex actually reported
    // (goal, last words, the failure text and its age) instead of a bare
    // "continue". A template, when configured, still wins.
    message: policy.template ? continueMessage(card, policy.template) : supervisionBrief(card),
    fingerprint,
  };
}

/** Whether a state counts as "a card with a story worth logging". */
function candidate(card) {
  return card?.state === "blocked" || card?.state === "needs-human";
}

/** The autopilot's policy, counters and log. One instance per plugin context. */
export class Autopilot {
  /**
   * @param options - `{ defaults }` overriding `AUTOPILOT_DEFAULTS`.
   */
  constructor(options = {}) {
    this.defaults = { ...AUTOPILOT_DEFAULTS, ...(options.defaults ?? {}) };
    this.policy = { ...this.defaults, armed: false, expiresAt: null };
    this.armedAt = null;
    this.paused = new Set();
    this.halted = new Map();
    this.sent = new Map();
    this.total = 0;
    this.log = [];
    this.lastMessage = null;
    this.passes = 0;
    this.lastPassAt = null;
    this.timer = null;
  }

  /**
   * Arm (or re-arm) the autopilot for a bounded window.
   * @param patch - `{ ttlMinutes, maxPerThread, maxTotal, minIntervalMs, settleMs, template }`.
   * @param now - reference time in milliseconds.
   * @returns the new status.
   */
  arm(patch = {}, now = Date.now()) {
    const ttlMinutes = Number(patch.ttlMinutes);
    const ttlMs = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? Math.min(ttlMinutes, 24 * 60) * 60_000 : this.defaults.ttlMs;
    for (const key of ["maxPerThread", "maxTotal", "minIntervalMs", "settleMs"]) {
      const value = Number(patch[key]);
      if (Number.isFinite(value) && value >= 0) this.policy[key] = Math.floor(value);
    }
    if (typeof patch.template === "string") this.policy.template = patch.template.slice(0, 2000);
    this.policy.armed = true;
    this.policy.expiresAt = now + ttlMs;
    this.armedAt = now;
    this.total = 0;
    this.halted.clear();
    this.record({ at: now, threadId: null, action: "pass", code: "armed", text: `Armed for ${Math.round(ttlMs / 60_000)} minute(s); at most ${this.policy.maxTotal} message(s) overall and ${this.policy.maxPerThread} per thread.` });
    return this.status(now);
  }

  /**
   * Turn the autopilot off.
   * @param reason - why, for the log.
   * @param now - reference time in milliseconds.
   * @returns the new status.
   */
  disarm(reason = "disarmed by hand", now = Date.now()) {
    this.policy.armed = false;
    this.policy.expiresAt = null;
    this.armedAt = null;
    this.record({ at: now, threadId: null, action: "pass", code: "disarmed", text: String(reason) });
    return this.status(now);
  }

  /**
   * Pause or resume one thread.
   * @param threadId - the thread.
   * @param paused - true to pause.
   * @returns the new status.
   */
  setPaused(threadId, paused) {
    if (!threadId) return this.status();
    if (paused) this.paused.add(threadId);
    else {
      this.paused.delete(threadId);
      this.halted.delete(threadId);
    }
    return this.status();
  }

  /**
   * Append a log line, keeping the log bounded.
   * @param entry - `{ at, threadId, action, code, text }`.
   */
  record(entry) {
    this.log.push({
      at: entry.at ?? Date.now(),
      threadId: entry.threadId ?? null,
      action: entry.action ?? "pass",
      code: entry.code ?? null,
      text: entry.text ?? "",
      // Kept small on purpose: the log is shown in every snapshot, the message
      // text itself is kept once in `lastMessage`.
      replayRisk: entry.replayRisk ?? null,
    });
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  /**
   * A JSON-safe view of everything the panel needs to explain the autopilot.
   * @param now - reference time in milliseconds.
   * @returns the status object.
   */
  status(now = Date.now()) {
    return {
      armed: Boolean(this.policy.armed),
      armedAt: this.armedAt ? new Date(this.armedAt).toISOString() : null,
      expiresAt: this.policy.expiresAt ? new Date(this.policy.expiresAt).toISOString() : null,
      remainingMs: this.policy.expiresAt ? Math.max(0, this.policy.expiresAt - now) : null,
      limits: {
        maxPerThread: this.policy.maxPerThread,
        maxTotal: this.policy.maxTotal,
        minIntervalMs: this.policy.minIntervalMs,
        settleMs: this.policy.settleMs,
      },
      template: this.policy.template ?? null,
      sent: [...this.sent.entries()].map(([threadId, record]) => ({
        threadId,
        count: record.count,
        lastAt: record.lastAt ? new Date(record.lastAt).toISOString() : null,
        fingerprint: record.fingerprint ?? null,
        lastMessageId: record.lastMessageId ?? null,
      })),
      total: this.total,
      paused: [...this.paused],
      halted: [...this.halted.entries()].map(([threadId, record]) => ({ threadId, reason: record.reason, at: record.at ? new Date(record.at).toISOString() : null })),
      passes: this.passes,
      lastPassAt: this.lastPassAt ? new Date(this.lastPassAt).toISOString() : null,
      log: this.log.slice(-40),
      lastMessage: this.lastMessage ?? null,
    };
  }

  /**
   * Run one evaluation pass over the current board.
   *
   * Never throws: a send failure is logged, counted, and — after
   * `MAX_SEND_FAILURES` — stops that thread instead of retrying.
   *
   * @param cards - flat board cards.
   * @param options - `{ send, now }` where `send(card, message)` performs the write.
   * @returns `{ armed, considered, sent, skipped, entries }`.
   */
  async runPass(cards = [], options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const entries = [];
    if (!this.policy.armed) return { armed: false, considered: 0, sent: 0, skipped: 0, entries };
    if (this.policy.expiresAt && now >= this.policy.expiresAt) {
      this.disarm("the arming window expired", now);
      this.passes += 1;
      this.lastPassAt = now;
      return { armed: false, considered: 0, sent: 0, skipped: 0, entries: [], reason: "window-expired" };
    }

    const candidates = cards.filter(candidate);
    let sent = 0;
    let skipped = 0;
    for (const card of candidates) {
      const decision = decideAutoContinue(card, this.policy, { paused: this.paused, sent: this.sent, total: this.total, halted: this.halted }, now);
      if (decision.action !== "send") {
        skipped += 1;
        const entry = { at: now, threadId: card.threadId, action: "skip", code: decision.code, text: decision.text };
        entries.push(entry);
        this.record(entry);
        continue;
      }
      try {
        // Resume, do not replay: read the working directory first (never fatal),
        // and compose the message with what it found.
        let workspace = null;
        if (typeof options.workspace === "function") {
          try {
            workspace = await options.workspace(card);
          } catch (error) {
            workspace = { state: "unknown", error: String(error?.message ?? error), changedPaths: [], changedCount: 0 };
          }
        }
        const guard = replayGuard(card, workspace);
        const message = this.policy.template
          ? continueMessage(card, this.policy.template)
          : supervisionBrief(card, { workspace, chars: this.policy.messageChars });
        const detail = await options.send?.(card, message);
        sent += 1;
        const record = this.sent.get(card.threadId) ?? { count: 0, lastAt: null, fingerprint: null, failures: 0 };
        this.sent.set(card.threadId, {
          count: record.count + 1,
          lastAt: now,
          fingerprint: decision.fingerprint,
          failures: 0,
          lastMessageId: detail?.id ?? null,
        });
        this.total += 1;
        // What was actually handed to Codex, so the panel can show it rather
        // than describing it.
        this.lastMessage = { at: now, threadId: card.threadId, text: String(message ?? ""), chars: String(message ?? "").length };
        const entry = {
          at: now,
          threadId: card.threadId,
          action: "sent",
          code: "sent",
          text: `${String(detail?.detail ?? "queued")}${detail?.visible === false ? " (the queue re-read did not show it)" : ""}${guard.risk === "changed" ? " (resumed: the workspace already has changes)" : ""}`,
          message,
          replayRisk: guard.risk,
        };
        entries.push(entry);
        this.record(entry);
      } catch (error) {
        const record = this.sent.get(card.threadId) ?? { count: 0, lastAt: null, fingerprint: null, failures: 0 };
        const failures = (record.failures ?? 0) + 1;
        this.sent.set(card.threadId, { ...record, failures });
        const message = String(error?.message ?? error);
        if (failures >= MAX_SEND_FAILURES) {
          this.halted.set(card.threadId, { at: now, reason: `the autopilot sent nothing after ${failures} attempts: ${message}` });
        }
        const entry = {
          at: now,
          threadId: card.threadId,
          action: "error",
          code: failures >= MAX_SEND_FAILURES ? "halted" : "send-failed",
          text: failures >= MAX_SEND_FAILURES
            ? `Stopped this thread after ${failures} failed sends: ${message}`
            : `Send failed: ${message}`,
        };
        entries.push(entry);
        this.record(entry);
      }
    }

    this.passes += 1;
    this.lastPassAt = now;
    const counts = cards.reduce((accumulator, card) => {
      accumulator[card.state] = (accumulator[card.state] ?? 0) + 1;
      return accumulator;
    }, {});
    this.record({
      at: now,
      threadId: null,
      action: "pass",
      code: "pass",
      text: `${cards.length} thread(s): ${TASK_STATE_SUMMARY(counts)}; ${candidates.length} candidate(s) → ${sent} sent, ${skipped} skipped.`,
    });
    return { armed: true, considered: candidates.length, sent, skipped, entries };
  }

  /**
   * Start a background pass timer. Unref'd: it never holds the host open.
   * @param tick - async `() => void`, called every interval while armed.
   * @param intervalMs - how often to look.
   * @returns the timer, or null when a timer already runs.
   */
  startTimer(tick, intervalMs = 20_000) {
    if (this.timer) return null;
    this.timer = setInterval(() => {
      if (!this.policy.armed) return;
      Promise.resolve()
        .then(() => tick())
        .catch(() => { /* a pass failure must not kill the timer */ });
    }, intervalMs);
    this.timer.unref?.();
    return this.timer;
  }

  /** Stop the background timer. */
  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Forget every counter and log line (used by tests and by a full reset). */
  reset() {
    this.policy = { ...this.defaults, armed: false, expiresAt: null };
    this.armedAt = null;
    this.paused.clear();
    this.halted.clear();
    this.sent.clear();
    this.total = 0;
    this.log = [];
    this.passes = 0;
    this.lastPassAt = null;
  }
}

/**
 * One short state tally for the pass log line.
 * @param counts - state id -> count.
 * @returns a human summary.
 */
function TASK_STATE_SUMMARY(counts = {}) {
  const parts = Object.entries(counts).map(([state, count]) => `${count} ${state}`);
  return parts.length > 0 ? parts.join(", ") : "nothing to report";
}

/**
 * Read the queue back, to say whether the send is actually visible there.
 *
 * @param client - a started app-server client.
 * @param threadId - the thread that was written to.
 * @param submissionId - the id `thread/queue/add` returned, when it returned one.
 * @returns `{ visible, count }` — `visible` is null when the read itself failed.
 */
export async function readQueueVisible(client, threadId, submissionId) {
  try {
    const result = await client.call("thread/queue/list", { threadId });
    const entries = Array.isArray(result?.data) ? result.data : [];
    if (!submissionId) return { visible: null, count: entries.length };
    return { visible: entries.some((entry) => JSON.stringify(entry ?? null).includes(submissionId)), count: entries.length };
  } catch {
    return { visible: null, count: null };
  }
}

/**
 * Queue one message into a thread — the autopilot's only write.
 *
 * @param client - a started app-server client.
 * @param card - the card being continued.
 * @param message - the text.
 * @param options - `{ timeoutMs }`.
 * @returns `{ id, detail, visible }`.
 */
export async function queueAutopilotMessage(client, card, message, options = {}) {
  const result = await client.call("thread/queue/add", {
    threadId: card.threadId,
    clientUserMessageId: newClientMessageId(),
    input: [{ type: "text", text: message }],
  }, { timeoutMs: options.timeoutMs ?? 30_000 });
  const id = result?.queuedSubmission?.id ?? null;
  const readBack = await readQueueVisible(client, card.threadId, id);
  return {
    id,
    detail: `queued as ${id ?? "(no id reported)"}; ${readBack.count === null ? "the queue re-read failed" : `the queue now holds ${readBack.count} message(s)`}`,
    visible: readBack.visible,
  };
}
