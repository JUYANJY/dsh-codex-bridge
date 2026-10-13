/**
 * Packaging contract: the name in the shipped loader patch has to be the name the
 * package is published as, because a profile resolves an entry's `name` as a
 * module specifier against its own node_modules and only finds the scoped
 * directory (see docs/limitations.md, section 10). Renaming the package without
 * renaming the patch breaks every bundle install silently, so it is asserted here.
 *
 * The patch is read as text, not parsed: the unit tests carry no YAML dependency,
 * and these assertions are about two literal fields.
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

/** The `name:` line under the insert entry, with its quotes stripped. */
function patchName() {
  const line = patch.split("\n").find((l) => /^\s+name:/.test(l));
  assert.ok(line, "cordis.patch.yml has no `name:` field");
  return line.replace(/^\s+name:\s*/, "").trim().replace(/^['"]|['"]$/g, "");
}

test("the shipped patch mounts the package name the manifest declares", () => {
  assert.equal(patchName(), manifest.name);
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
