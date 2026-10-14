/**
 * Supervision: read what Codex reported, decide whether it is the kind of thing a
 * supervisor may pick up again, and write the message that hands it back.
 *
 * The distinction this module exists for: a *transient* failure (a dropped stream,
 * a transport error, an expired context) is not a decision anybody has to make —
 * the run simply stopped mid-flight and the next message can restart it. A
 * *quota*, *auth* or *unknown* failure is not that: retrying it burns the user's
 * budget or loops on a problem only a person can fix. So the classifier is
 * deliberately conservative, it says which pattern it matched, and anything it
 * does not recognise is **not** retryable.
 *
 * Everything here is pattern matching on the error text Codex itself recorded.
 * That is a heuristic and the module says so in every string it produces — it is
 * never presented as a diagnosis.
 */
import { clamp } from "./codex.js";

/** How much of Codex's own prose goes into a brief. */
export const BRIEF_QUOTE_CHARS = 400;

/** How long the message handed back to Codex may be. */
export const BRIEF_CHARS = 1500;

/**
 * The failure kinds, in the order they are tested. The first match wins, so the
 * specific, decision-needing kinds are checked before the transient catch-all:
 * "Error running remote compact task: You've hit your usage limit" is a quota
 * problem, while "…: stream disconnected before completion" is not.
 */
export const FAILURE_PATTERNS = [
  {
    kind: "quota",
    retryable: false,
    text: "the account's quota or rate limit",
    pattern: /usage limit|rate limit|ratelimit|quota|too many requests|\b429\b|spend control|reset credit|upgrade to pro/i,
  },
  {
    kind: "auth",
    retryable: false,
    text: "a credentials or permission problem",
    pattern: /unauthor|invalid api key|api key|authentication|not logged in|token (expired|invalid)|forbidden|\b401\b|\b403\b/i,
  },
  {
    kind: "context",
    retryable: true,
    text: "the context window filling up",
    pattern: /context (window|length|limit)|too many tokens|context_length_exceeded|maximum context/i,
  },
  {
    kind: "transient",
    retryable: true,
    text: "a transient transport or network failure",
    pattern: /stream disconnected|transport error|network error|error decoding response body|econnreset|econnrefused|socket hang up|connection (reset|closed|refused)|timed out|timeout|\b50[234]\b|overloaded|try again/i,
  },
];

/** The kind given to a failure nothing above matched. Never retried. */
export const UNKNOWN_FAILURE = {
  kind: "unknown",
  retryable: false,
  text: "a failure this bridge does not recognise",
};

/**
 * What kind of failure the newest turn recorded, if any. Pure.
 *
 * @param card - a board card (`turnStatus`, `turnError`, `lastSpoken`, …).
 * @returns `{ kind, retryable, text, matched, quoted, retryHint }`. `kind` is
 *   `null` when the newest turn did not fail — the caller decides what that means.
 */
export function classifyFailure(card = {}) {
  const failed = String(card.turnStatus ?? "").toLowerCase() === "failed";
  if (!failed) return { kind: null, retryable: false, text: "", matched: null, quoted: "", retryHint: "" };

  // The turn's own error message is the evidence; when it recorded none, the last
  // thing the thread said is the only text there is.
  const message = String(card.turnError?.message ?? card.turnError?.info ?? "").trim();
  const quoted = clamp(message.replace(/\s+/g, " "), BRIEF_QUOTE_CHARS);
  const haystack = `${message} ${card.lastSpoken ?? ""}`;

  for (const candidate of FAILURE_PATTERNS) {
    if (candidate.pattern.test(haystack)) {
      return {
        kind: candidate.kind,
        retryable: candidate.retryable,
        text: candidate.text,
        matched: candidate.pattern.source,
        quoted,
        retryHint: candidate.retryable
          ? `This reads as ${candidate.text}, which is not a decision for a person: the run stopped mid-flight.`
          : `This reads as ${candidate.text}; that is not something a supervisor may retry on its own.`,
      };
    }
  }
  return {
    kind: UNKNOWN_FAILURE.kind,
    retryable: UNKNOWN_FAILURE.retryable,
    text: UNKNOWN_FAILURE.text,
    matched: null,
    quoted,
    retryHint: "This bridge does not recognise the failure, so it is left for a person rather than retried blindly.",
  };
}

