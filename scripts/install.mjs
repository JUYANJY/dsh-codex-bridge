#!/usr/bin/env node
/**
 * Link this checkout into a DSH profile so the profile loads *this* directory
 * instead of a vendored copy.
 *
 * The profile resolves the plugin by name from `node_modules`, so the install is
 * two symlinks:
 *
 *   <profile>/vendor/dsh-codex-bridge          -> <this checkout>
 *   <profile>/node_modules/dsh-codex-bridge    -> ../vendor/dsh-codex-bridge
 *
 * The second hop is kept because it is the layout the profile already used; a
 * pre-existing real directory at either path is moved aside, never deleted, and
 * `uninstall.mjs` puts it back.
 *
 * Usage:
 *   node scripts/install.mjs [--profile <dir>] [--write-config] [--dry-run]
 *
 * `--write-config` also appends the loader entry to the profile's
 * cordis.patch.yml when it is missing. Without it, the exact YAML to paste is
 * printed instead: that file is the user's hand-maintained config.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = join(WORKSPACE, ".install-state.json");
const PLUGIN_NAME = "dsh-codex-bridge";

const YAML_ENTRY = `- insert:
    - id: ${PLUGIN_NAME}
      name: ${PLUGIN_NAME}
      config:
        requestTimeoutMs: 30000
`;

/** @returns the parsed `--flag value` arguments. */
function parseArgs(argv) {
  const flags = { profile: null, writeConfig: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") flags.profile = argv[++index];
    else if (arg === "--write-config") flags.writeConfig = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return flags;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?/, "").trim());
  process.exit(0);
}

const profileDir = resolve(args.profile ?? process.env.DSH_PROFILE_DIR ?? join(homedir(), ".dsh", "profiles", "desktop"));
const vendorDir = join(profileDir, "vendor", PLUGIN_NAME);
const linkDir = join(profileDir, "node_modules", PLUGIN_NAME);
const patchFile = join(profileDir, "cordis.patch.yml");

/** Report, and only act when not a dry run. @returns whether the action ran. */
function step(action, description) {
  if (args.dryRun) {
    console.log(`[dry-run] ${description}`);
    return false;
  }
  action();
  console.log(`✓ ${description}`);
  return true;
}

/** @returns "missing" | "symlink" | "dir" | "file" — lstat, so a dangling link is "symlink". */
function kind(path) {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return "symlink";
    return stats.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

if (!existsSync(join(profileDir, "package.json")) && !existsSync(patchFile)) {
  console.error(`error: ${profileDir} does not look like a DSH profile (no package.json or cordis.patch.yml)`);
  process.exit(1);
}

console.log(`workspace : ${WORKSPACE}`);
console.log(`profile   : ${profileDir}`);
console.log(`dry run   : ${args.dryRun}\n`);

// 1. Peer dependencies. The plugin imports @deepseek-ai/dsh-tools and
//    @deepseek-ai/schemastery, which live in the profile tree, not here.
const peerSource = join(dirname(profileDir), "node_modules", "@deepseek-ai");
const peerFallback = join(profileDir, "node_modules", "@deepseek-ai");
const peerTarget = existsSync(join(peerSource, "dsh-tools"))
  ? peerSource
  : (existsSync(join(peerFallback, "dsh-tools")) ? peerFallback : null);
if (!peerTarget) {
  console.error(`error: could not find @deepseek-ai/dsh-tools under ${peerSource} or ${peerFallback}`);
  process.exit(1);
}
const scopeLink = join(WORKSPACE, "node_modules", "@deepseek-ai");
if (kind(scopeLink) === "symlink" && resolve(dirname(scopeLink), readlinkSync(scopeLink)) === peerTarget) {
  console.log(`✓ peer scope already linked (${peerTarget})`);
} else {
  step(() => {
    if (kind(scopeLink) !== "missing") throw new Error(`${scopeLink} exists and is not the expected symlink`);
    mkdirSync(join(WORKSPACE, "node_modules"), { recursive: true });
    symlinkSync(peerTarget, scopeLink);
  }, `link peer scope -> ${peerTarget}`);
}

// 2. The vendor hop.
const backupDir = `${vendorDir}.bak-${Date.now()}`;
let vendorBackup = null;
const vendorKind = kind(vendorDir);
if (vendorKind === "symlink" && resolve(dirname(vendorDir), readlinkSync(vendorDir)) === WORKSPACE) {
  console.log("✓ vendor path already points at this checkout");
} else if (vendorKind === "dir") {
  vendorBackup = backupDir;
  step(() => renameSync(vendorDir, backupDir), `move existing vendored copy aside -> ${backupDir}`);
} else {
  step(() => {
    mkdirSync(dirname(vendorDir), { recursive: true });
    symlinkSync(WORKSPACE, vendorDir);
  }, `link vendor path -> ${WORKSPACE}`);
}
// If the vendored copy was only just moved aside, the link still has to be made.
if (vendorBackup) {
  step(() => symlinkSync(WORKSPACE, vendorDir), `link vendor path -> ${WORKSPACE}`);
}

// 3. The name the profile resolves.
let linkCreated = false;
const linkKind = kind(linkDir);
const wantedLink = relative(dirname(linkDir), vendorDir);
if (linkKind === "symlink" && readlinkSync(linkDir) === wantedLink) {
  console.log("✓ node_modules link already correct");
} else {
  if (linkKind === "dir") {
    const linkBackup = `${linkDir}.bak-${Date.now()}`;
    step(() => renameSync(linkDir, linkBackup), `move existing node_modules entry aside -> ${linkBackup}`);
  } else if (linkKind === "file") {
    throw new Error(`${linkDir} is a file; refusing to replace it`);
  }
  linkCreated = step(() => {
    mkdirSync(dirname(linkDir), { recursive: true });
    symlinkSync(wantedLink, linkDir);
  }, `link node_modules/${PLUGIN_NAME} -> ${wantedLink}`);
}

// 4. Loader registration.
if (existsSync(patchFile) && readFileSync(patchFile, "utf8").includes(PLUGIN_NAME)) {
  console.log("✓ cordis.patch.yml already registers the plugin");
} else if (args.writeConfig && !args.dryRun) {
  writeFileSync(patchFile, `${readFileSync(patchFile, "utf8").replace(/\n*$/, "\n")}\n${YAML_ENTRY}`);
  console.log(`✓ appended the loader entry to ${patchFile}`);
} else {
  console.log(`\n! ${patchFile} does not register this plugin. Add:\n\n${YAML_ENTRY}`);
  console.log("  (re-run with --write-config to append it automatically)");
}

// 5. State for uninstall.
if (!args.dryRun) {
  writeFileSync(STATE_FILE, `${JSON.stringify({
    profileDir,
    vendorDir,
    vendorBackup,
    linkDir,
    linkCreated,
    scopeLink,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(`\n✓ wrote ${STATE_FILE}`);
}

console.log(`
Next: restart DeepSeek Harness (or open a new session). A running Harness keeps
the already-imported copy of the plugin in memory — \`patchReload: live\` re-reads
config, not module code — so the tools will not change until it restarts.`);
