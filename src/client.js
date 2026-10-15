/**
 * dsh-codex-bridge · the board panel (client half).
 *
 * This file is loaded by the Harness web client, not by Node: it registers
 * itself with `window.__ModuleLoader__` and is written as plain JS with no build
 * step, exactly like the client halves of the shipped client plugins. It is
 * never imported by the host, so nothing here may be required for the tools to
 * work.
 *
 * What it adds:
 *  - one row in the shell's own global panel list (`sidebar.panellist`) and one
 *    page in the layout's keyed `main` slot, both under the same panel id, so the
 *    shell keeps owning the row box, the label, the highlight and the switch;
 *  - a 5s poll of the host's `snapshot` endpoint;
 *  - three controls, and no more: arm/disarm the autopilot, pause one thread, and
 *    fetch a takeover brief. The only write any of them can reach is
 *    `thread/queue/add`, and only the autopilot arm reaches it.
 *
 * Every judgement shown here was made by the host (`task-state.js`) and every
 * line says whether Codex reported it or this connection inferred it. The panel
 * renders; it does not decide. If the host is older than this panel, missing
 * fields render as nothing rather than as a guess.
 */

window.__ModuleLoader__.load({
  id: "@juyanjy/dsh-codex-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** Stable id shared by the sidebar row and the main-slot page. */
    const PANEL_ID = "dsh-codex-bridge";

    /** Where the host registered its route: `conn.rpc.call("/api", "codexboard", …)`. */
    const RPC_CARRIER = "/api";
    const RPC_CHANNEL = "codexboard";

    /** How often the panel re-reads the snapshot. One snapshot is a handful of local reads. */
    const POLL_INTERVAL_MS = 5000;

    /**
     * How long one click arms the autopilot for. It disarms itself at the
     * deadline. The host's knob is `ttlMinutes` (see `Autopilot.arm`), so the
     * panel sends that rather than a millisecond count the host would ignore.
     */
    const ARM_TTL_MINUTES = 30;

    /** How much of a goal objective and of a reason line the card shows. */
    const GOAL_CHARS = 140;
    const REASON_CHARS = 220;

    /** The client context, captured in `apply`. */
    let __CTX__ = null;

    const CSS = `
.dcb_root{height:100%;min-height:0;display:flex;flex-direction:column;gap:10px;padding:14px 16px 16px;box-sizing:border-box;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.dcb_head{flex:none;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.dcb_title{font-size:16px;font-weight:700;margin:0}
.dcb_sub{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dcb_tag{font-size:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;color:var(--dsw-alias-label-secondary)}
.dcb_tag[data-state=running]{color:var(--dsw-alias-state-success-primary,#2f9e44);border-color:var(--dsw-alias-state-success-primary,#2f9e44)}
.dcb_tag[data-state=blocked]{color:var(--dsw-alias-state-warn-primary,#e8590c);border-color:var(--dsw-alias-state-warn-primary,#e8590c)}
.dcb_tag[data-state=needs-human]{color:var(--dsw-alias-state-error-primary,#c92a2a);border-color:var(--dsw-alias-state-error-primary,#c92a2a)}
.dcb_spacer{flex:1}
.dcb_btn{font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer;background:0 0;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2)}
.dcb_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dcb_btn:disabled{opacity:.5;cursor:default}
.dcb_btn[data-armed=true]{color:var(--dsw-alias-state-success-primary,#2f9e44);border-color:var(--dsw-alias-state-success-primary,#2f9e44)}
.dcb_btnSmall{font-size:11px;padding:3px 9px}
.dcb_note{flex:none;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px}
.dcb_note[data-kind=error]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dcb_note[data-kind=warn]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dcb_auto{flex:none;display:flex;flex-direction:column;gap:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px}
.dcb_autoHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dcb_autoTitle{font-size:12px;font-weight:650}
.dcb_autoBody{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dcb_autoLine{font-family:var(--ds-font-family-code);font-size:10.5px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dcb_autoLine[data-kind=halt]{color:var(--dsw-alias-state-error-primary)}
.dcb_cols{flex:1;min-height:0;display:flex;gap:10px;overflow-x:auto;align-items:stretch}
.dcb_col{flex:1 1 0;min-width:220px;min-height:0;display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;background:var(--dsw-specific-input-major)}
.dcb_colHead{flex:none;display:flex;align-items:baseline;gap:6px}
.dcb_colName{font-size:12.5px;font-weight:650}
.dcb_count{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dcb_hint{flex:none;font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dcb_cards{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.dcb_card{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 9px;background:var(--dsw-alias-bg-base)}
.dcb_card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dcb_card[data-state=running]{border-left-color:var(--dsw-alias-state-success-primary,#2f9e44)}
.dcb_card[data-state=blocked]{border-left-color:var(--dsw-alias-state-warn-primary,#e8590c)}
.dcb_card[data-state=needs-human]{border-left-color:var(--dsw-alias-state-error-primary,#c92a2a)}
.dcb_cardTop{display:flex;align-items:baseline;gap:7px}
.dcb_id{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-secondary)}
.dcb_age{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dcb_cardTitle{font-size:12.5px;font-weight:600;margin:5px 0 0;overflow-wrap:anywhere}
.dcb_stateRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:5px}
.dcb_chip{font-size:10.5px;font-weight:650;border-radius:999px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dcb_chip[data-state=running]{color:var(--dsw-alias-state-success-primary,#2f9e44);border-color:var(--dsw-alias-state-success-primary,#2f9e44)}
.dcb_chip[data-state=blocked]{color:var(--dsw-alias-state-warn-primary,#e8590c);border-color:var(--dsw-alias-state-warn-primary,#e8590c)}
.dcb_chip[data-state=needs-human]{color:var(--dsw-alias-state-error-primary,#c92a2a);border-color:var(--dsw-alias-state-error-primary,#c92a2a)}
.dcb_basis{font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}
.dcb_goal{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin:5px 0 0;overflow-wrap:anywhere}
.dcb_reason{font-size:11px;line-height:1.5;margin:4px 0 0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.dcb_reason[data-state=needs-human]{color:var(--dsw-alias-state-error-primary,#c92a2a)}
.dcb_reason[data-state=blocked]{color:var(--dsw-alias-state-warn-primary,#e8590c)}
.dcb_failure{font-size:11px;line-height:1.5;margin:4px 0 0;overflow-wrap:anywhere;color:var(--dsw-alias-state-error-primary,#c92a2a)}
.dcb_failure[data-retry=yes]{color:var(--dsw-alias-state-warn-primary,#e8590c)}
.dcb_spoken{font-size:11px;line-height:1.5;margin:4px 0 0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.dcb_evidence{font-size:10px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:4px 0 0;overflow-wrap:anywhere}
.dcb_barWrap{margin-top:6px}
.dcb_bar{height:6px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden}
.dcb_barFill{height:100%;background:var(--dsw-alias-state-business-primary,#1c7ed6)}
.dcb_barNote{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.dcb_strip{display:flex;gap:3px;align-items:center;margin-top:5px}
.dcb_dot{width:9px;height:9px;border-radius:2px;background:var(--dsw-alias-border-l2);display:inline-block}
.dcb_dot[data-state=completed]{background:var(--dsw-alias-state-success-primary,#2f9e44)}
.dcb_dot[data-state=failed]{background:var(--dsw-alias-state-error-primary,#c92a2a)}
.dcb_dot[data-state=interrupted]{background:var(--dsw-alias-state-warn-primary,#e8590c)}
.dcb_stripNote{font-size:10px;color:var(--dsw-alias-label-tertiary);margin-left:4px}
.dcb_preview{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin:4px 0 0;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dcb_badges{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
.dcb_badge{font-size:10.5px;border-radius:999px;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dcb_badge[data-kind=wait]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dcb_badge[data-kind=queue]{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.dcb_badge[data-kind=status]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}
.dcb_lastBrief{display:block;white-space:pre-wrap;font-family:var(--dsw-font-mono, monospace);font-size:11px;line-height:1.45;margin-top:4px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10));max-height:180px;overflow:auto}
.dcb_takeover{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;margin-top:7px;padding:6px 8px;border-radius:6px;border-left:3px solid var(--dsw-alias-state-warn-primary, #b26a00);background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10))}
.dcb_takeover[data-claimed="yes"]{border-left-color:var(--dsw-alias-state-business-primary, #1f6feb)}
.dcb_takeoverKind{font-weight:600;color:var(--dsw-alias-label-secondary, inherit)}
.dcb_takeoverPath{font-family:var(--dsw-font-mono, monospace);font-size:11px;color:var(--dsw-alias-label-tertiary, inherit);word-break:break-all}
.dcb_takeoverBy{font-size:11px;color:var(--dsw-alias-label-tertiary, inherit)}
.dcb_actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}
.dcb_last{font-size:11px;line-height:1.5;margin:5px 0 0;overflow-wrap:anywhere}
.dcb_lastKind{font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);margin-right:5px}
.dcb_lastText{color:var(--dsw-alias-label-secondary)}
.dcb_empty{font-size:11.5px;color:var(--dsw-alias-label-tertiary);text-align:center;padding:14px 6px}
.dcb_cwd{font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);margin-top:5px;overflow-wrap:anywhere}
.dcb_brief{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px}
.dcb_briefHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dcb_briefBody{flex:1;min-height:0;overflow:auto;margin:0;padding:9px 10px;border-radius:8px;background:var(--dsw-specific-input-major);
  font-family:var(--ds-font-family-code);font-size:11px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
`;

    /**
     * Ask the host for one endpoint result.
     * @param method - the endpoint name (`snapshot`, `autopilot.set`, …).
     * @param payload - endpoint payload.
     * @returns the endpoint value.
     */
    async function callEndpoint(method, payload) {
      const ctx = __CTX__;
      const connection = ctx && typeof ctx.get === "function" ? ctx.get("connection") : undefined;
      if (!connection || !connection.rpc) throw new Error("the connection service is unavailable");
      const response = await connection.rpc.call(RPC_CARRIER, RPC_CHANNEL, { method, payload: payload || {} });
      if (response && response.ok) return response.value;
      throw new Error((response && response.error && response.error.message) || (method + " failed"));
    }

    /**
     * Render an age in the shortest honest form.
     * @param ageMs - milliseconds, or null when the thread carries no timestamp.
     * @returns a short label.
     */
    function ageLabel(ageMs) {
      if (ageMs === null || ageMs === undefined) return "no timestamp";
      const seconds = Math.floor(ageMs / 1000);
      if (seconds < 45) return "just now";
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + "m ago";
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + "h ago";
      return Math.floor(hours / 24) + "d ago";
    }

    /**
     * Render a duration in the shortest honest form.
     * @param ms - milliseconds, or null.
     * @returns a short label.
     */
    function durationLabel(ms) {
      if (!Number.isFinite(ms)) return "";
      const minutes = Math.floor(ms / 60000);
      if (minutes < 1) return Math.max(0, Math.round(ms / 1000)) + "s";
      if (minutes < 60) return minutes + "m";
      return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
    }

    /**
     * Shorten text for a card, saying so when it was shortened.
     * @param text - the source text.
     * @param limit - maximum characters.
     * @returns the display text.
     */
    function short(text, limit) {
      const value = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
      if (value.length <= limit) return value;
      return value.slice(0, limit - 1) + "…";
    }

    /**
     * Render the account line, or an honest "unknown" when it could not be read.
     * @param account - the snapshot's account block.
     * @returns the line text.
     */
    function accountLine(account) {
      if (!account) return "account: not read";
      if (account.error) return "account: unavailable (" + account.error + ")";
      const parts = [];
      if (account.email) parts.push(account.email);
      if (account.planType) parts.push(account.planType);
      const primary = account.limits && account.limits.primary;
      if (primary && typeof primary.usedPercent === "number") {
        parts.push(primary.usedPercent + "% of " + (primary.windowMins || "?") + "min window");
      }
      const secondary = account.limits && account.limits.secondary;
      if (secondary && typeof secondary.usedPercent === "number") parts.push(secondary.usedPercent + "% weekly");
      if (account.limits && typeof account.limits.resetCreditsAvailable === "number") {
        parts.push(account.limits.resetCreditsAvailable + " reset credits");
      }
      return parts.length > 0 ? parts.join(" · ") : "account: read, nothing reported";
    }

    /**
     * The one-line quota summary, from the same predicate the `codex_budget` tool uses.
     * @param quota - the snapshot's quota block.
     * @returns the line text.
     */
    function quotaLine(quota) {
      if (!quota) return "";
      return quota.line || ("quota: " + (quota.level || "unknown"));
    }

    /**
     * One card.
     * @param props - `{ card, paused, onPause, onBrief, onTakeover, onClaim }`.
     * @returns the card element.
     */
    function Card({ card, paused, onPause, onBrief, onTakeover, onClaim }) {
      const state = typeof card.state === "string" && card.state !== "" ? card.state : "no-activity";
      const badges = [];
      const itemStatus = card.lastItemStatus;
      if (itemStatus && String(itemStatus).toLowerCase() !== "completed") {
        badges.push(h("span", { key: "s", className: "dcb_badge", "data-kind": "status" }, String(itemStatus)));
      }
      if (card.waitingCount > 0) {
        badges.push(h("span", { key: "w", className: "dcb_badge", "data-kind": "wait" }, card.waitingCount + " awaiting approval"));
      }
      if (card.queuedCount > 0) {
        badges.push(h("span", { key: "q", className: "dcb_badge", "data-kind": "queue" }, card.queuedCount + " queued"));
      }
      if (card.turnStatus) {
        badges.push(h("span", { key: "t", className: "dcb_badge" }, "turn " + card.turnStatus));
      }

      // Reasons come from the host, each already labelled reported/inferred.
      const reasons = Array.isArray(card.reasons) ? card.reasons.slice(0, 3) : [];
      const evidence = Array.isArray(card.evidence) ? card.evidence.filter(Boolean).slice(0, 4) : [];
      const progress = card.progress && card.progress.kind && card.progress.kind !== "none" ? card.progress : null;
      const turns = Array.isArray(card.recentTurns) ? card.recentTurns.slice(-8) : [];
      const goal = card.goal && typeof card.goal.objective === "string" && card.goal.objective !== "" ? card.goal : null;

      return h("div", { className: "dcb_card", "data-state": state },
        h("div", { className: "dcb_cardTop" },
          h("span", { className: "dcb_id" }, card.shortId || "(no id)"),
          h("span", { className: "dcb_age" }, ageLabel(card.ageMs))
        ),
        h("div", { className: "dcb_stateRow" },
          h("span", { className: "dcb_chip", "data-state": state }, card.stateLabel || state),
          card.stateBasis ? h("span", { className: "dcb_basis" }, card.stateBasis) : null,
          card.autopilotStopped ? h("span", { className: "dcb_basis", "data-kind": "halt" }, "autopilot stopped") : null,
          card.autopilotPaused ? h("span", { className: "dcb_basis", "data-kind": "paused" }, "autopilot paused here") : null
        ),
        card.title ? h("div", { className: "dcb_cardTitle" }, card.title) : null,
        goal ? h("div", { className: "dcb_goal" }, "goal (" + (goal.status || "unknown") + "): " + short(goal.objective, GOAL_CHARS)) : null,
        card.failure && card.failure.kind ? h("div", {
          className: "dcb_failure",
          "data-kind": card.failure.kind,
          "data-retry": card.failure.retryable ? "yes" : "no",
        },
          (card.failure.retryable ? "retryable failure" : "needs a person") + " (" + card.failure.kind + ")",
          card.failure.quoted ? ": " + short(card.failure.quoted, REASON_CHARS) : "",
          typeof card.failureAgeMs === "number" ? " · ended " + durationLabel(card.failureAgeMs) + " ago" : ""
        ) : null,
        card.lastSpoken ? h("div", { className: "dcb_spoken" },
          "Codex last said (" + (card.lastSpokenPhase || "unknown") + "): " + short(card.lastSpoken, GOAL_CHARS)
        ) : null,
        reasons.map((reason, index) => h("div", {
          key: "r" + index, className: "dcb_reason", "data-state": reason?.severity === "info" ? "" : state,
        }, short(reason?.text ?? String(reason ?? ""), REASON_CHARS))),
        progress ? h("div", { className: "dcb_barWrap" },
          typeof progress.percent === "number" ? h("div", { className: "dcb_bar" },
            h("div", { className: "dcb_barFill", style: { width: Math.max(0, Math.min(100, progress.percent)) + "%" } })
          ) : null,
          h("div", { className: "dcb_barNote" }, progress.label || "") ,
          h("div", { className: "dcb_barNote" }, (progress.detail || "") + (progress.source ? " · source: " + progress.source : ""))
        ) : (card.turnItemCount !== null && card.turnItemCount !== undefined
          ? h("div", { className: "dcb_barNote" }, "no progress denominator reported · newest turn has " + card.turnItemCount + " recorded item(s)")
          : null),
        turns.length > 1 ? h("div", { className: "dcb_strip" },
          turns.map((turn, index) => h("span", {
            key: "d" + index, className: "dcb_dot",
            "data-state": turn?.status ?? "unknown",
            title: (turn?.id ? String(turn.id).slice(0, 8) + " " : "") + (turn?.status || "unknown") + (turn?.durationMs ? " in " + durationLabel(turn.durationMs) : ""),
          })),
          h("span", { className: "dcb_stripNote" }, "last " + turns.length + " recorded turns, oldest first")
        ) : null,
        card.takeover ? h("div", { className: "dcb_takeover", "data-claimed": card.takeover.claimed ? "yes" : "no" },
          h("span", { className: "dcb_takeoverKind" }, card.takeover.claimed ? "taken over" : "takeover prepared, unclaimed"),
          h("span", { className: "dcb_takeoverPath" }, card.takeover.path || "(not saved)"),
          card.takeover.claimed && card.takeover.claimedBy
            ? h("span", { className: "dcb_takeoverBy" }, "by " + card.takeover.claimedBy)
            : h("span", { className: "dcb_takeoverBy" }, "a brief nobody claimed is not a handover")
        ) : null,
        card.lastItem ? h("div", { className: "dcb_last" },
          h("span", { className: "dcb_lastKind" }, "last " + (card.lastItem.type || "item")),
          h("span", { className: "dcb_lastText" }, card.lastItem.text)
        ) : null,
        badges.length > 0 ? h("div", { className: "dcb_badges" }, badges) : null,
        evidence.length > 0 ? h("div", { className: "dcb_evidence" }, "evidence: " + evidence.join(" · ")) : null,
        h("div", { className: "dcb_actions" },
          onPause ? h("button", {
            className: "dcb_btn dcb_btnSmall", type: "button", onClick: () => onPause(card, !paused),
          }, paused ? "Resume this thread" : "Pause this thread") : null,
          onBrief ? h("button", {
            className: "dcb_btn dcb_btnSmall", type: "button", onClick: () => onBrief(card),
          }, "Takeover brief") : null,
          // Only offered where the honest answer is "a person must decide", and
          // only while the card is actually asking: a fresh quota or auth stop.
          // An ancient failure keeps its line as evidence but does not invite a
          // takeover of a thread that settled days ago. A retryable stop is the
          // autopilot's job.
          onTakeover && card.state === "needs-human" && card.failure
            && (card.failure.kind === "quota" || card.failure.kind === "auth")
            ? h("button", {
              className: "dcb_btn dcb_btnSmall", type: "button", onClick: () => onTakeover(card),
            }, "Prepare a takeover") : null,
          onClaim && card.takeover && !card.takeover.claimed
            ? h("button", {
              className: "dcb_btn dcb_btnSmall", type: "button", onClick: () => onClaim(card),
            }, "Mark taken over") : null
        ),
        card.preview ? h("div", { className: "dcb_preview" }, card.preview) : null,
        card.cwd ? h("div", { className: "dcb_cwd" }, card.cwd) : null
      );
    }

    /**
     * The autopilot strip: what it would do, what it did, and the two switches.
     * @param props - `{ autopilot, busy, onArm, onDisarm, onTick }`.
     * @returns the strip element.
     */
    function AutopilotBar({ autopilot, busy, onArm, onDisarm, onTick }) {
      const armed = Boolean(autopilot && autopilot.armed);
      const limits = (autopilot && autopilot.limits) || {};
      const log = (autopilot && Array.isArray(autopilot.log) ? autopilot.log : []).slice(-5).reverse();
      const halted = autopilot && Array.isArray(autopilot.halted) ? autopilot.halted : [];
      const remaining = autopilot && Number.isFinite(autopilot.remainingMs) ? durationLabel(autopilot.remainingMs) : "";
      const lastMessage = autopilot && autopilot.lastMessage && autopilot.lastMessage.text ? autopilot.lastMessage : null;
      return h("div", { className: "dcb_auto" },
        h("div", { className: "dcb_autoHead" },
          h("span", { className: "dcb_autoTitle" }, "Autopilot"),
          h("span", { className: "dcb_tag", "data-state": armed ? "running" : "" }, armed ? "armed" + (remaining ? " for " + remaining : "") : "off"),
          h("span", { className: "dcb_autoBody" },
            "max " + (limits.maxPerThread ?? "?") + " per thread · " + (limits.maxTotal ?? "?") + " total · at least "
            + durationLabel(limits.minIntervalMs ?? null) + " apart · never answers an approval"),
          h("span", { className: "dcb_spacer" }),
          h("button", { className: "dcb_btn dcb_btnSmall", type: "button", disabled: busy, onClick: onTick }, "Evaluate one pass"),
          armed
            ? h("button", { className: "dcb_btn dcb_btnSmall", "data-armed": "true", type: "button", disabled: busy, onClick: onDisarm }, "Stop keeping it moving")
            : h("button", { className: "dcb_btn dcb_btnSmall", type: "button", disabled: busy, onClick: onArm }, "Keep Codex moving for 30m")
        ),
        h("div", { className: "dcb_autoBody" },
          armed
            ? "While armed, this plugin may queue a continuation message into a blocked or needs-you thread. Every decision is listed here; Stop ends it immediately and the arming expires on its own."
            : "Off. Nothing in this panel writes to Codex while it is off — the board only reads."),
        halted.map((entry) => h("div", { key: "h" + entry.threadId, className: "dcb_autoLine", "data-kind": "halt" },
          String(entry.threadId || "").slice(0, 8) + " · stopped: " + short(entry.reason, 200))),
        lastMessage ? h("div", { className: "dcb_autoBody" },
          "Last message handed to Codex (" + String(lastMessage.chars ?? lastMessage.text.length) + " chars, thread "
          + String(lastMessage.threadId || "").slice(0, 8) + "): ",
          h("span", { className: "dcb_lastBrief" }, lastMessage.text)
        ) : null,
        log.map((entry, index) => h("div", { key: "l" + index, className: "dcb_autoLine" },
          (entry.at ? new Date(entry.at).toISOString().slice(11, 19) + "Z · " : "")
          + (entry.threadId ? String(entry.threadId).slice(0, 8) + " · " : "")
          + (entry.action || "pass") + (entry.code ? " (" + entry.code + ")" : "")
          + (entry.text ? " — " + short(entry.text, 160) : "")))
      );
    }

    /**
     * The main-slot page.
     * @returns the board page element.
     */
    function CodexBoardPage() {
      const [board, setBoard] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [brief, setBrief] = React.useState(null);
      const [copied, setCopied] = React.useState(false);
      const alive = React.useRef(true);

      const load = React.useCallback(async () => {
        setBusy(true);
        try {
          const next = await callEndpoint("snapshot", {});
          if (!alive.current) return;
          setBoard(next);
          setError(null);
        } catch (failure) {
          if (!alive.current) return;
          setError(String((failure && failure.message) || failure));
        } finally {
          if (alive.current) setBusy(false);
        }
      }, []);

      /** Run one endpoint and fold any failure into the banner, never into a guess. */
      const act = React.useCallback(async (method, payload) => {
        setBusy(true);
        try {
          await callEndpoint(method, payload);
          await load();
        } catch (failure) {
          if (alive.current) setError(String((failure && failure.message) || failure));
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [load]);

      React.useEffect(() => {
        alive.current = true;
        load();
        const timer = setInterval(load, POLL_INTERVAL_MS);
        return () => { alive.current = false; clearInterval(timer); };
      }, [load]);

      const autopilot = board && board.autopilot ? board.autopilot : null;
      const pausedSet = new Set(autopilot && Array.isArray(autopilot.paused) ? autopilot.paused : []);

      const openBrief = async (card) => {
        setCopied(false);
        setBusy(true);
        try {
          const value = await callEndpoint("handoff", { threadId: card.threadId });
          if (alive.current) setBrief(value);
        } catch (failure) {
          if (alive.current) setError(String((failure && failure.message) || failure));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      const copyBrief = async () => {
        const text = (brief && brief.markdown) || "";
        try {
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          }
        } catch {
          setCopied(false);
        }
      };

      if (brief) {
        return h("div", { className: "dcb_root", "data-dsh-codex-bridge-view": "" },
          h("div", { className: "dcb_brief" },
            h("div", { className: "dcb_briefHead" },
              h("h2", { className: "dcb_title" }, "Takeover brief"),
              h("span", { className: "dcb_tag" }, brief.threadId ? String(brief.threadId).slice(0, 8) : "no thread"),
              h("span", { className: "dcb_sub" }, brief.ok ? (brief.markdown || "").length + " chars, quoted from the thread's own records" : ("not built: " + (brief.reason || "unknown reason"))),
              h("span", { className: "dcb_spacer" }),
              h("button", { className: "dcb_btn", type: "button", onClick: copyBrief }, copied ? "Copied" : "Copy"),
              h("button", { className: "dcb_btn", type: "button", onClick: () => { setBrief(null); setCopied(false); } }, "Close")
            ),
            h("pre", { className: "dcb_briefBody" }, brief.markdown || "(the brief was not built)")
          )
        );
      }

      const head = h("div", { className: "dcb_head" },
        h("h2", { className: "dcb_title" }, "Codex board"),
        board && board.totals && typeof board.totals.running === "number"
          ? h("span", { className: "dcb_sum", "aria-label": "task states" },
              board.totals.running + " running · " + board.totals.blocked + " blocked · "
              + board.totals.needsHuman + " needs you · " + board.totals.noActivity + " nothing observed")
          : null,
        h("span", { className: "dcb_tag" }, "reads only unless armed"),
        h("span", { className: "dcb_sub" }, board ? accountLine(board.account) : "connecting…"),
        h("span", { className: "dcb_spacer" }),
        board ? h("span", { className: "dcb_sub" }, "read " + board.generatedAt.slice(11, 19) + "Z") : null,
        h("button", { className: "dcb_btn", onClick: load, disabled: busy, type: "button" }, busy ? "reading…" : "Refresh")
      );

      const notes = [];
      if (error) {
        notes.push(h("div", { key: "err", className: "dcb_note", "data-kind": "error" },
          "Last read failed: " + error + (board ? " — showing the previous snapshot." : "")));
      }
      if (board && board.quota && board.quota.level === "reached") {
        notes.push(h("div", { key: "quota", className: "dcb_note", "data-kind": "warn" },
          "Codex reports the account is out of quota: " + (board.quota.text || board.quota.reason || "no detail")
          + " The board keeps reading; only new Codex work would fail."));
      }
      // Both coverage notes fire only when the host says so explicitly (`=== false`),
      // so a panel loaded ahead of its host half simply says less instead of throwing.
      if (board && board.probe && board.probe.queueCoverageComplete === false) {
        const probe = board.probe;
        const missed = (probe.queueProbeErrors || []).length + (probe.queueUnprobedThreadIds || []).length;
        notes.push(h("div", { key: "cov", className: "dcb_note" },
          "Queue coverage is partial: " + (probe.queueProbed || []).length + " of " + probe.threadsListed
          + " threads were probed (" + missed + " not), so the Queued column is a floor, not a total."));
      }
      if (board && board.probe && board.probe.itemCoverageComplete === false) {
        const probe = board.probe;
        const missed = (probe.itemProbeErrors || []).length + (probe.itemUnprobedThreadIds || []).length;
        notes.push(h("div", { key: "icov", className: "dcb_note" },
          "Last-action coverage is partial: " + (probe.itemProbed || []).length + " of " + probe.threadsListed
          + " threads were probed (" + missed + " not), so cards without a last line were simply not read."));
      }
      if (board && board.probe && board.probe.turnCoverageComplete === false) {
        const probe = board.probe;
        const missed = (probe.turnProbeErrors || []).length + (probe.turnUnprobedThreadIds || []).length;
        notes.push(h("div", { key: "tcov", className: "dcb_note" },
          "Turn coverage is partial: " + (probe.turnProbed || []).length + " of " + probe.threadsListed
          + " threads had their turns read (" + missed + " not), so a state may be missing its strongest evidence."));
      }

      const columns = board
        ? h("div", { className: "dcb_cols" }, board.columns.map((column) => h("div", { key: column.id, className: "dcb_col" },
            h("div", { className: "dcb_colHead" },
              h("span", { className: "dcb_colName" }, column.label),
              h("span", { className: "dcb_count" }, String(column.cards.length))
            ),
            h("div", { className: "dcb_hint" }, column.hint),
            h("div", { className: "dcb_cards" }, column.cards.length > 0
              ? column.cards.map((card) => h(Card, {
                  key: card.threadId,
                  card,
                  paused: pausedSet.has(card.threadId),
                  onPause: board.autopilot ? (target, next) => act("autopilot.pause", { threadId: target.threadId, paused: next }) : null,
                  onBrief: openBrief,
                  onTakeover: (target) => act("takeover.prepare", { threadId: target.threadId, cwd: target.cwd, force: true }),
                  onClaim: (target) => act("takeover.claim", { threadId: target.threadId, claimedBy: "the panel" }),
                }))
              : h("div", { className: "dcb_empty" }, "—"))
          )))
        : h("div", { className: "dcb_empty" }, error ? "No snapshot yet." : "Reading the Codex app-server…");

      const quota = board ? quotaLine(board.quota) : "";
      return h("div", { className: "dcb_root", "data-dsh-codex-bridge-view": "" },
        head,
        quota ? h("div", { className: "dcb_autoBody" }, quota) : null,
        notes,
        board ? h(AutopilotBar, {
          autopilot,
          busy,
          onArm: () => act("autopilot.set", { armed: true, ttlMinutes: ARM_TTL_MINUTES, reason: "armed from the panel" }),
          onDisarm: () => act("autopilot.set", { armed: false, reason: "stopped from the panel" }),
          onTick: () => act("autopilot.tick", {}),
        }) : null,
        columns
      );
    }

    /**
     * The sidebar row glyph. The shell owns the row box, label and highlight.
     * @param props - `{ size, active }`.
     * @returns the glyph element.
     */
    function CodexBoardIcon({ size, active }) {
      const edge = Number(size) > 0 ? Number(size) : 16;
      return h("svg", {
        width: edge, height: edge, viewBox: "0 0 16 16", "aria-hidden": "true",
        "data-dsh-panel-entry": PANEL_ID, style: { display: "block" },
      },
        h("path", {
          d: "M2 4h6M2 8h12M6 12h8",
          fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round",
          opacity: active ? 1 : 0.72,
        })
      );
    }

    /**
     * Mount the panel page and its sidebar row.
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      __CTX__ = ctx;
      const slots = ctx.slots;
      if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;

      try {
        const style = document.createElement("style");
        style.setAttribute("data-plugin", "dsh-codex-bridge");
        style.textContent = CSS;
        document.head.appendChild(style);
        ctx.effect(() => () => { try { if (style.parentNode) style.parentNode.removeChild(style); } catch { /* gone */ } }, "dsh-codex-bridge: styles");
      } catch { /* styling is cosmetic */ }

      const disposers = [];
      try {
        // Both seats belong to shell plugins; `slots.inject` waits for the seat to
        // be declared, so load order between us and the shell does not matter.
        disposers.push(slots.inject("sidebar.panellist", () => slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 55,
          label: "Codex",
        }, CodexBoardIcon)));
        disposers.push(slots.inject("main", () => slots.register({
          name: "main",
          key: PANEL_ID,
        }, CodexBoardPage)));
      } catch (failure) {
        console.warn("[dsh-codex-bridge] panel registration failed:", failure);
      }

      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try { dispose(); } catch { /* already released */ }
        }
      }, "dsh-codex-bridge: panel");
    }

    exports.inject = ["slots", "connection"];
    exports.apply = apply;
    return module.exports;
  },
});
