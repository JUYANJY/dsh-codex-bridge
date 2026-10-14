/**
 * Takeovers: what happens when Codex runs out of quota.
 *
 * A quota or auth failure is not something the continuation autopilot may retry
 * — but "red forever" is not the only alternative either, which is the point of
 * this module. It splits the red into three honest outcomes:
 *
 *   - nobody has authorised a takeover → stay red, say so;
 *   - a takeover is authorised → build the brief and write it where a person
 *     (or DeepSeek Harness, in a later turn) can pick it up;
 *   - a brief exists but has not been claimed → **it is not done.** The plugin
 *     cannot push into a Harness conversation, so `claimed` may only be set by
 *     an explicit claim (`codex_handoff action=claim`, or the panel button).
 *     A prepared brief is a note on the door, not a handover.
 *
 * Everything is in memory: a Harness restart forgets prepared briefs, and the
 * files it wrote are still on disk for whoever looks.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { collectHandoff } from "./handoff.js";
import { readBudget } from "./quota.js";

/** Where a prepared brief may land when the caller names no path. */
export const HANDOFF_DIR = ".codex-handoff";

/** One prepared-but-unclaimed brief is enough. */
export const MAX_TAKEOVERS = 20;

/**
 * The policy question, separate from any I/O: what should happen to a thread
 * whose budget is gone?
 *
 * @param budget - a `budgetFromLimits()` result, or null when it was not read.
 * @param options - `{ handoffArmed }`.
 * @returns `{ action, reason }` where action is `"none"`, `"keep-red"` or
 *   `"prepare-handoff"`.
 */
export function takeoverDecision(budget, options = {}) {
  if (!budget || budget.level !== "reached") {
    return { action: "none", reason: budget ? `the budget reads "${budget.level}"` : "the budget was not read" };
  }
  if (!options.handoffArmed) {
    return {
      action: "keep-red",
      reason: "the quota is reached and no takeover has been authorised, so this stays a call for a person",
    };
  }
  return {
    action: "prepare-handoff",
    reason: "the quota is reached and a takeover is authorised, so a brief is prepared for whoever takes over",
  };
}

/** The takeovers this run has prepared, and whether anyone has claimed them. */
export class Takeovers {
  constructor() {
    /** @type {Map<string, {threadId, path, preparedAt, claimedAt, claimedBy, chars, reason}>} */
    this.records = new Map();
    this.log = [];
  }

  /**
   * Build and write one takeover brief.
   *
   * @param client - a live app-server client.
   * @param options - `{ threadId, cwd, reason, saveTo, warnPct, timeoutMs }`.
   * @returns `{ ok, threadId, path, chars, claimed, claimedAt, reason, detail }`.
   *   `ok: false` carries why — a brief that could not be built is not a handover.
   */
  async prepare(client, options = {}) {
    const threadId = options.threadId ?? "";
    let budget = null;
    try {
      budget = await readBudget(client, { warnPct: options.warnPct, timeoutMs: options.timeoutMs });
    } catch (error) {
      budget = { level: "unknown", error: String(error?.message ?? error) };
    }
    const decision = takeoverDecision(budget.level && budget.level !== "unknown" ? budget : null, { handoffArmed: options.handoffArmed !== false });
    if (decision.action !== "prepare-handoff" && options.force !== true) {
      return { ok: false, threadId, path: null, chars: 0, claimed: false, claimedAt: null, reason: decision.reason, detail: `not prepared: ${decision.reason}` };
    }

    const brief = await collectHandoff(client, {
      threadId,
      cwd: options.cwd,
      saveTo: options.saveTo,
      reason: options.reason ?? "Codex's quota is reached; DeepSeek Harness is taking this over",
      warnPct: options.warnPct,
      timeoutMs: options.timeoutMs,
    });
    if (!brief.ok) {
      return { ok: false, threadId, path: brief.path ?? null, chars: 0, claimed: false, claimedAt: null, reason: decision.reason, detail: brief.reason ?? "the brief could not be built" };
    }

    // The brief is written here rather than by the tool: the takeover has to
    // leave something on disk for whoever picks it up.
    const base = options.cwd ?? brief.facts?.cwd ?? process.cwd();
    const target = typeof options.saveTo === "string" && options.saveTo !== ""
      ? (isAbsolute(options.saveTo) ? options.saveTo : resolve(base, options.saveTo))
      : join(base, HANDOFF_DIR, `${brief.threadId ?? threadId}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, brief.markdown ?? "", "utf8");
    } catch (error) {
      return {
        ok: false,
        threadId: brief.threadId ?? threadId,
        path: target,
        chars: 0,
        claimed: false,
        claimedAt: null,
        reason: decision.reason,
        detail: `the brief was built but could not be written: ${String(error?.message ?? error)}`,
      };
    }

    const record = {
      threadId: brief.threadId ?? threadId,
      path: target,
      preparedAt: Date.now(),
      claimedAt: null,
      claimedBy: null,
      chars: brief.markdown?.length ?? 0,
      reason: decision.reason,
    };
    this.records.set(record.threadId, record);
    this.#trim();
    this.log.push({ at: Date.now(), threadId: record.threadId, action: "prepared", text: `takeover brief written to ${record.path ?? "(not saved)"}` });
    return {
      ok: true,
      threadId: record.threadId,
      path: record.path,
      chars: record.chars,
      claimed: false,
      claimedAt: null,
      reason: decision.reason,
      detail: `prepared ${record.chars} chars at ${record.path ?? "(not saved)"} — unclaimed: only a person or a Harness turn can take it over`,
    };
  }

  /**
   * Record that someone has actually taken the brief. Without this the panel
   * shows "unclaimed", however many briefs were written.
   *
   * @param options - `{ threadId, path, claimedBy }`.
   * @returns `{ ok, record?, detail }`.
   */
  claim(options = {}) {
    const threadId = options.threadId ?? null;
    const record = threadId
      ? this.records.get(threadId)
      : [...this.records.values()].find((entry) => entry.path && entry.path === options.path);
    if (!record) {
      return { ok: false, detail: `no prepared takeover matches ${threadId ? `thread ${threadId}` : `path ${options.path ?? "(none)"}`}` };
    }
    record.claimedAt = Date.now();
    record.claimedBy = options.claimedBy ?? "unknown";
    this.log.push({ at: record.claimedAt, threadId: record.threadId, action: "claimed", text: `claimed by ${record.claimedBy}` });
    return { ok: true, record: { ...record }, detail: `claimed by ${record.claimedBy}` };
  }

  /** What the panel shows: every prepared brief, claimed or not. */
  status() {
    const records = [...this.records.values()].map((entry) => ({ ...entry, claimed: entry.claimedAt !== null }));
    return {
      prepared: records.length,
      claimed: records.filter((entry) => entry.claimed).length,
      unclaimed: records.filter((entry) => !entry.claimed).length,
      records,
      log: this.log.slice(-20),
    };
  }

  /** The record for one thread, for the board's per-card block. */
  forThread(threadId) {
    const record = this.records.get(threadId);
    if (!record) return null;
    return { ...record, claimed: record.claimedAt !== null };
  }

  #trim() {
    while (this.records.size > MAX_TAKEOVERS) {
      const oldest = [...this.records.values()].sort((a, b) => a.preparedAt - b.preparedAt)[0];
      this.records.delete(oldest.threadId);
    }
  }
}
