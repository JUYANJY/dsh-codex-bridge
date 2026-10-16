/**
 * Packaging contract: the name in the shipped loader patch has to be the name the
 * package is published as, because a profile resolves an entry's `name` as a
 * module specifier against its own node_modules and only finds the scoped
 * directory (see docs/limitations.md, section 10). Renaming the package without
 * renaming the patch breaks every bundle install silently, so it is asserted here.
 *
 * The patch is read as text, not parsed: the unit tests carry no YAML dependency,
 * and these assertions are about three literal facts. The row count matters as
 * much as the name: `[]` unregisters the plugin with no error anywhere, and a
 * second row registers the package twice — which is the duplicate-factory crash
 * below this one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, name), "utf8");
const manifest = JSON.parse(read("package.json"));
const patch = read("cordis.patch.yml");
const client = read("src/client.js");

/** The `name:` line under the insert entry, with its quotes stripped. */
function patchName() {
  const line = patch.split("\n").find((l) => /^\s+name:/.test(l));
  assert.ok(line, "cordis.patch.yml has no `name:` field");
  return line.replace(/^\s+name:\s*/, "").trim().replace(/^['"]|['"]$/g, "");
}

test("the patch declares exactly one insert row — never zero, never two", () => {
  const rows = patch.match(/^- insert:/gm) ?? [];
  assert.equal(
    rows.length,
    1,
    rows.length === 0
      ? "an empty patch is silent: no loader entry, no tools, and nothing to notice"
      : "a second insert row mounts the same package twice, which is the duplicate-factory crash",
  );
});

test("the shipped patch mounts the package name the manifest declares", () => {
  assert.equal(patchName(), manifest.name);
});

test("the client factory registers under the package name", () => {
  const match = client.match(/window\.__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/);
  assert.ok(match, "src/client.js has no client-module factory registration");
  assert.equal(
    match[1],
    manifest.name,
    "a different factory id makes the preloaded scoped bundle look absent, so the loader executes it twice",
  );
});

test("the entry id stays the short local id, which is not the package name", () => {
  assert.match(patch, /^\s*- id: dsh-codex-bridge$/m);
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
});

test("the patch is in the published file list, and the scope is public", () => {
  assert.ok(manifest.files.includes("cordis.patch.yml"));
  assert.equal(manifest.publishConfig.access, "public");
  assert.match(manifest.name, /^@[^/]+\//, "a scoped name needs an explicit public access");
});

test("the published file list keeps this repo's own material out of the tarball", () => {
  // `files: ["docs"]` shipped the agent docs and the internal review dossier
  // (45 KB) to every user, so the user-facing surface is named file by file.
  assert.equal(
    manifest.files.includes("docs"),
    false,
    "listing `docs` wholesale ships docs/agents and docs/research",
  );
  assert.ok(manifest.files.includes("docs/limitations.md"));
  assert.ok(manifest.files.includes("docs/protocol.md"));
  assert.equal(
    manifest.files.some((entry) => entry.includes("research") || entry.includes("agents")),
    false,
  );
});
