/**
 * Library settings in config.json (`library`), v0.3:
 * - installMode: "library" (one copy in ~/.agents/skills, reached by every Agent through its
 *   tier) or "per-agent" (the old way: a copy in each Agent's own folder).
 * - autoLink: { enabled, scope: "primary" | "all" } — new library skills reach the chosen
 *   Agents automatically (server/auto-link.mjs keeps the baseline and history).
 *
 * Migration: configs from before v0.3 have only `syncMode` ("copy" by default, "symlink"
 * when the user picked links). A saved "copy" cannot be told apart from the default, so
 * every old config becomes "library" and keeps `installModeMigrated` (what it came from)
 * until the user sets the install mode; the release notes say so.
 */

export const INSTALL_MODES = ["library", "per-agent"];
export const AUTO_LINK_SCOPES = ["primary", "all"];

export const DEFAULT_LIBRARY_SETTINGS = Object.freeze({
  installMode: "library",
  autoLink: Object.freeze({ enabled: true, scope: "primary" }),
});

/** A plain, valid `library` block for config.json. `legacySyncMode` is the old `syncMode`. */
export function normalizeLibrarySettings(input, { legacySyncMode = null } = {}) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const autoLinkInput = value.autoLink && typeof value.autoLink === "object" ? value.autoLink : {};
  const autoLink = {
    enabled: typeof autoLinkInput.enabled === "boolean" ? autoLinkInput.enabled : DEFAULT_LIBRARY_SETTINGS.autoLink.enabled,
    scope: AUTO_LINK_SCOPES.includes(autoLinkInput.scope) ? autoLinkInput.scope : DEFAULT_LIBRARY_SETTINGS.autoLink.scope,
  };
  if (INSTALL_MODES.includes(value.installMode)) {
    const migrated = value.installModeMigrated && typeof value.installModeMigrated === "object" && ["copy", "symlink"].includes(value.installModeMigrated.from)
      ? { installModeMigrated: { from: value.installModeMigrated.from } }
      : {};
    return { installMode: value.installMode, ...migrated, autoLink };
  }
  // No install mode yet: a config from before v0.3 (or a new one).
  return {
    installMode: DEFAULT_LIBRARY_SETTINGS.installMode,
    ...(legacySyncMode ? { installModeMigrated: { from: legacySyncMode === "symlink" ? "symlink" : "copy" } } : {}),
    autoLink,
  };
}

/**
 * The `library` block after a PUT /api/config: only the install mode can change there
 * (auto-link settings go through POST /api/library/auto-link, which keeps the baseline).
 * Sending the block back unchanged (with its migration note) keeps the note; sending an
 * install mode without the note means the user chose it, which clears the note.
 */
export function mergeLibrarySettings(previous, input) {
  const base = normalizeLibrarySettings(previous);
  const requested = input && typeof input === "object" ? input.installMode : undefined;
  if (!INSTALL_MODES.includes(requested)) return base;
  const keepNote = base.installModeMigrated && requested === base.installMode && input.installModeMigrated;
  return { installMode: requested, ...(keepNote ? { installModeMigrated: base.installModeMigrated } : {}), autoLink: base.autoLink };
}
