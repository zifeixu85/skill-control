import { createHash } from "node:crypto";
import path from "node:path";
import { isWithin } from "./fs-safe.mjs";

/**
 * Primary-agent status model. The goal is not "installed everywhere": status is judged
 * only across the user's primary agents, and managed (vendor/plugin/system) copies never
 * make a skill look out of date or duplicated.
 */

const MANAGED_ROOT_LABELS = [[".mirasim", "Mirasim"]];
const NUMERIC_VERSION = /^v?\d{1,9}(?:\.\d{1,9}){0,5}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/u;

export function realPathId(realPath) {
  return createHash("sha1").update(realPath).digest("hex").slice(0, 16);
}

export function isNumericVersion(value) {
  return typeof value === "string" && NUMERIC_VERSION.test(value.trim());
}

/**
 * Semver-ish comparison: numeric segments numerically, a pre-release sorts below its
 * release. Returns 0 (incomparable) when either side is not a numeric version.
 */
export function compareVersions(left, right) {
  if (!isNumericVersion(left) || !isNumericVersion(right)) return 0;
  const normalize = (value) => value.trim().replace(/^v/iu, "").split("+")[0];
  const [leftCore, leftPre = ""] = normalize(left).split(/-(.*)/su);
  const [rightCore, rightPre = ""] = normalize(right).split(/-(.*)/su);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const order = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (order !== 0) return Math.sign(order);
  }
  if (leftPre && !rightPre) return -1;
  if (!leftPre && rightPre) return 1;
  return Math.sign(leftPre.localeCompare(rightPre, undefined, { numeric: true }));
}

/**
 * Labels instances that a client or sync tool manages. Managed copies are excluded from
 * `differs` and `duplicates`. Codex bundled system skills and plugin caches are also
 * read-only because Codex rewrites them on update.
 */
export function classifyInstanceSource(skillPaths, homeDirectories) {
  const within = (root) => skillPaths.some((candidate) => isWithin(root, candidate));
  for (const home of homeDirectories) {
    if (within(path.join(home, ".codex", "plugins", "cache"))) {
      return { source: "codex-plugin-cache", managed: true, readOnly: true };
    }
    // Codex installs bundled skills here and marks the folder with .codex-system-skills.marker.
    if (within(path.join(home, ".codex", "skills", ".system"))) {
      return { source: "codex-system", managed: true, readOnly: true };
    }
    if (within(path.join(home, ".codex", "vendor_imports", "skills"))) {
      return { source: "codex-vendor-import", managed: true, readOnly: false };
    }
    if (within(path.join(home, ".mirasim", "skills", "synced"))) {
      return { source: "mirasim-synced", managed: true, readOnly: false };
    }
  }
  return { source: "local", managed: false, readOnly: false };
}

export function managedRootLabel(realRoot, homeDirectories) {
  for (const home of homeDirectories) {
    for (const [directory, label] of MANAGED_ROOT_LABELS) {
      if (isWithin(path.join(home, directory), realRoot)) return label;
    }
  }
  return null;
}

/** Groups configured roots that resolve to the same real directory. */
export function buildSharedRoots(rootRecords, homeDirectories, compact) {
  const byReal = new Map();
  for (const record of rootRecords) {
    if (!record.realRoot) continue;
    const list = byReal.get(record.realRoot) || [];
    if (!list.some((item) => item.agentId === record.agentId && item.path === record.path)) {
      list.push({ agentId: record.agentId, path: record.path });
    }
    byReal.set(record.realRoot, list);
  }
  return [...byReal.entries()]
    .filter(([, roots]) => roots.length > 1)
    .map(([realRoot, roots]) => ({
      realPath: compact(realRoot),
      realPathId: realPathId(realRoot),
      roots,
      agentIds: [...new Set(roots.map((root) => root.agentId))],
      managedBy: managedRootLabel(realRoot, homeDirectories),
    }))
    .sort((left, right) => left.realPath.localeCompare(right.realPath));
}

