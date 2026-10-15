#!/usr/bin/env node
/**
 * Link this checkout into a DSH profile so the profile loads *this* directory
 * instead of a vendored copy.
 *
 * The profile resolves the plugin by name from `node_modules`, so the install is
 * two symlinks:
 *
 *   <profile>/vendor/@juyanjy/dsh-codex-bridge          -> <this checkout>
 *   <profile>/node_modules/@juyanjy/dsh-codex-bridge    -> ../../vendor/@juyanjy/dsh-codex-bridge
 *
 * The install id is this package's own `name`, read from package.json — never a
 * local nickname, and never the directory this checkout happens to sit in. The
 * host half loads by path and does not care, but the **client half does**: the
 * web shell discovers panels by matching the loader row's `name` against the
 * nearest `package.json`'s `name` (`locatePkgJson` → `nearestPackage` in
 * `@deepseek-ai/dsh-client-modules`). An install id that differs from the
 * manifest name makes that lookup return nothing and the panel is dropped
 * **silently**, with no error anywhere: the plugin keeps working on the host and
 * simply has no UI.
 *
 * The second hop is kept because it is the layout the profile already used; a
 * pre-existing real directory at either path is moved aside, never deleted, and
 * `uninstall.mjs` puts it back.
 *
 * Re-running this after moving the checkout is supported: a symlink left over
 * from the old location points at nothing, so it is replaced, not an error. The
 * path of the vendored copy moved aside on the first install is remembered
 * across re-installs, so `uninstall.mjs` can still put the original back.
 *
 * Usage:
 *   node scripts/install.mjs [--profile <dir>] [--write-config] [--dry-run]
 *
 * `--write-config` also appends the loader entry to the profile's
 * cordis.patch.yml when it is missing. Without it, the exact YAML to paste is
 * printed instead: that file is the user's hand-maintained config.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = join(WORKSPACE, ".install-state.json");
/**
 * The specifier every path and the loader row are built from: this package's own
 * `name`. It must be exactly this — see the header on why a nickname silently
 * costs the panel.
 */
const PLUGIN_NAME = JSON.parse(readFileSync(join(WORKSPACE, "package.json"), "utf8")).name;
if (typeof PLUGIN_NAME !== "string" || PLUGIN_NAME === "") {
  throw new Error(`${join(WORKSPACE, "package.json")} has no name`);
}
/** A cordis entry id, which is a plain identifier even when the name is scoped. */
const ENTRY_ID = PLUGIN_NAME.includes("/") ? PLUGIN_NAME.slice(PLUGIN_NAME.lastIndexOf("/") + 1) : PLUGIN_NAME;

const YAML_ENTRY = `- insert:
    - id: ${ENTRY_ID}
      name: '${PLUGIN_NAME}'
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

/** @returns what the path points at, or null when it is not a symlink. */
function linkTarget(path) {
  try {
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return null;
  }
}

/** @returns the previous install's state, or null when there is none or it is unreadable. */
function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
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
//    A symlink that points somewhere else is a leftover from a previous install
//    — the checkout moved, or another one claimed the name. It holds no data, so
//    it is replaced. Only a real directory is worth moving aside, and that move
//    is recorded so uninstall can undo it; a backup made by an earlier install
//    is still on disk, so its record is carried forward rather than lost.
const previousState = readState();
const backupDir = `${vendorDir}.bak-${Date.now()}`;
const carriedBackup = previousState?.vendorBackup && existsSync(previousState.vendorBackup)
  ? previousState.vendorBackup
  : null;
let vendorBackup = carriedBackup;
const vendorKind = kind(vendorDir);
const vendorLinked = vendorKind === "symlink" && linkTarget(vendorDir) === WORKSPACE;
if (vendorLinked) {
  console.log("✓ vendor path already points at this checkout");
} else {
  if (vendorKind === "dir") {
    vendorBackup = backupDir;
    step(() => renameSync(vendorDir, backupDir), `move existing vendored copy aside -> ${backupDir}`);
  } else if (vendorKind === "symlink") {
    step(() => unlinkSync(vendorDir), `drop stale vendor link (was -> ${linkTarget(vendorDir)})`);
  }
  step(() => {
    mkdirSync(dirname(vendorDir), { recursive: true });
    symlinkSync(WORKSPACE, vendorDir);
  }, `link vendor path -> ${WORKSPACE}`);
}
if (carriedBackup && vendorBackup === carriedBackup) {
  console.log(`✓ keeping the earlier backup for uninstall (${carriedBackup})`);
}

// 3. The name the profile resolves. Same carry-forward rule as the vendor hop.
let linkCreated = false;
const carriedLinkBackup = previousState?.linkBackup && existsSync(previousState.linkBackup)
  ? previousState.linkBackup
  : null;
let linkBackup = carriedLinkBackup;
const linkKind = kind(linkDir);
const wantedLink = relative(dirname(linkDir), vendorDir);
if (linkKind === "symlink" && readlinkSync(linkDir) === wantedLink) {
  console.log("✓ node_modules link already correct");
} else {
  if (linkKind === "dir") {
    linkBackup = `${linkDir}.bak-${Date.now()}`;
    step(() => renameSync(linkDir, linkBackup), `move existing node_modules entry aside -> ${linkBackup}`);
  } else if (linkKind === "file") {
    throw new Error(`${linkDir} is a file; refusing to replace it`);
  } else if (linkKind === "symlink") {
    step(() => unlinkSync(linkDir), `drop stale node_modules link (was -> ${linkTarget(linkDir)})`);
  }
  linkCreated = step(() => {
    mkdirSync(dirname(linkDir), { recursive: true });
    symlinkSync(wantedLink, linkDir);
  }, `link node_modules/${PLUGIN_NAME} -> ${wantedLink}`);
}
if (carriedLinkBackup && linkBackup === carriedLinkBackup) {
  console.log(`✓ keeping the earlier node_modules backup for uninstall (${carriedLinkBackup})`);
}

// 3.5. Detect which registration route the profile already uses. A package in
//      `dsh.profile.bundles` is mounted by its shipped `dsh.bundle.patch`, so it
//      needs no second hand-written row. The checkout symlink does not change the
//      client module id: `src/client.js` must still register PLUGIN_NAME exactly.
const profileManifestPath = join(profileDir, "package.json");
let inProfileBundles = false;
if (existsSync(profileManifestPath)) {
  try {
    const profileManifest = JSON.parse(readFileSync(profileManifestPath, "utf8"));
    inProfileBundles = Array.isArray(profileManifest.dsh?.profile?.bundles)
      && profileManifest.dsh.profile.bundles.includes(PLUGIN_NAME);
  } catch (error) {
    console.warn(`! could not read ${profileManifestPath} to check dsh.profile.bundles: ${error.message}`);
  }
}
// 4. Loader registration.
if (inProfileBundles) {
  console.log("✓ registered via dsh.profile.bundles; the checkout insert is intentionally not added (one route)");
} else if (existsSync(patchFile) && readFileSync(patchFile, "utf8").includes(PLUGIN_NAME)) {
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
    linkBackup,
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
