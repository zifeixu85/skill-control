import { homedir } from "node:os";
import path from "node:path";
import { envFor, expandUserPath } from "./config-files.mjs";
import { hermesHomeFor, hermesSkillSources } from "./hermes.mjs";
import { openClawSkillSources } from "./openclaw.mjs";

/**
 * Agents whose skill layout is richer than "a folder of SKILL.md folders". An adapter
 * returns skill sources (roots with their own discovery, labels and precedence), the
 * install root, and install policy. Agents without an adapter use the generic scan.
 */
export const SKILL_ADAPTERS = {
  hermes: (homeDirectory) => hermesSkillSources(homeDirectory),
  openclaw: (homeDirectory) => openClawSkillSources("openclaw", homeDirectory),
  qclaw: (homeDirectory) => openClawSkillSources("qclaw", homeDirectory),
};

/** Paths whose existence means the product is installed (beyond its skill folders). */
export function detectionPaths(agentId, homeDirectory = homedir()) {
  switch (agentId) {
    case "hermes":
      return [hermesHomeFor(homeDirectory)];
    case "openclaw": {
      const configured = envFor(homeDirectory, "OPENCLAW_STATE_DIR");
      return configured
        ? [expandUserPath(configured, { homeDirectory })]
        : [".openclaw", ".clawdbot", ".moltbot"].map((name) => path.join(homeDirectory, name));
    }
    case "qclaw":
      return [path.join(homeDirectory, ".qclaw", "qclaw.json")];
    case "smartorder":
      return [path.join(homeDirectory, ".smartorder", "config.toml")];
    default:
      return [];
  }
}

/**
 * Marks instances that the product itself will not use because another copy with the
 * same name wins. Hermes: first seen wins (local before external) per profile.
 * OpenClaw: higher precedence wins, evaluated per agent workspace.
 */
export function applyPrecedence(instances) {
  const groups = new Map();
  for (const instance of instances) {
    if (instance.precedence === undefined) continue;
    const key = instance.name.trim().toLocaleLowerCase();
    groups.set(key, [...(groups.get(key) || []), instance]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const candidates = group.filter((instance) => !instance.hiddenByProduct);
    const winners = new Set();
    const scopes = new Set(candidates.flatMap((instance) => instance.scopes || [instance.scope]));
    for (const scope of scopes) {
      const inScope = candidates.filter((instance) => (instance.scopes || [instance.scope]).includes(scope));
      if (!inScope.length) continue;
      const ordered = [...inScope].sort((left, right) =>
        left.firstWins ? left.precedence - right.precedence || left.order - right.order : right.precedence - left.precedence || right.order - left.order,
      );
      winners.add(ordered[0]);
    }
    for (const instance of candidates) {
      if (winners.has(instance)) continue;
      const winner = [...winners].find((item) =>
        (item.scopes || [item.scope]).some((scope) => (instance.scopes || [instance.scope]).includes(scope)),
      );
      if (winner) {
        instance.shadowed = true;
        instance.shadowedBy = winner.source || "local";
      }
    }
  }
  for (const instance of instances) {
    if (instance.shadowed || instance.hiddenByProduct || instance.disabled) instance.inactive = true;
  }
  return instances;
}
