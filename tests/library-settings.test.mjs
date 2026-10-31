import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LIBRARY_SETTINGS, mergeLibrarySettings, normalizeLibrarySettings } from "../server/library-settings.mjs";
import { sanitizeConfig } from "../server/local-server.mjs";

const agents = [{ id: "codex", name: "Codex", paths: ["~/.codex/skills"] }];

test("defaults: the shared library and auto-link for primary Agents", () => {
  assert.deepEqual(DEFAULT_LIBRARY_SETTINGS, { installMode: "library", autoLink: { enabled: true, scope: "primary" } });
  assert.deepEqual(normalizeLibrarySettings({ installMode: "per-agent", autoLink: { enabled: false, scope: "all" } }), { installMode: "per-agent", autoLink: { enabled: false, scope: "all" } });
  assert.deepEqual(normalizeLibrarySettings({ installMode: "nonsense", autoLink: { enabled: "yes", scope: "everyone" } }), { installMode: "library", autoLink: { enabled: true, scope: "primary" } });
});

test("migration: configs from before v0.3 become the library, with a note of what they were", () => {
  // "copy" is also the old default, so a saved "copy" cannot be told apart from it: library.
  assert.deepEqual(sanitizeConfig({ agents, syncMode: "copy" }).library, { installMode: "library", installModeMigrated: { from: "copy" }, autoLink: { enabled: true, scope: "primary" } });
  assert.deepEqual(sanitizeConfig({ agents, syncMode: "symlink" }).library.installModeMigrated, { from: "symlink" });
  assert.deepEqual(sanitizeConfig({ agents }).library.installModeMigrated, { from: "copy" });
  // Once v0.3 saved the block, it stays as saved.
  const saved = sanitizeConfig({ agents, syncMode: "copy", library: { installMode: "per-agent", autoLink: { enabled: false, scope: "primary" } } }).library;
  assert.deepEqual(saved, { installMode: "per-agent", autoLink: { enabled: false, scope: "primary" } });
});

test("saving the config: only the install mode changes; sending the note back keeps it", () => {
  const previous = { installMode: "library", installModeMigrated: { from: "copy" }, autoLink: { enabled: true, scope: "all" } };
  assert.deepEqual(mergeLibrarySettings(previous, undefined), previous);
  assert.deepEqual(mergeLibrarySettings(previous, { ...previous, autoLink: { enabled: false } }), previous, "auto-link only changes through its own endpoint");
  assert.deepEqual(mergeLibrarySettings(previous, { installMode: "library" }), { installMode: "library", autoLink: { enabled: true, scope: "all" } }, "an explicit choice clears the note");
  assert.deepEqual(mergeLibrarySettings(previous, { installMode: "per-agent", installModeMigrated: { from: "copy" } }), { installMode: "per-agent", autoLink: { enabled: true, scope: "all" } });
});
