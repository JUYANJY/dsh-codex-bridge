/**
 * Client-half tests: the panel is the one piece that only ever ran inside the
 * shell, so it was "verified by eye" and nothing more. These tests render its
 * React tree in the test process against a snapshot the host would really send,
 * which catches a broken field name or a panel that throws on an older host.
 *
 * What is NOT covered here: the shell mounting the seats, and anything visual
 * (CSS, sizes, colours). Those still need a browser.
 *
 * The React stand-in below is deliberately tiny: `createElement` returns a plain
 * tree, hooks are keyed by call order, effects run when the test says so, and
 * state changes do not re-render by themselves (the test re-renders). It is a
 * stand-in for assertions about the tree, not a renderer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL("../src/client.js", import.meta.url)), "utf8");

// The panel polls on an interval; the test drives the reads itself.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

/**
 * A snapshot shaped exactly like the one the host route serves.
 * @param overrides - fields to replace.
 * @returns the snapshot.
 */
function fixture(overrides = {}) {
  const base = {
    generatedAt: "2026-10-10T09:56:24.283Z",
    account: {
      email: "someone@example.com",
      planType: "plus",
      limits: { primary: { usedPercent: 12, windowMins: 300 }, secondary: { usedPercent: 9 }, resetCreditsAvailable: 2 },
    },
    quota: { level: "ok", line: "quota: ok · 12% of 300min · 9% weekly · 2 reset credits", text: "12% of 300min", reason: "", warnPct: 80 },
    columns: [
      {
        id: "needs-human",
        label: "Needs you",
        hint: "an approval this connection is holding",
        cards: [
          {
            threadId: "01aa-wait", shortId: "01aa-wait", title: "Approve the rebuild", ageMs: 61_000,
            preview: "rebuild the docs", cwd: "/tmp/demo", waitingCount: 1, queuedCount: 0,
            turnStartedAt: "2026-10-10T09:50:00.000Z", goal: null, turnStatus: "inProgress", turnItemCount: 4,
            recentTurns: [], progress: { kind: "none", percent: null, label: "", detail: "", source: null, steps: [] },
            state: "needs-human", stateBasis: "reported", stateLabel: "Needs you",
            reasons: [{ code: "approval-pending", text: "This connection is holding 1 approval request.", severity: "attention", basis: "reported" }],
            evidence: ["approval open on this thread", "1 queued message"],
            lastItem: { type: "commandExecution", text: "$ rm -rf build", turnId: "turn-1" },
            lastItemStatus: "active", column: "needs-human",
          },
        ],
      },
      {
        id: "no-activity",
        label: "Nothing observed",
        hint: "not loaded by this connection",
        cards: [
          {
            threadId: "01aa-done", shortId: "01aa-done", title: "Finished earlier", ageMs: 3_600_000,
            preview: "summarise the log", cwd: "/tmp/demo", waitingCount: 0, queuedCount: 2,
            turnStartedAt: null, turnStatus: "interrupted", turnItemCount: 9,
            goal: { objective: "finish every stage of the roadmap", status: "active", tokenBudget: null, tokensUsed: 1_070_878, timeUsedSeconds: 2720 },
            recentTurns: [
              { id: "turn-1", status: "completed", durationMs: 61_000 },
              { id: "turn-2", status: "interrupted", durationMs: null },
            ],
            progress: { kind: "goal-budget", percent: 40, label: "40% of the goal's token budget", detail: "400 of 1000 tokens used", source: "goal-budget", steps: [] },
            state: "blocked", stateBasis: "reported", stateLabel: "Blocked",
            reasons: [{ code: "goal-stalled", text: "The goal is still active but no turn is running.", severity: "attention", basis: "reported" }],
            evidence: ["goal active", "newest turn interrupted"],
            lastItem: { type: "agentMessage", text: "Done: 3 files changed.", turnId: "turn-2" },
            lastItemStatus: "completed", column: "blocked",
          },
          {
            threadId: "01aa-unread", shortId: "01aa-unread", title: "Never read", ageMs: null,
            preview: "old question", cwd: "/tmp/demo", waitingCount: 0, queuedCount: 0,
            turnStartedAt: null, lastItem: null, lastItemStatus: null, goal: null, turnStatus: null, turnItemCount: null,
            recentTurns: [], progress: null,
            state: "no-activity", stateBasis: "reported", stateLabel: "Nothing observed",
            reasons: [], evidence: [], column: "no-activity",
          },
        ],
      },
    ],
    totals: { threads: 3, needsHuman: 1, blocked: 1, running: 0, noActivity: 1, queuedMessages: 2, waiting: 1 },
    autopilot: {
      armed: false, armedAt: null, expiresAt: null, remainingMs: null,
      limits: { maxPerThread: 3, maxTotal: 6, minIntervalMs: 300_000, settleMs: 90_000 },
      sent: [], total: 0, paused: [], halted: [], passes: 0, lastPassAt: null, log: [],
    },
    probe: {
      generatedAt: "2026-10-10T09:56:24.283Z",
      maxThreads: 12, maxQueueProbes: 6, maxItemProbes: 6, maxTurnProbes: 12,
      threadsListed: 3, queueProbed: ["01aa-wait"], queueProbeErrors: [],
      queueUnprobedThreadIds: ["01aa-done", "01aa-unread"], queueCoverageComplete: false,
      itemProbed: ["01aa-wait", "01aa-done"], itemProbeErrors: [],
      itemUnprobedThreadIds: ["01aa-unread"], itemCoverageComplete: false,
      turnProbed: ["01aa-wait", "01aa-done"], turnProbeErrors: [],
      turnUnprobedThreadIds: ["01aa-unread"], turnCoverageComplete: false,
      notificationsRetained: 0,
    },
  };
  return { ...base, ...overrides };
}