/**
 * The message DeepSeek Harness hands Codex so it can carry on: the goal it was
 * given, what it last reported, why the run stopped, and what to do about it —
 * all of it quoted from the thread's own record, none of it invented.
 *
 * @param card - a board card.
 * @param options - `{ budget, now, chars }`.
 * @returns the message text.
 */
export function supervisionBrief(card = {}, options = {}) {
  const chars = Number.isFinite(options.chars) ? options.chars : BRIEF_CHARS;
  const objective = oneLine(card.goal?.objective, 400);
  const failure = card.failure ?? classifyFailure(card);
  const spoken = oneLine(card.lastSpoken, BRIEF_QUOTE_CHARS);
  const counts = card.turnItemCounts ?? {};
  const items = Object.entries(counts)
    .map(([type, count]) => `${type} ${count}`)
    .join(", ");

  const lines = ["【DeepSeek Harness 监督续跑】"];
  lines.push(`目标：${objective || "（这个线程没有记录目标）"}`);
  if (spoken) {
    lines.push(`你上一轮最后说的是：「${spoken}」（原样引用，phase ${card.lastSpokenPhase ?? "未知"}）`);
  } else {
    lines.push("你上一轮没有留下可读的回复文字（可能只说了加密的思考）。");
  }

  if (failure.kind) {
    const age = card.failureAgeMs ?? card.ageMs;
    const when = Number.isFinite(age) ? `，结束于 ${formatAge(age)} 前` : "";
    lines.push(`上一轮结果：turn ${card.lastTurnId ?? "未知"} = failed（${failure.kind}）${when}`);
    lines.push(`Codex 记录的错误原文：「${failure.quoted || "（没有记录错误文字）"}」`);
    lines.push(failure.retryHint);
  } else {
    lines.push(`上一轮结果：turn ${card.lastTurnId ?? "未知"} = ${card.turnStatus ?? "未报告"}`);
  }

  if (card.goal?.status) lines.push(`Codex 自己给这个目标标的状态：${card.goal.status}`);
  if (items) lines.push(`这个 turn 记录到的动作：${items}`);
  if (Number.isFinite(card.queuedCount) && card.queuedCount > 0) lines.push(`队列里还有 ${card.queuedCount} 条消息没被消费。`);

  lines.push(
    failure.retryable
      ? "请继续推进目标：这类失败可以直接重试，不必等人。"
      : "请继续推进目标；如果你确实卡在需要人决定的事情上（授权、额度、需求不明确），不要重试，直接在回复里说清楚需要什么。",
  );
  lines.push("要求：直接继续执行，不要复述本消息，也不要重新解释你已经做过的事。");
  return clamp(lines.join("\n"), chars);
}

/**
 * The age of this stuck state, so one stuck turn is supervised once.
 * @param card - a board card.
 * @returns a short fingerprint.
 */
export function supervisionFingerprint(card = {}) {
  const failure = card.failure ?? classifyFailure(card);
  return [
    card.lastTurnId ?? "no-turn",
    failure.kind ?? "no-failure",
    card.goal?.status ?? "-",
    card.lastItem?.type ?? "-",
  ].join(":");
}

/** Collapse a value to one line. */
function oneLine(value, limit) {
  return clamp(String(value ?? "").replace(/\s+/g, " ").trim(), limit);
}

/** Same wording the panel uses, so the two cannot drift apart. */
function formatAge(ms) {
  if (!Number.isFinite(ms)) return "an unknown time";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60 * 10) / 10;
  if (hours < 36) return `${hours} hours`;
  return `${Math.round(hours / 24 * 10) / 10} days`;
}
