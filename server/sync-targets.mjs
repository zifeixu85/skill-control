import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  compactHomePath,
  homeVariants,
  isStrictlyWithin,
  isWithin,
} from "./fs-safe.mjs";
import { describeSkippedLinks, findUnsafeLinks } from "./skill-copy.mjs";
import { realPathId } from "./skill-status.mjs";

/** Real path of a destination that may not exist yet (nearest existing ancestor + rest). */
export async function realDestinationPath(destinationPath) {
  const remainder = [];
  let current = path.resolve(destinationPath);
  for (;;) {
    try {
      return path.join(await realpath(current), ...remainder);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) {
        throw new Error("无法解析目标目录的真实位置。");
      }
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(destinationPath);
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Tracks planned writes by real directory.
 *
 * - A destination that is a symlink is written through: the plan (and execution) target
 *   its real directory, which must lie inside a configured Agent skill root.
 * - Two Agents that share one physical directory (or share it with the source) produce a
 *   single write, never two.
 * - Destinations that contain, or are contained by, the source are refused.
 * Each claim reports which other Agents will see the written directory.
 */
export async function createWriteTracker({
  sourcePath = null,
  sourceAgentId = null,
  agents = [],
  expandPath = (value) => path.resolve(value),
  displayHomeDirectory,
}) {
  const displayHomes = displayHomeDirectory ? await homeVariants(displayHomeDirectory) : [];
  const realSource = sourcePath ? await realpath(sourcePath).catch(() => null) : null;
  const realRoots = (
    await Promise.all(
      agents.flatMap((agent) =>
        agent.paths.map(async (rootPath) => ({
          agentId: agent.id,
          realRoot: await realDestinationPath(expandPath(rootPath)).catch(() => null),
        })),
      ),
    )
  ).filter((item) => item.realRoot);
  const owners = new Map();
  const members = new Map();
  const compactReal = (value) => compactHomePath(value, displayHomes);
  const alsoVisibleTo = (agentId, realDestination) => [
    ...new Set(
      realRoots
        .filter(
          (item) =>
            item.agentId !== agentId && isStrictlyWithin(item.realRoot, realDestination),
        )
        .map((item) => item.agentId),
    ),
  ];

  async function resolveTarget(destinationPath, label) {
    const leaf = await lstat(destinationPath).catch(() => null);
    const viaSymlink = Boolean(leaf?.isSymbolicLink());
    let realDestination;
    if (viaSymlink) {
      try {
        realDestination = await realpath(destinationPath);
      } catch {
        throw new Error(`${label} 中的同名技能是失效的软链接，已拒绝写入，请先修复或删除该链接。`);
      }
    } else {
      realDestination = await realDestinationPath(destinationPath);
    }
    if (!realRoots.some((item) => isStrictlyWithin(item.realRoot, realDestination))) {
      throw new Error(
        `${label} 的目标${viaSymlink ? "是软链接，其" : ""}真实位置不在任何已配置的 Agent 技能目录内，为避免改写外部文件已拒绝写入。`,
      );
    }
    if (
      realSource &&
      realDestination !== realSource &&
      (isStrictlyWithin(realSource, realDestination) ||
        isStrictlyWithin(realDestination, realSource))
    ) {
      throw new Error(`${label} 的目标目录与来源目录互相包含，已拒绝写入。`);
    }
    return { realDestination, viaSymlink };
  }

  return {
    async claim(agentId, destinationPath, label = agentId) {
      const { realDestination, viaSymlink } = await resolveTarget(destinationPath, label);
      const group = members.get(realDestination) || [];
      if (!group.includes(agentId)) group.push(agentId);
      members.set(realDestination, group);
      const base = {
        realDestination: compactReal(realDestination),
        realPathId: realPathId(realDestination),
        writePath: realDestination,
        viaSymlink,
        alsoVisibleTo: alsoVisibleTo(agentId, realDestination),
      };
      if (realSource && realDestination === realSource) {
        if (sourceAgentId && !group.includes(sourceAgentId)) group.unshift(sourceAgentId);
        return { ...base, reason: "same-directory", sharedWithAgentId: sourceAgentId };
      }
      if (owners.has(realDestination)) {
        return {
          ...base,
          reason: "shared-with-target",
          sharedWithAgentId: owners.get(realDestination),
        };
      }
      owners.set(realDestination, agentId);
      return { ...base, reason: null, sharedWithAgentId: null };
    },
    sharedDestinations() {
      return [...members.entries()]
        .filter(([, agentIds]) => agentIds.length > 1)
        .map(([realDestination, agentIds]) => ({
          realPath: compactReal(realDestination),
          agentIds,
        }));
    },
  };
}

// Copies a product updates or manages itself; installing over them is refused.
const PRODUCT_MANAGED_SOURCES = new Map([
  ["hermes-hub", "Skills Hub "],
  ["hermes-bundled", "内置"],
  ["hermes-org", "组织同步"],
]);

/**
 * Prefers a writable, non-managed copy. When the only copies are Codex's bundled
 * `.system` skills, a new user copy is created beside them (Codex rewrites `.system`
 * on update); any other Agent with only read-only copies is refused.
 */
export function pickTargetInstance(instances, agent) {
  const own = (instances || []).filter((instance) => instance.agentId === agent.id);
  const writable = own.filter((instance) => !instance.readOnly);
  const preferred =
    writable.find((instance) => !instance.managed && !instance.inactive) ||
    writable.find((instance) => !instance.managed) ||
    writable[0];
  if (preferred) return preferred;
  if (own.length && own.every((instance) => instance.source === "codex-system")) {
    return null;
  }
  if (own.length) {
    throw new Error(`${agent.name} 的该技能由客户端或插件管理，请在原客户端更新，管理器仅提供读取。`);
  }
  return null;
}

async function exists(inputPath) {
  return Boolean(await lstat(inputPath).catch(() => null));
}

/**
 * Plans one action per target Agent. Destinations are resolved to real directories so
 * execution writes exactly where the plan says (`realDestination`), shared directories
 * get a single write, and copies never include links that escape the source skill.
 * Actions carry internal absolute paths (`sourcePath`, `writePath`, `backupPath`) that
 * publicPlan() strips before a plan leaves the service.
 */
export async function planTargetWrites({
  config,
  targetAgentIds,
  instances,
  source,
  mode,
  expandPath,
  compactPath,
  displayHomeDirectory,
  backupDirectory,
  backupGroup,
  scanAgents = [],
}) {
  const targetIds = [
    ...new Set(Array.isArray(targetAgentIds) ? targetAgentIds : []),
  ].slice(0, 24);
  // Every root an Agent actually loads (adapter roots included), so `alsoVisibleTo`
  // reports Agents that see a write through shared folders such as ~/.agents/skills.
  const scanned = new Map(scanAgents.map((agent) => [agent.id, agent]));
  const agentRoots = (agent) => [
    ...new Set([...agent.paths, ...(scanned.get(agent.id)?.roots || []).map((root) => root.path).filter(Boolean)]),
  ];
  const writes = await createWriteTracker({
    sourcePath: source.path,
    sourceAgentId: source.agentId,
    agents: config.agents.map((agent) => ({ ...agent, paths: agentRoots(agent) })),
    expandPath,
    displayHomeDirectory,
  });
  const unsafeLinks = await findUnsafeLinks(source.path);
  const actions = [];
  const warnings = [];

  for (const targetAgentId of targetIds) {
    const agent = config.agents.find((item) => item.id === targetAgentId);
    if (!agent) continue;
    const policy = scanned.get(agent.id) || {};
    if (policy.refuseInstall) throw new Error(policy.refuseInstall);
    const productManaged = (instances || []).find(
      (instance) => instance.agentId === agent.id && PRODUCT_MANAGED_SOURCES.has(instance.source),
    );
    if (productManaged) {
      throw new Error(
        `${agent.name} 里已有同名的${PRODUCT_MANAGED_SOURCES.get(productManaged.source)}技能，由 ${agent.name} 自己更新或管理，不能直接覆盖。`,
      );
    }
    const actionMode = policy.copyOnly ? "copy" : mode;
    if (actionMode !== mode) warnings.push(`${agent.name} 只支持复制安装，已改用复制。`);
    const existing = pickTargetInstance(instances, agent);
    const existingPath = existing ? expandPath(existing.path) : null;
    const rootPath =
      (existingPath
        ? agentRoots(agent)
            .map(expandPath)
            .find((candidateRoot) => isWithin(candidateRoot, existingPath))
        : null) || expandPath(policy.installRoot || agent.paths[0]);
    const destinationPath = existing
      ? existingPath
      : path.join(rootPath, source.directoryName);
    if (!isStrictlyWithin(rootPath, destinationPath)) {
      throw new Error(
        `目标必须位于 ${agent.name} 的技能目录内，不能替换技能根目录本身。`,
      );
    }
    const shared = await writes.claim(agent.id, destinationPath, agent.name);
    const identical =
      Boolean(existing) &&
      (source.hash ? existing.hash === source.hash : existing.shortHash === source.shortHash);
    const action =
      shared.reason || (identical && actionMode === "copy")
        ? "noop"
        : (await exists(shared.writePath))
          ? "replace"
          : "create";
    const backupPath =
      action === "replace"
        ? path.join(backupDirectory, backupGroup, agent.id, path.basename(destinationPath))
        : null;
    const viewers = (instances || [])
      .filter((instance) => instance.realPathId === shared.realPathId && instance.agentId !== agent.id)
      .map((instance) => instance.agentId);
    actions.push({
      agentId: agent.id,
      agentName: agent.name,
      action,
      mode: actionMode,
      source: compactPath(source.path),
      destination: compactPath(destinationPath),
      realDestination: shared.realDestination,
      viaSymlink: shared.viaSymlink,
      reason: shared.reason,
      sharedWithAgentId: shared.sharedWithAgentId,
      alsoVisibleTo: [...new Set([...shared.alsoVisibleTo, ...viewers])],
      backup: backupPath ? compactPath(backupPath) : null,
      sourceHash: source.shortHash,
      targetHash: existing?.shortHash || null,
      identical,
      skippedLinks: ["create", "replace"].includes(action) && actionMode === "copy" ? unsafeLinks : [],
      sourcePath: source.path,
      writePath: shared.writePath,
      backupPath,
    });
  }
  const linkWarning = describeSkippedLinks(unsafeLinks);
  if (linkWarning && actions.some((item) => item.skippedLinks.length)) warnings.push(linkWarning);
  return {
    actions,
    backupGroup,
    sharedDestinations: writes.sharedDestinations(),
    warnings: [...new Set(warnings)],
  };
}

const INTERNAL_ACTION_FIELDS = ["sourcePath", "writePath", "backupPath"];

export function publicAction(action) {
  const result = { ...action };
  for (const key of INTERNAL_ACTION_FIELDS) delete result[key];
  return result;
}

export function publicPlan(plan) {
  return { ...plan, actions: plan.actions.map(publicAction) };
}
