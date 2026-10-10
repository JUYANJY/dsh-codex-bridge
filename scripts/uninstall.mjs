#!/usr/bin/env node
/**
 * Undo `install.mjs`: drop the symlinks into the profile and restore whatever
 * was moved aside.
 *
 * Only paths recorded in `.install-state.json` are touched, and a path is only
 * removed if it is still a symlink pointing at this checkout — so a profile that
 * was re-linked or replaced by hand since install is left alone.
 *
 * Usage:
 *   node scripts/uninstall.mjs [--dry-run]
 */
import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = join(WORKSPACE, ".install-state.json");

const dryRun = process.argv.includes("--dry-run");

if (!existsSync(STATE_FILE)) {
  console.error(`error: ${STATE_FILE} not found — nothing to uninstall (or install.mjs was never run)`);
  process.exit(1);
}

const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));

/** @returns "missing" | "symlink" | "dir" | "file" */
function kind(path) {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return "symlink";
    return stats.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

/** @returns whether the symlink at `path` resolves into this checkout. */
function pointsAtWorkspace(path) {
  if (kind(path) !== "symlink") return false;
  return resolve(dirname(path), readlinkSync(path)) === WORKSPACE;
}

/** Report, and only act when not a dry run. */
function step(action, description) {
  if (dryRun) {
    console.log(`[dry-run] ${description}`);
    return;
  }
  action();
  console.log(`✓ ${description}`);
}

console.log(`workspace : ${WORKSPACE}`);
console.log(`profile   : ${state.profileDir}`);
console.log(`dry run   : ${dryRun}\n`);

// 1. The name the profile resolves.
if (kind(state.linkDir) === "symlink") {
  step(() => unlinkSync(state.linkDir), `remove ${state.linkDir}`);
} else if (kind(state.linkDir) === "missing") {
  console.log(`· ${state.linkDir} already gone`);
} else {
  console.log(`! ${state.linkDir} is not a symlink; leaving it alone`);
}

// 2. The vendor hop, then the copy that was moved aside.
if (pointsAtWorkspace(state.vendorDir)) {
  step(() => unlinkSync(state.vendorDir), `remove ${state.vendorDir}`);
} else if (kind(state.vendorDir) === "missing") {
  console.log(`· ${state.vendorDir} already gone`);
} else {
  console.log(`! ${state.vendorDir} no longer points at this checkout; leaving it alone`);
}

if (state.vendorBackup) {
  if (kind(state.vendorBackup) !== "missing" && kind(state.vendorDir) === "missing") {
    step(() => renameSync(state.vendorBackup, state.vendorDir), `restore ${state.vendorDir} from ${state.vendorBackup}`);
  } else if (kind(state.vendorBackup) !== "missing") {
    console.log(`! backup ${state.vendorBackup} left in place (target path is occupied)`);
  }
}

// 3. The peer-dependency link is ours to remove: it only ever pointed into the
//    profile's own node_modules.
if (state.scopeLink && kind(state.scopeLink) === "symlink") {
  step(() => unlinkSync(state.scopeLink), `remove ${state.scopeLink}`);
}

// 4. State file.
step(() => rmSync(STATE_FILE), `remove ${STATE_FILE}`);

console.log(`
The loader entry in ${join(state.profileDir, "cordis.patch.yml")} is a hand-maintained
config file, so it was not touched. Remove the \`dsh-codex-bridge\` block from its
\`insert:\` list, then restart DeepSeek Harness.`);