/**
 * Boot one fresh copy of the client half over a scripted list of host replies.
 * @param replies - snapshot objects (or Errors) handed out one per read.
 * @returns `{ registrations, render, runEffects, reads }`.
 */
function bootClient(replies, hooks = {}) {
  let definition = null;
  const fakeWindow = { __ModuleLoader__: { load: (value) => { definition = value; } } };
  const fakeDocument = {
    createElement: () => ({ setAttribute() {}, style: {}, textContent: "", parentNode: null }),
    head: { appendChild() {} },
  };
  new Function("window", "document", CLIENT_SOURCE)(fakeWindow, fakeDocument);
  assert.ok(definition, "src/client.js never registered itself with the module loader");

  const cells = [];
  const effects = [];
  let hook = 0;
  const React = {
    createElement: (type, props, ...kids) => ({
      type,
      props: props || {},
      children: kids.flat(Infinity).filter((kid) => kid !== null && kid !== undefined && kid !== false && kid !== true),
    }),
    useState: (initial) => {
      const at = hook;
      hook += 1;
      if (!(at in cells)) cells[at] = initial;
      return [cells[at], (next) => { cells[at] = typeof next === "function" ? next(cells[at]) : next; }];
    },
    useRef: (initial) => {
      const at = hook;
      hook += 1;
      if (!(at in cells)) cells[at] = { current: initial };
      return cells[at];
    },
    useCallback: (callback) => callback,
    useEffect: (effect) => { effects.push(effect); },
  };

  const mod = definition.factory((name) => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return { jsx: React.createElement, jsxs: React.createElement, Fragment: "Fragment" };
    throw new Error("unexpected require: " + name);
  });

  const reads = [];
  const calls = [];
  const registrations = [];
  const ctx = {
    slots: {
      inject: (seat, callback) => { callback(); return () => {}; },
      register: (options, component) => { registrations.push({ options, component }); return () => {}; },
    },
    get: (name) => (name === "connection"
      ? {
        rpc: {
          call: async (carrier, channel, request) => {
            reads.push(request?.method ?? "snapshot");
            calls.push({ carrier, channel, method: request?.method, payload: request?.payload });
            const scripted = typeof hooks.reply === "function" ? hooks.reply(request, calls.length - 1) : undefined;
            const next = scripted !== undefined ? scripted : replies.shift();
            if (next instanceof Error) throw next;
            if (next === undefined) throw new Error("the test ran out of scripted replies");
            return next;
          },
        },
      }
      : hooks.services?.[name]),
    effect: () => () => {},
  };

  mod.apply(ctx);
  const page = registrations.find((entry) => entry.options.name === "main");
  assert.ok(page, "the main page seat was never registered");

  return {
    registrations,
    reads,
    calls,
    render: () => { hook = 0; return page.component({}); },
    /**
     * Render one seat by name, with the hook cursor reset exactly as `render` does.
     * @param seatName - the slot seat the component was registered under.
     * @returns the element tree.
     */
    renderSeat: (seatName) => {
      const seat = registrations.find((entry) => entry.options.name === seatName);
      assert.ok(seat, `the ${seatName} seat was never registered`);
      hook = 0;
      return seat.component({});
    },
    runEffects: () => { const pending = effects.splice(0); for (const effect of pending) effect(); },
    applyAgain: () => mod.apply(ctx),
  };
}

