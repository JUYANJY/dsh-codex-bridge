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
    columns: [
      {
        id: "waiting-approval",
        label: "Waiting for you",
        hint: "a server request is open right now",
        cards: [
          {
            threadId: "01aa-wait", shortId: "01aa-wait", title: "Approve the rebuild", ageMs: 61_000,
            preview: "rebuild the docs", cwd: "/tmp/demo", waitingCount: 1, queuedCount: 0,
            turnStartedAt: "2026-10-10T09:50:00.000Z",
            lastItem: { type: "commandExecution", text: "$ rm -rf build", turnId: "turn-1" },
            lastItemStatus: "active",
          },
        ],
      },
      {
        id: "unobserved",
        label: "Not observed",
        hint: "not loaded by this connection",
        cards: [
          {
            threadId: "01aa-done", shortId: "01aa-done", title: "Finished earlier", ageMs: 3_600_000,
            preview: "summarise the log", cwd: "/tmp/demo", waitingCount: 0, queuedCount: 2,
            turnStartedAt: null,
            lastItem: { type: "agentMessage", text: "Done: 3 files changed.", turnId: "turn-2" },
            lastItemStatus: "completed",
          },
          {
            threadId: "01aa-unread", shortId: "01aa-unread", title: "Never read", ageMs: null,
            preview: "old question", cwd: "/tmp/demo", waitingCount: 0, queuedCount: 0,
            turnStartedAt: null, lastItem: null, lastItemStatus: null,
          },
        ],
      },
    ],
    totals: { threads: 3, waiting: 1, running: 0, queued: 0, unobserved: 2, queuedMessages: 2 },
    probe: {
      generatedAt: "2026-10-10T09:56:24.283Z",
      maxThreads: 12, maxQueueProbes: 6, maxItemProbes: 6,
      threadsListed: 3, queueProbed: ["01aa-wait"], queueProbeErrors: [],
      queueUnprobedThreadIds: ["01aa-done", "01aa-unread"], queueCoverageComplete: false,
      itemProbed: ["01aa-wait", "01aa-done"], itemProbeErrors: [],
      itemUnprobedThreadIds: ["01aa-unread"], itemCoverageComplete: false,
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
function bootClient(replies) {
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
  const registrations = [];
  const ctx = {
    slots: {
      inject: (seat, callback) => { callback(); return () => {}; },
      register: (options, component) => { registrations.push({ options, component }); return () => {}; },
    },
    get: (name) => (name === "connection"
      ? {
        rpc: {
          call: async () => {
            reads.push(Date.now());
            const next = replies.shift();
            if (next instanceof Error) throw next;
            if (next === undefined) throw new Error("the test ran out of scripted replies");
            return next;
          },
        },
      }
      : undefined),
    effect: () => () => {},
  };

  mod.apply(ctx);
  const page = registrations.find((entry) => entry.options.name === "main");
  assert.ok(page, "the main page seat was never registered");

  return {
    registrations,
    reads,
    render: () => { hook = 0; return page.component({}); },
    runEffects: () => { const pending = effects.splice(0); for (const effect of pending) effect(); },
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

/** @returns the badges, keyed by their `data-kind`. */
function badgesByKind(tree) {
  const found = {};
  for (const el of elements(tree)) {
    const kind = el.props["data-kind"];
    if (kind) found[kind] = (found[kind] || []).concat(textOf(el));
  }
  return found;
}

test("both seats are registered under the plugin id", () => {
  const client = bootClient([]);
  const sidebar = client.registrations.find((entry) => entry.options.name === "sidebar.panellist");
  const page = client.registrations.find((entry) => entry.options.name === "main");
  assert.equal(sidebar.options.id, "dsh-codex-bridge");
  assert.equal(sidebar.options.label, "Codex");
  assert.equal(sidebar.options.order, 55);
  assert.equal(page.options.key, "dsh-codex-bridge");
  assert.equal(sidebar.component.name, "CodexBoardIcon");
  assert.equal(page.component.name, "CodexBoardPage");
  assert.equal(client.registrations.length, 2);
});

test("the first paint says it is reading, then the snapshot paints the columns", async () => {
  const client = bootClient([{ ok: true, value: fixture() }]);
  const first = client.render();
  assert.equal(byClass(first, "dcb_empty").map(textOf).join(""), "Reading the Codex app-server…");

  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tree = client.render();

  assert.deepEqual(byClass(tree, "dcb_count").map(textOf), ["1", "2"]);
  assert.deepEqual(byClass(tree, "dcb_colName").map(textOf), ["Waiting for you", "Not observed"]);
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

test("the coverage notes follow the host's own flags, numbers included", async () => {
  const client = bootClient([{ ok: true, value: fixture() }]);
  client.render();
  client.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const notes = byClass(client.render(), "dcb_note").map(textOf);
  assert.deepEqual(notes, [
    "Queue coverage is partial: 1 of 3 threads were probed (2 not), so the Queued column is a floor, not a total.",
    "Last-action coverage is partial: 2 of 3 threads were probed (1 not), so cards without a last line were simply not read.",
  ]);

  const complete = fixture();
  complete.probe.queueCoverageComplete = true;
  complete.probe.itemCoverageComplete = true;
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
