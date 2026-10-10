/**
 * dsh-codex-bridge · the board panel (client half).
 *
 * This file is loaded by the Harness web client, not by Node: it registers
 * itself with `window.__ModuleLoader__` and is written as plain JS with no build
 * step, exactly like the client halves of the shipped client plugins. It is
 * never imported by the host, so nothing here may be required for the tools to
 * work.
 *
 * What it adds, and all it adds:
 *  - one row in the shell's own global panel list (`sidebar.panellist`) and one
 *    page in the layout's keyed `main` slot, both under the same panel id, so the
 *    shell keeps owning the row box, the label, the highlight and the switch;
 *  - a 5s poll of the host's read-only `snapshot` endpoint.
 *
 * It performs no writes of any kind. A board that could decline an approval by
 * accident would be worse than no board, so the panel deliberately holds no
 * write path and the action buttons are a P1 decision, not an omission.
 */

window.__ModuleLoader__.load({
  id: "dsh-codex-bridge",
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

    /** The client context, captured in `apply`. */
    let __CTX__ = null;

    const CSS = `
.dcb_root{height:100%;min-height:0;display:flex;flex-direction:column;gap:10px;padding:14px 16px 16px;box-sizing:border-box;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.dcb_head{flex:none;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.dcb_title{font-size:16px;font-weight:700;margin:0}
.dcb_sub{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dcb_tag{font-size:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;color:var(--dsw-alias-label-secondary)}
.dcb_spacer{flex:1}
.dcb_btn{font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer;background:0 0;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2)}
.dcb_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dcb_btn:disabled{opacity:.5;cursor:default}
.dcb_note{flex:none;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px}
.dcb_note[data-kind=error]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dcb_cols{flex:1;min-height:0;display:flex;gap:10px;overflow-x:auto;align-items:stretch}
.dcb_col{flex:1 1 0;min-width:220px;min-height:0;display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;background:var(--dsw-specific-input-major)}
.dcb_colHead{flex:none;display:flex;align-items:baseline;gap:6px}
.dcb_colName{font-size:12.5px;font-weight:650}
.dcb_count{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dcb_hint{flex:none;font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dcb_cards{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.dcb_card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 9px;background:var(--dsw-alias-bg-base)}
.dcb_card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dcb_cardTop{display:flex;align-items:baseline;gap:7px}
.dcb_id{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-secondary)}
.dcb_age{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dcb_cardTitle{font-size:12.5px;font-weight:600;margin:5px 0 0;overflow-wrap:anywhere}
.dcb_preview{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin:4px 0 0;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dcb_badges{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
.dcb_badge{font-size:10.5px;border-radius:999px;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dcb_badge[data-kind=wait]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dcb_badge[data-kind=queue]{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.dcb_empty{font-size:11.5px;color:var(--dsw-alias-label-tertiary);text-align:center;padding:14px 6px}
.dcb_cwd{font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);margin-top:5px;overflow-wrap:anywhere}
`;

    /**
     * Ask the host for one snapshot.
     * @param payload - endpoint payload.
     * @returns the snapshot value.
     */
    async function callHost(payload) {
      const ctx = __CTX__;
      const connection = ctx && typeof ctx.get === "function" ? ctx.get("connection") : undefined;
      if (!connection || !connection.rpc) throw new Error("the connection service is unavailable");
      const response = await connection.rpc.call(RPC_CARRIER, RPC_CHANNEL, { method: "snapshot", payload: payload || {} });
      if (response && response.ok) return response.value;
      throw new Error((response && response.error && response.error.message) || "snapshot failed");
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
     * One card.
     * @param props - `{ card }`.
     * @returns the card element.
     */
    function Card({ card }) {
      const badges = [];
      if (card.waitingCount > 0) {
        badges.push(h("span", { key: "w", className: "dcb_badge", "data-kind": "wait" }, card.waitingCount + " awaiting approval"));
      }
      if (card.queuedCount > 0) {
        badges.push(h("span", { key: "q", className: "dcb_badge", "data-kind": "queue" }, card.queuedCount + " queued"));
      }
      if (card.turnStartedAt) {
        badges.push(h("span", { key: "t", className: "dcb_badge" }, "turn since " + card.turnStartedAt.slice(11, 19) + "Z"));
      }
      return h("div", { className: "dcb_card" },
        h("div", { className: "dcb_cardTop" },
          h("span", { className: "dcb_id" }, card.shortId || "(no id)"),
          h("span", { className: "dcb_age" }, ageLabel(card.ageMs))
        ),
        card.title ? h("div", { className: "dcb_cardTitle" }, card.title) : null,
        card.preview ? h("div", { className: "dcb_preview" }, card.preview) : null,
        badges.length > 0 ? h("div", { className: "dcb_badges" }, badges) : null,
        card.cwd ? h("div", { className: "dcb_cwd" }, card.cwd) : null
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
      const alive = React.useRef(true);

      const load = React.useCallback(async () => {
        setBusy(true);
        try {
          const next = await callHost({});
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

      React.useEffect(() => {
        alive.current = true;
        load();
        const timer = setInterval(load, POLL_INTERVAL_MS);
        return () => { alive.current = false; clearInterval(timer); };
      }, [load]);

      const head = h("div", { className: "dcb_head" },
        h("h2", { className: "dcb_title" }, "Codex board"),
        h("span", { className: "dcb_tag" }, "read-only"),
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
      if (board && board.probe && !board.probe.queueCoverageComplete) {
        const probe = board.probe;
        const missed = probe.queueProbeErrors.length + probe.queueUnprobedThreadIds.length;
        notes.push(h("div", { key: "cov", className: "dcb_note" },
          "Queue coverage is partial: " + probe.queueProbed.length + " of " + probe.threadsListed
          + " threads were probed (" + missed + " not), so the Queued column is a floor, not a total."));
      }

      const columns = board
        ? h("div", { className: "dcb_cols" }, board.columns.map((column) => h("div", { key: column.id, className: "dcb_col" },
            h("div", { className: "dcb_colHead" },
              h("span", { className: "dcb_colName" }, column.label),
              h("span", { className: "dcb_count" }, String(column.cards.length))
            ),
            h("div", { className: "dcb_hint" }, column.hint),
            h("div", { className: "dcb_cards" }, column.cards.length > 0
              ? column.cards.map((card) => h(Card, { key: card.threadId, card }))
              : h("div", { className: "dcb_empty" }, "—"))
          )))
        : h("div", { className: "dcb_empty" }, error ? "No snapshot yet." : "Reading the Codex app-server…");

      return h("div", { className: "dcb_root", "data-dsh-codex-bridge-view": "" }, head, notes, columns);
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
