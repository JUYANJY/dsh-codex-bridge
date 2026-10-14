/**
 * The installer's one dangerous decision is the install id.
 *
 * The host half loads by path and works under any directory name, so a wrong id
 * looks fine until someone opens the UI: the web shell discovers client bundles
 * by matching the loader row's `name` against the nearest package.json's `name`,
 * and a mismatch drops the panel with no error at all. These tests pin the id to
 * the manifest, and pin the scoped path layout that follows from it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(readFileSync(join(WORKSPACE, "package.json"), "utf8"));

/** A throwaway profile with the peer scope the installer insists on. */
function fakeProfile() {
  const root = mkdtempSync(join(tmpdir(), "dcb-install-"));
  const profile = join(root, "desktop");
  mkdirSync(join(profile, "node_modules", "@deepseek-ai", "dsh-tools"), { recursive: true });
  writeFileSync(join(profile, "package.json"), JSON.stringify({ name: "desktop", private: true }));
  writeFileSync(join(profile, "cordis.patch.yml"), "- insert: []\n");
  return profile;
}

/** @returns the installer's stdout for a dry run against `profile`. */
function install(profile, extra = []) {
  return execFileSync(process.execPath, [join(WORKSPACE, "scripts", "install.mjs"), "--profile", profile, "--dry-run", ...extra], {
    encoding: "utf8",
  });
}

test("the install id is the package's own name, scope included", () => {
  const out = install(fakeProfile());
  assert.ok(MANIFEST.name.includes("/"), "this package is scoped, so the layout below is the interesting one");
  assert.match(out, new RegExp(`link node_modules/${MANIFEST.name.replace(/[/@]/g, (c) => `\\${c}`)} ->`));
  // The unscoped nickname must not appear in any path: it is what breaks the panel.
  const nickname = MANIFEST.name.slice(MANIFEST.name.lastIndexOf("/") + 1);
  assert.ok(!out.includes(`node_modules/${nickname} ->`), "the unpacked nickname is not an install id");
});

test("a scoped name is vendored under its scope, and the entry keeps a plain id", () => {
  const out = install(fakeProfile(), ["--write-config"]);
  assert.match(out, new RegExp(`vendor/${MANIFEST.name.replace("/", "/")}`.replace(/[/@]/g, (c) => `\\${c}`)));
  const entry = out.slice(out.indexOf("- insert:"));
  assert.match(entry, new RegExp(`name: '${MANIFEST.name.replace(/[/@]/g, (c) => `\\${c}`)}'`), "the loader row resolves the real specifier");
  assert.match(entry, /id: dsh-codex-bridge'?/);
});

test("it refuses a profile that is not a profile", () => {
  const empty = mkdtempSync(join(tmpdir(), "dcb-notprofile-"));
  assert.throws(() => install(empty), /does not look like a DSH profile/);
});