/** Keeps one instance per (agent, real directory); other paths become aliases. */
export function dedupeAgentInstances(instances) {
  const byRealPath = new Map();
  for (const instance of instances) {
    const existing = byRealPath.get(instance.realPath);
    if (existing) {
      existing.aliases.push(instance.path);
      continue;
    }
    byRealPath.set(instance.realPath, { ...instance, aliases: [] });
  }
  return [...byRealPath.values()];
}

/** Marks instances of different agents that are the same physical directory. */
export function markSharedInstances(instances) {
  const agentsByRealPath = new Map();
  for (const instance of instances) {
    const set = agentsByRealPath.get(instance.realPath) || new Set();
    set.add(instance.agentId);
    agentsByRealPath.set(instance.realPath, set);
  }
  return instances.map((instance) => ({
    ...instance,
    realPathId: realPathId(instance.realPath),
    sharedWith: [...agentsByRealPath.get(instance.realPath)].filter(
      (agentId) => agentId !== instance.agentId,
    ),
  }));
}

/** Same skill name in more than one real directory of one Agent, ignoring managed copies. */
export function duplicatesFor(instances) {
  const byAgent = new Map();
  for (const instance of instances) {
    if (instance.managed) continue;
    byAgent.set(instance.agentId, [...(byAgent.get(instance.agentId) || []), instance]);
  }
  return [...byAgent.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([agentId, list]) => ({
      agentId,
      count: list.length,
      identical: new Set(list.map((instance) => instance.hash)).size === 1,
    }));
}

const timeOf = (value) => (value ? Date.parse(value) || 0 : 0);

/**
 * Orders candidates by version only when every candidate has a numeric version; mixing
 * version and time comparisons would not be transitive. Otherwise newest mtime wins.
 */
function candidateComparator(candidates) {
  const byVersion = candidates.every((candidate) => isNumericVersion(candidate.version));
  return (left, right) => {
    if (byVersion) {
      const order = compareVersions(left.version, right.version);
      if (order !== 0) return order;
    }
    return Math.sign(timeOf(left.modifiedAt) - timeOf(right.modifiedAt));
  };
}

/** Computes primary status fields for one aggregated skill. */
export function primaryStatusFor(instances, primaryAgentIds) {
  const primarySet = new Set(primaryAgentIds);
  const primaryInstances = instances.filter((instance) => primarySet.has(instance.agentId));
  const installedPrimary = primaryAgentIds.filter((agentId) =>
    primaryInstances.some((instance) => instance.agentId === agentId),
  );
  const comparable = primaryInstances.filter((instance) => !instance.managed);
  const byHash = new Map();
  for (const instance of comparable) {
    byHash.set(instance.hash, [...(byHash.get(instance.hash) || []), instance]);
  }
  const base = {
    inPrimary: installedPrimary.length > 0,
    installedPrimary,
    missingPrimary: primaryAgentIds.filter((agentId) => !installedPrimary.includes(agentId)),
    primaryStatus: "ok",
    newest: null,
    behind: [],
    diverged: false,
  };
  if (byHash.size < 2) return base;

  const candidates = [...byHash.entries()].map(([hash, list]) => {
    const representative = [...list].sort((a, b) => timeOf(b.modifiedAt) - timeOf(a.modifiedAt))[0];
    return {
      hash,
      agentId: representative.agentId,
      instanceId: representative.id,
      modifiedAt: representative.modifiedAt,
      version: list.find((instance) => instance.version)?.version || "",
    };
  });
  const compare = candidateComparator(candidates);
  candidates.sort((left, right) => compare(right, left));
  const [newest, runnerUp] = candidates;
  const behind = primaryAgentIds.filter((agentId) =>
    comparable.some((instance) => instance.agentId === agentId && instance.hash !== newest.hash),
  );
  return {
    ...base,
    primaryStatus: "differs",
    newest: {
      agentId: newest.agentId,
      instanceId: newest.instanceId,
      modifiedAt: newest.modifiedAt,
      version: newest.version || null,
      shortHash: newest.hash.slice(0, 8),
    },
    behind,
    diverged: compare(newest, runnerUp) === 0,
  };
}