/** @returns every string inside an element tree. */
function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node.type === "function") return textOf(node.type(node.props));
  return (node.children || []).map(textOf).join("");
}

/** @returns every host element in the tree, expanded through components. */
function elements(node, found = []) {
  if (node === null || node === undefined || typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) { for (const child of node) elements(child, found); return found; }
  if (typeof node.type === "function") return elements(node.type(node.props), found);
  found.push(node);
  for (const child of node.children || []) elements(child, found);
  return found;
}

/** @returns the elements whose className matches. */
function byClass(tree, className) {
  return elements(tree).filter((el) => el.props.className === className);
}

/** @returns the elements carrying a class token (an element may carry several). */
function withClass(tree, className) {
  return elements(tree).filter((el) => String(el.props.className || "").split(/\s+/).includes(className));
}

/** @returns the badges, keyed by their `data-kind`. */
function badgesByKind(tree) {
  const found = {};
  for (const el of elements(tree)) {
    const kind = el.props["data-kind"];
    if (kind) found[kind] = (found[kind] || []).concat(textOf(el));
  }
  return found;
}

test("all three seats are registered under the plugin id", () => {
  const client = bootClient([]);
  const sidebar = client.registrations.find((entry) => entry.options.name === "sidebar.panellist");
  const page = client.registrations.find((entry) => entry.options.name === "main");
  const dock = client.registrations.find((entry) => entry.options.name === "conversation.input.dock");
  assert.equal(sidebar.options.id, "dsh-codex-bridge");
  assert.equal(sidebar.options.label, "Codex");
  assert.equal(sidebar.options.order, 55);
  assert.equal(page.options.key, "dsh-codex-bridge");
  assert.equal(dock.options.id, "dsh-codex-bridge");
  assert.equal(dock.options.label, "Codex board summary");
  assert.equal(dock.options.order, 30, "order 30 sits above the skills deck's 40 and below the host's own 0/10/20 rows");
  assert.equal(sidebar.component.name, "CodexBoardIcon");
  assert.equal(page.component.name, "CodexBoardPage");
  assert.equal(dock.component.name, "CodexDockStrip");
  assert.equal(client.registrations.length, 3);
});

test("a second apply does not register the seats twice", () => {
  const client = bootClient([]);
  assert.equal(client.registrations.length, 3);
  client.applyAgain();
  assert.equal(client.registrations.length, 3, "duplicate rows under one id are what the client loader rejects");
});

test("the first paint says it is reading, then the snapshot paints the columns", async () => {
  const client = bootClient([{ ok: true, value: fixture() }]);
  const first = client.render();
  assert.equal(byClass(first, "dcb_empty").map(textOf).join(""), "Reading the Codex app-server…");

  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.render();

  assert.deepEqual(byClass(tree, "dcb_count").map(textOf), ["1", "2"]);
  assert.deepEqual(byClass(tree, "dcb_colName").map(textOf), ["Needs you", "Nothing observed"]);
  assert.deepEqual(byClass(tree, "dcb_id").map(textOf), ["01aa-wait", "01aa-done", "01aa-unread"]);
  assert.equal(client.reads.length, 1);
  assert.match(textOf(byClass(tree, "dcb_sub")[0]), /someone@example\.com · plus · 12% of 300min window · 9% weekly · 2 reset credits/);
});

