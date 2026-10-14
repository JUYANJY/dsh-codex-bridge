/**
 * Resume, do not replay.
 *
 * A `transient` failure means the run stopped mid-flight — and it may have
 * stopped *after* changing files. Handing Codex a bare "carry on" in that state
 * invites it to redo work that is already on disk. So before a supervision
 * message goes out, this module reads the thread's working directory and the
 * newest turn's own record of file changes, and the brief is written to say
 * "continue from here" rather than "start again".
 *
 * The check is deliberately read-only (`git status`), and deliberately allowed
 * to fail: a directory that is not a repository, or a machine without `git`,
 * yields `state: "unknown"` and the conservative wording, never a guess.
 */
import { execFile } from "node:child_process";

/** How long one `git status` may take before the check gives up. */
export const WORKSPACE_TIMEOUT_MS = 5_000;

/** How many changed paths a brief lists. */
export const WORKSPACE_PATH_LIMIT = 12;

/**
 * Read the working directory's state. Never throws.
 *
 * @param options - `{ cwd, timeoutMs }`.
 * @returns `{ ok, state, isRepo, branch, changedPaths, changedCount, ahead, error, checkedAt }`.
 *   `state` is `"clean"`, `"dirty"` or `"unknown"`.
 */
export async function readWorkspace(options = {}) {
  const cwd = typeof options.cwd === "string" && options.cwd.trim() ? options.cwd.trim() : null;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : WORKSPACE_TIMEOUT_MS;
  const base = {
    ok: false,
    state: "unknown",
    isRepo: false,
    branch: null,
    changedPaths: [],
    changedCount: 0,
    ahead: null,
    error: null,
    checkedAt: new Date().toISOString(),
  };
  if (!cwd) return { ...base, error: "the thread did not record a working directory" };

  try {
    const stdout = await git(["status", "--porcelain=v1", "--branch", "--untracked-files=normal"], { cwd, timeoutMs });
    return { ...base, ...parsePorcelain(stdout), ok: true, error: null };
  } catch (error) {
    return { ...base, error: describeGitError(error) };
  }
}

/**
 * Turn `git status --porcelain=v1 --branch` output into facts.
 * Exported for tests: this is the part that has to be right.
 */
export function parsePorcelain(stdout) {
  const lines = String(stdout ?? "").split("\n").filter((line) => line.length > 0);
  let branch = null;
  let ahead = null;
  const changedPaths = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const header = line.slice(3);
      branch = header.split("...")[0].split(" ")[0] || null;
      const track = /\[(.*)\]/.exec(header);
      if (track) {
        const match = /ahead (\d+)/.exec(track[1]);
        if (match) ahead = Number(match[1]);
      }
      continue;
    }
    // Porcelain v1: two status columns, then the path (renames use "old -> new").
    const path = line.slice(3).split(" -> ").pop();
    if (path) changedPaths.push(path);
  }
  return {
    isRepo: true,
    branch,
    ahead,
    changedPaths: changedPaths.slice(0, WORKSPACE_PATH_LIMIT * 4),
    changedCount: changedPaths.length,
    state: changedPaths.length > 0 ? "dirty" : "clean",
  };
}

/**
 * Whether a supervision message is resuming work or risking a replay.
 *
 * @param card - a board card (`turnItemCounts`, `cwd`).
 * @param workspace - a `readWorkspace()` result, or null when it was not read.
 * @returns `{ risk, note, paths, changedCount }`. `risk` is `"changed"` (work is
 *   already on disk), `"clean"` (nothing to replay) or `"unknown"` (could not
 *   check — treated conservatively).
 */
export function replayGuard(card = {}, workspace = null) {
  const recorded = Number(card?.turnItemCounts?.fileChange) || 0;
  const paths = Array.isArray(workspace?.changedPaths) ? workspace.changedPaths : [];
  const changedCount = Number.isFinite(workspace?.changedCount) ? workspace.changedCount : paths.length;

  if (workspace && workspace.state === "dirty") {
    return {
      risk: "changed",
      changedCount,
      paths,
      note: `the working directory already has ${changedCount} uncommitted change(s)${recorded ? `, and the last turn recorded ${recorded} file change(s)` : ""}`,
    };
  }
  if (recorded > 0) {
    return {
      risk: "changed",
      changedCount,
      paths,
      note: `the last turn recorded ${recorded} file change(s), even though the working directory now reads ${workspace?.state ?? "unknown"}`,
    };
  }
  if (workspace && workspace.state === "clean") {
    return { risk: "clean", changedCount: 0, paths: [], note: "the working directory is clean" };
  }
  return {
    risk: "unknown",
    changedCount,
    paths,
    // The brief wraps this in "could not confirm (…)", so the error stands alone.
    note: workspace?.error ? String(workspace.error) : "the working directory was not read",
  };
}

/** A `git` invocation with no shell, a timeout, and a bounded output. */
function git(args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { timeout: timeoutMs, maxBuffer: 1_000_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(new Error(String(stderr || error.message || error).trim()), { code: error.code, killed: error.killed }));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Say what went wrong, in words a person can act on. */
function describeGitError(error) {
  if (error?.killed) return "the git status check timed out";
  const text = String(error?.message ?? error ?? "").trim();
  if (!text) return "the git status check failed without saying why";
  if (/not a git repository/i.test(text)) return "this directory is not a git repository";
  if (/ENOENT/.test(text) || /not found/i.test(text)) return "git is not installed or not on PATH";
  return text.split("\n")[0];
}
