/**
 * The resume-not-replay check: `readWorkspace()` against a real repository
 * (created in a temp directory), the porcelain parser, and the guard the
 * supervision brief is built from.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePorcelain, readWorkspace, replayGuard } from "../src/workspace.js";

/** A throwaway repository. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "dcb-workspace-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a clean repository is read as clean, with its branch", async () => {
  const { dir, cleanup } = repo();
  try {
    const state = await readWorkspace({ cwd: dir });
    assert.equal(state.ok, true);
    assert.equal(state.isRepo, true);
    assert.equal(state.state, "clean");
    assert.equal(state.branch, "main");
    assert.equal(state.changedCount, 0);
    assert.deepEqual(state.changedPaths, []);
  } finally {
    cleanup();
  }
});

test("uncommitted work is read as changed, with the paths named", async () => {
  const { dir, cleanup } = repo();
  try {
    writeFileSync(join(dir, "src.js"), "export const a = 1;\n");
    writeFileSync(join(dir, "README.md"), "hello\nmore\n");
    const state = await readWorkspace({ cwd: dir });
    assert.equal(state.state, "dirty");
    assert.ok(state.changedCount >= 2, `expected 2+ changes, saw ${state.changedCount}`);
    assert.ok(state.changedPaths.includes("src.js"), state.changedPaths.join(","));
    assert.ok(state.changedPaths.includes("README.md"));
  } finally {
    cleanup();
  }
});

test("a directory that is not a repository is unknown, not clean", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcb-norepo-"));
  try {
    const state = await readWorkspace({ cwd: dir });
    assert.equal(state.ok, false);
    assert.equal(state.isRepo, false);
    assert.equal(state.state, "unknown");
    assert.match(state.error, /not a git repository/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing working directory is reported as such instead of throwing", async () => {
  const state = await readWorkspace({});
  assert.equal(state.state, "unknown");
  assert.match(state.error, /did not record a working directory/);
});

test("the porcelain parser reads the branch header and the two status columns", () => {
  const parsed = parsePorcelain([
    "## main...origin/main [ahead 2]",
    " M src/board.js",
    "?? src/supervise.js",
    "R  old.js -> new.js",
    "",
  ].join("\n"));
  assert.equal(parsed.isRepo, true);
  assert.equal(parsed.branch, "main");
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.changedCount, 3);
  assert.deepEqual(parsed.changedPaths, ["src/board.js", "src/supervise.js", "new.js"]);
  assert.equal(parsed.state, "dirty");

  const clean = parsePorcelain("## main\n");
  assert.equal(clean.state, "clean");
  assert.equal(clean.changedCount, 0);
});

test("the guard says resume when work is already on disk", () => {
  const card = { turnItemCounts: { fileChange: 2 } };
  const changed = replayGuard(card, { state: "dirty", changedCount: 3, changedPaths: ["a.js", "b.js", "c.js"] });
  assert.equal(changed.risk, "changed");
  assert.match(changed.note, /3 uncommitted change/);
  assert.match(changed.note, /recorded 2 file change/);

  // A turn that recorded file changes counts as "changed" even when the
  // directory reads clean — a committed change is still a change.
  const committed = replayGuard(card, { state: "clean", changedCount: 0, changedPaths: [] });
  assert.equal(committed.risk, "changed");
  assert.match(committed.note, /recorded 2 file change/);
});

test("the guard says clean only when nothing was recorded and nothing is pending", () => {
  const guard = replayGuard({ turnItemCounts: { commandExecution: 4 } }, { state: "clean", changedCount: 0, changedPaths: [] });
  assert.equal(guard.risk, "clean");
  assert.match(guard.note, /clean/);
});

test("an unreadable workspace is unknown, and says why", () => {
  const guard = replayGuard({ turnItemCounts: {} }, { state: "unknown", error: "git is not installed or not on PATH" });
  assert.equal(guard.risk, "unknown");
  assert.match(guard.note, /git is not installed/);

  const unread = replayGuard({ turnItemCounts: {} }, null);
  assert.equal(unread.risk, "unknown");
  assert.match(unread.note, /was not read/);
});