test("only the cards the host probed get a last-action line", async () => {
  const client = bootClient([{ ok: true, value: fixture() }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.render();

  const cards = byClass(tree, "dcb_card");
  const withLast = cards.filter((card) => byClass(card, "dcb_last").length > 0).map((card) => textOf(byClass(card, "dcb_id")[0]));
  const without = cards.map((card) => textOf(byClass(card, "dcb_id")[0])).filter((id) => !withLast.includes(id));
  assert.deepEqual(withLast, ["01aa-wait", "01aa-done"]);
  assert.deepEqual(without, ["01aa-unread"]);
  assert.deepEqual(byClass(tree, "dcb_lastKind").map(textOf), ["last commandExecution", "last agentMessage"]);
  assert.deepEqual(byClass(tree, "dcb_lastText").map(textOf), ["$ rm -rf build", "Done: 3 files changed."]);
});

test("a failed card shows what failed, whether it may be retried, and Codex's own words", async () => {
  const snapshot = fixture();
  const cards = snapshot.columns.find((column) => column.id === "needs-human").cards;
  cards[0].failure = {
    kind: "transient",
    retryable: true,
    text: "a transient transport or network failure",
    matched: "stream disconnected",
    quoted: "stream disconnected before completion: Transport error",
  };
  cards[0].failureAgeMs = 2 * 24 * 3_600_000;
  cards[0].lastSpoken = "I got as far as the migration.";
  cards[0].lastSpokenPhase = "final_answer";

  const blocked = snapshot.columns.find((column) => column.id === "no-activity").cards[0];
  blocked.failure = {
    kind: "quota",
    retryable: false,
    text: "the account's quota or rate limit",
    matched: "usage limit",
    quoted: "You've hit your usage limit.",
  };
  blocked.failureAgeMs = 3_600_000;

  const client = bootClient([{ ok: true, value: snapshot }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.render();

  const lines = byClass(tree, "dcb_failure");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].props["data-kind"], "transient");
  assert.equal(lines[0].props["data-retry"], "yes");
  assert.match(textOf(lines[0]), /^retryable failure \(transient\): stream disconnected before completion/);
  assert.match(textOf(lines[0]), /ended 48h 0m ago/);
  assert.equal(lines[1].props["data-kind"], "quota");
  assert.equal(lines[1].props["data-retry"], "no");
  assert.match(textOf(lines[1]), /^needs a person \(quota\): You've hit your usage limit\./);
  assert.deepEqual(byClass(tree, "dcb_spoken").map(textOf), ["Codex last said (final_answer): I got as far as the migration."]);
});

test("the coverage notes follow the host's own flags, numbers included", async () => {
  const client = bootClient([{ ok: true, value: fixture() }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const notes = byClass(client.render(), "dcb_note").map(textOf);
  assert.deepEqual(notes, [
    "Queue coverage is partial: 1 of 3 threads were probed (2 not), so the Queued column is a floor, not a total.",
    "Last-action coverage is partial: 2 of 3 threads were probed (1 not), so cards without a last line were simply not read.",
    "Turn coverage is partial: 2 of 3 threads had their turns read (1 not), so a state may be missing its strongest evidence.",
  ]);

  const complete = fixture();
  complete.probe.queueCoverageComplete = true;
  complete.probe.itemCoverageComplete = true;
  complete.probe.turnCoverageComplete = true;
  const quiet = bootClient([{ ok: true, value: complete }]);
  quiet.render();
  quiet.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(byClass(quiet.render(), "dcb_note"), []);
});

test("a panel loaded ahead of its host says less instead of throwing", async () => {
  const older = fixture();
  delete older.probe.queueCoverageComplete;
  delete older.probe.itemCoverageComplete;
  delete older.probe.turnCoverageComplete;
  delete older.probe.queueProbed;
  delete older.probe.itemProbed;
  for (const column of older.columns) for (const card of column.cards) delete card.lastItemStatus;

  const client = bootClient([{ ok: true, value: older }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.render();
  assert.equal(byClass(tree, "dcb_card").length, 3);
  assert.deepEqual(byClass(tree, "dcb_note"), []);
  assert.equal(badgesByKind(tree).status, undefined);
});

test("the status badge quotes a real status and hides a completed one", async () => {
  const client = bootClient([{ ok: true, value: fixture() }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const badges = badgesByKind(client.render());
  assert.deepEqual(badges.status, ["active"]);
  assert.deepEqual(badges.wait, ["1 awaiting approval"]);
  assert.deepEqual(badges.queue, ["2 queued"]);
});

test("a failed read keeps the previous snapshot and says so", async () => {
  const client = bootClient([{ ok: true, value: fixture() }, new Error("app-server is not alive")]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const refresh = byClass(client.render(), "dcb_btn")[0];
  assert.ok(refresh, "the refresh button never rendered");

  await refresh.props.onClick();
  const tree = client.render();
  assert.deepEqual(byClass(tree, "dcb_card").length, 3);
  assert.match(textOf(byClass(tree, "dcb_note")[0]), /^Last read failed: app-server is not alive — showing the previous snapshot\.$/);
  assert.equal(byClass(tree, "dcb_note")[0].props["data-kind"], "error");
});

test("the icon glyph carries the panel entry marker", () => {
  const client = bootClient([]);
  const icon = client.registrations.find((entry) => entry.options.name === "sidebar.panellist").component;
  const glyph = icon({ size: 16, active: true });
  assert.equal(glyph.props["data-dsh-panel-entry"], "dsh-codex-bridge");
  assert.equal(glyph.props.width, 16);
  assert.equal(icon({ size: 0, active: false }).props.width, 16);
});

test("a card's colour and chip are the host's state, with its basis", async () => {
  const client = bootClient([{ ok: true, value: fixture() }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.render();

  assert.deepEqual(byClass(tree, "dcb_card").map((card) => card.props["data-state"]), ["needs-human", "blocked", "no-activity"]);
  assert.deepEqual(byClass(tree, "dcb_chip").map(textOf), ["Needs you", "Blocked", "Nothing observed"]);
  assert.deepEqual(byClass(tree, "dcb_chip").map((chip) => chip.props["data-state"]), ["needs-human", "blocked", "no-activity"]);
  assert.deepEqual(byClass(tree, "dcb_basis").map(textOf), ["reported", "reported", "reported"]);
  // The header counts the same states the cards carry.
  assert.match(textOf(byClass(tree, "dcb_sum")[0]), /^0 running · 1 blocked · 1 needs you · 1 nothing observed$/);
  assert.deepEqual(byClass(tree, "dcb_reason").map(textOf), [
    "This connection is holding 1 approval request.",
    "The goal is still active but no turn is running.",
  ]);
  assert.match(textOf(byClass(tree, "dcb_goal")[0]), /^goal \(active\): finish every stage of the roadmap$/);
});

test("a bar appears only for a denominator the host reported", async () => {
  const client = bootClient([{ ok: true, value: fixture() }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.render();

  const fills = byClass(tree, "dcb_barFill");
  assert.equal(fills.length, 1, "exactly one card carries a real denominator");
  assert.equal(fills[0].props.style.width, "40%");
  const notes = byClass(tree, "dcb_barNote").map(textOf);
  assert.ok(notes.includes("40% of the goal's token budget"));
  assert.ok(notes.includes("400 of 1000 tokens used · source: goal-budget"));
  // The card with no denominator says so and shows the count it does have.
  assert.ok(notes.includes("no progress denominator reported · newest turn has 4 recorded item(s)"));

  const strip = byClass(tree, "dcb_strip");
  assert.equal(strip.length, 1);
  assert.deepEqual(byClass(strip[0], "dcb_dot").map((dot) => dot.props["data-state"]), ["completed", "interrupted"]);
});

test("the quota line is quoted, and a reached quota is a warning, never a guess", async () => {
  const client = bootClient([{ ok: true, value: fixture() }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(byClass(client.render(), "dcb_autoBody").map(textOf).includes("quota: ok · 12% of 300min · 9% weekly · 2 reset credits"));

  const reached = fixture();
  reached.quota = { level: "reached", line: "quota: reached — rateLimitReachedType=primary", text: "rateLimitReachedType=primary", reason: "the server set a reached flag", warnPct: 80 };
  const warned = bootClient([{ ok: true, value: reached }]);
  warned.render();
  warned.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const notes = byClass(warned.render(), "dcb_note").filter((note) => note.props["data-kind"] === "warn");
  assert.equal(notes.length, 1);
  assert.match(textOf(notes[0]), /Codex reports the account is out of quota: rateLimitReachedType=primary/);
});

test("the autopilot is off by default, and arming it asks the host", async () => {
  const client = bootClient(
    [{ ok: true, value: fixture() }],
    { reply: (request) => (request.method === "snapshot" ? { ok: true, value: fixture() } : { ok: true, value: { status: { armed: true } } }) },
  );
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.render();
  assert.ok(byClass(tree, "dcb_autoBody").map(textOf).some((line) => line.startsWith("Off. Nothing in this panel writes to Codex while it is off")));
  assert.deepEqual(byClass(tree, "dcb_tag").map(textOf).filter((label) => label === "off"), ["off"]);

  const arm = withClass(tree, "dcb_btn").find((button) => textOf(button) === "Keep Codex moving for 30m");
  assert.ok(arm, "the arm button never rendered");
  await arm.props.onClick();
  const setCall = client.calls.find((call) => call.method === "autopilot.set");
  assert.deepEqual(setCall.payload, { armed: true, ttlMinutes: 30, reason: "armed from the panel" });
  assert.equal(client.calls.filter((call) => call.method === "snapshot").length, 2, "arming re-reads the snapshot");
});

test("an armed autopilot shows its deadline, its log and what it halted", async () => {
  const armed = fixture();
  armed.autopilot = {
    ...armed.autopilot,
    armed: true, armedAt: "2026-10-10T09:26:24.283Z", expiresAt: "2026-10-10T09:56:24.283Z", remainingMs: 1_800_000, total: 1, passes: 2,
    paused: ["01aa-done"],
    halted: [{ threadId: "01aa-unread", reason: "2 sends failed: thread already has an active writer", at: "2026-10-10T09:50:00.000Z" }],
    log: [{ at: Date.parse("2026-10-10T09:50:00.000Z"), threadId: "01aa-done", action: "sent", code: null, text: "queued a continuation (1/3)" }],
  };
  const client = bootClient([{ ok: true, value: armed }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.render();

  assert.ok(byClass(tree, "dcb_tag").map(textOf).includes("armed for 30m"));
  const lines = byClass(tree, "dcb_autoLine").map(textOf);
  assert.ok(lines.some((line) => line.includes("01aa-unr · stopped: 2 sends failed: thread already has an active writer")));
  assert.ok(lines.some((line) => line.includes("09:50:00Z") && line.includes("01aa-don · sent — queued a continuation (1/3)")));
  assert.equal(byClass(tree, "dcb_autoLine")[0].props["data-kind"], "halt");
  // A paused thread offers to resume, and the pause call names that one thread.
  const buttons = withClass(tree, "dcb_btn");
  const resume = buttons.find((button) => textOf(button) === "Resume this thread");
  assert.ok(resume, "a paused thread should offer Resume");
  await resume.props.onClick();
  const pauseCall = client.calls.find((call) => call.method === "autopilot.pause");
  assert.deepEqual(pauseCall.payload, { threadId: "01aa-done", paused: false });
});

test("the takeover brief renders the host's markdown and can be copied", async () => {
  const markdown = "# Takeover brief\n\n## What Codex was asked to do\n> finish the roadmap\n";
  const client = bootClient([], {
    reply: (request) => {
      if (request.method === "handoff") return { ok: true, value: { ok: true, threadId: "01aa-done", markdown, facts: {}, reason: "" } };
      return { ok: true, value: fixture() };
    },
  });
  const copied = [];
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (text) => { copied.push(text); } } }, configurable: true });
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const briefButton = withClass(client.render(), "dcb_btn").find((button) => textOf(button) === "Takeover brief");
  assert.ok(briefButton, "the brief button never rendered");
  await briefButton.props.onClick();
  const tree = client.render();
  assert.equal(textOf(byClass(tree, "dcb_briefBody")[0]), markdown);
  assert.deepEqual(client.calls.filter((call) => call.method === "handoff").map((call) => call.payload), [{ threadId: "01aa-wait" }]);

  const copy = withClass(tree, "dcb_btn").find((button) => textOf(button) === "Copy");
  await copy.props.onClick();
  assert.deepEqual(copied, [markdown]);
  assert.equal(textOf(withClass(client.render(), "dcb_btn").find((button) => textOf(button) === "Copied")), "Copied");
  delete globalThis.navigator;
});

test("a prepared takeover is shown as unclaimed, and saying so is the default", async () => {
  const snapshot = fixture();
  const card = snapshot.columns[0].cards[0];
  card.takeover = { prepared: true, claimed: false, path: "/tmp/demo/.codex-handoff/01aa-wait.md", preparedAt: 1, claimedAt: null, claimedBy: "" };
  card.failure = { kind: "quota", retryable: false, text: "usage limit reached", matched: "usage limit" };

  const client = bootClient([{ ok: true, value: snapshot }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.render();

  const block = byClass(tree, "dcb_takeover")[0];
  assert.ok(block, "the takeover block is on the card");
  assert.equal(block.props["data-claimed"], "no");
  assert.equal(textOf(byClass(tree, "dcb_takeoverKind")[0]), "takeover prepared, unclaimed");
  assert.match(textOf(byClass(tree, "dcb_takeoverBy")[0]), /not a handover/);

  const labels = withClass(tree, "dcb_btn").map((button) => textOf(button)).filter(Boolean);
  assert.ok(labels.includes("Prepare a takeover"), labels.join(" | "));
  assert.ok(labels.includes("Mark taken over"), labels.join(" | "));
});

test("a claimed takeover says who took it, and stops offering the claim", async () => {
  const snapshot = fixture();
  const card = snapshot.columns[0].cards[0];
  card.takeover = { prepared: true, claimed: true, path: "/tmp/demo/.codex-handoff/01aa-wait.md", preparedAt: 1, claimedAt: 2, claimedBy: "a DeepSeek Harness turn" };

  const client = bootClient([{ ok: true, value: snapshot }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.render();

  assert.equal(byClass(tree, "dcb_takeover")[0].props["data-claimed"], "yes");
  assert.equal(textOf(byClass(tree, "dcb_takeoverKind")[0]), "taken over");
  assert.match(textOf(byClass(tree, "dcb_takeoverBy")[0]), /a DeepSeek Harness turn/);
  const labels = withClass(tree, "dcb_btn").map((button) => textOf(button));
  assert.ok(!labels.includes("Mark taken over"));
});

test("the panel shows the exact message the autopilot handed to Codex", async () => {
  const snapshot = fixture();
  snapshot.autopilot = {
    ...snapshot.autopilot,
    armed: true,
    lastMessage: { at: 1, threadId: "01aa-wait", chars: 42, text: "继续（DeepSeek Harness 自动续跑）：the migration" },
  };
  const client = bootClient([{ ok: true, value: snapshot }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.render();

  const shown = byClass(tree, "dcb_lastBrief")[0];
  assert.ok(shown, "the last brief is rendered");
  assert.match(textOf(shown), /自动续跑/);
  assert.match(textOf(tree), /Last message handed to Codex \(42 chars/);
});

test("an old quota failure keeps its line but does not invite a takeover", async () => {
  const snapshot = fixture();
  const card = snapshot.columns.find((column) => column.id === "no-activity").cards[1];
  card.failure = { kind: "quota", retryable: false, text: "the account's quota or rate limit", matched: "usage limit", quoted: "You've hit your usage limit" };
  card.failureAgeMs = 3 * 86_400_000;
  card.state = "no-activity";

  const client = bootClient([{ ok: true, value: snapshot }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.render();

  // The evidence stays: what happened, and how long ago.
  const failure = byClass(tree, "dcb_failure")[0];
  assert.ok(failure, "the failure line is kept as evidence");
  assert.match(textOf(failure), /needs a person \(quota\)/);
  assert.match(textOf(failure), /ended 72h 0m ago/);

  // The invitation does not.
  const labels = withClass(tree, "dcb_btn").map((button) => textOf(button));
  assert.ok(!labels.includes("Prepare a takeover"), labels.join(" | "));
});

// ---------------------------------------------------------------------------
// The input-dock strip: one line, the page's own numbers, no write path.

test("the strip says it is reading before any snapshot arrives", () => {
  const client = bootClient([]);
  const tree = client.renderSeat("conversation.input.dock");
  const strip = byClass(tree, "dcb_dock")[0];
  assert.ok(strip, "the strip is registered as one element");
  assert.equal(strip.props["data-kind"], "reading");
  assert.equal(textOf(byClass(tree, "dcb_dockText")[0]), "reading the app-server…");
  assert.equal(client.reads.length, 0, "nothing was read before the effect ran");
});

test("the strip quotes the page's own totals and the quota line", async () => {
  const client = bootClient([{ ok: true, value: fixture() }]);
  client.renderSeat("conversation.input.dock");
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.renderSeat("conversation.input.dock");

  assert.equal(byClass(tree, "dcb_dock")[0].props["data-kind"], "live");
  assert.equal(
    textOf(byClass(tree, "dcb_dockText")[0]),
    "3 threads · 0 running · 1 blocked · 1 needs you · 1 nothing observed · " + fixture().quota.line
  );
  assert.equal(client.reads.length, 1);
});

test("a snapshot without totals is named as one, never counted", async () => {
  const client = bootClient([{ ok: true, value: fixture({ totals: undefined }) }]);
  client.renderSeat("conversation.input.dock");
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.renderSeat("conversation.input.dock");

  assert.equal(byClass(tree, "dcb_dock")[0].props["data-kind"], "error");
  assert.match(textOf(byClass(tree, "dcb_dockText")[0]), /carries no totals/);
});

test("a failed read hides the counts instead of ageing them", async () => {
  const client = bootClient([{ ok: true, value: fixture() }, new Error("the host route is gone")]);
  client.renderSeat("conversation.input.dock");
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(byClass(client.renderSeat("conversation.input.dock"), "dcb_dock")[0].props["data-kind"], "live");

  // Let the poll window lapse, then let the strip's next mount read again.
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  try {
    client.renderSeat("conversation.input.dock");
    client.runEffects();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    Date.now = realNow;
  }

  const tree = client.renderSeat("conversation.input.dock");
  assert.equal(byClass(tree, "dcb_dock")[0].props["data-kind"], "stale");
  const text = textOf(byClass(tree, "dcb_dockText")[0]);
  assert.match(text, /^disconnected \(the host route is gone\) · last read \d\d:\d\d:\d\dZ · counts hidden, not live$/);
  assert.ok(!/\d+ threads/.test(text), "no count survives a failed read");
});

test("a second seat on the store joins the read in flight instead of starting one", async () => {
  const client = bootClient([{ ok: true, value: fixture() }]);
  client.renderSeat("conversation.input.dock");
  client.renderSeat("conversation.input.dock");
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.reads.length, 1, "two seats on one store still cost one request");
  assert.match(textOf(byClass(client.renderSeat("conversation.input.dock"), "dcb_dockText")[0]), /^3 threads/);
});

test("the strip offers no way to write to Codex", async () => {
  const client = bootClient([{ ok: true, value: fixture() }]);
  client.renderSeat("conversation.input.dock");
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.renderSeat("conversation.input.dock");

  const buttons = elements(tree).filter((el) => el.type === "button");
  assert.equal(buttons.length, 1, "the strip is a single button");
  const text = buttons.map(textOf).join(" ");
  for (const verb of ["Keep Codex moving", "Stop keeping it moving", "Evaluate one pass", "Prepare a takeover", "Mark taken over", "Pause this thread", "Resume this thread"]) {
    assert.ok(!text.includes(verb), `${verb} is a write and belongs to the page alone`);
  }
  assert.deepEqual(client.calls.map((call) => call.method), ["snapshot"], "the strip only ever read");
});

test("clicking the strip asks the shell to open the board page", () => {
  const selected = [];
  const client = bootClient([], { services: { layout: { selectPanel: (id) => selected.push(id) } } });
  const strip = byClass(client.renderSeat("conversation.input.dock"), "dcb_dock")[0];
  strip.props.onClick();
  assert.deepEqual(selected, ["dsh-codex-bridge"]);
});

test("a strip whose shell has no layout service says so instead of throwing", () => {
  const client = bootClient([]);
  const strip = byClass(client.renderSeat("conversation.input.dock"), "dcb_dock")[0];
  assert.doesNotThrow(() => strip.props.onClick());
});
