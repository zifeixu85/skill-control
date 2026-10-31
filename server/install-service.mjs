import { createPlanStore } from "./plan-store.mjs";
import { LibraryError } from "./library-ops.mjs";
import { normalizeLibrarySettings } from "./library-settings.mjs";
import { TIER_LABELS, tierOf } from "./library-agents.mjs";

/**
 * One install flow for every entry point (v0.3 §3: import .skill / zip / folder, sync from
 * one Agent to others, the install switch in a skill's details, the companion skill):
 *
 * - scope "primary": into the library, connected to every primary Agent;
 * - scope "agents": into the library, connected to the chosen Agents (native readers see it anyway);
 * - scope "agent-only": a copy in that one Agent's own folder, not in the library.
 *
 * With install mode "per-agent" (the old way) the first two copy into each Agent's own
 * folder instead. Every install is previewed first (plan), runs only with a confirmation
 * and can be undone from history.
 *
 * Scopes "agents" and "agent-only" also tombstone the skill for every Agent auto-link would
 * connect it to that the user left unticked (`autoLinkSkip` in the plan), so a scan a moment
 * later does not link it there anyway. The tombstones are written under the library lock,
 * together with the install.
 *
 * `context`: { library (library-service), getConfig(), resolveSource(source) → { sourcePath,
 * name, sourceHash, label }, perAgent: { plan({ source, targetAgentIds }), apply({ source,
 * targetAgentIds }) }, now }.
 */

export const INSTALL_SCOPES = ["primary", "agents", "agent-only"];
const PLAN_TTL_MS = 10 * 60_000;

export function createInstallService(context) {
  const now = context.now || (() => Date.now());
  const plans = createPlanStore({ ttlMs: PLAN_TTL_MS, now, label: "安装计划" });

  async function targetsFor(config, scope, agentIds) {
    const known = new Set((config.agents || []).map((agent) => agent.id));
    if (scope === "primary") {
      const primary = (config.primaryAgentIds || []).filter((id) => known.has(id));
      if (!primary.length) throw new LibraryError(409, "还没有常用 Agent，请先在设置里选择，或改为“选择 Agent”。", "no-primary-agents");
      return primary;
    }
    const chosen = [...new Set((Array.isArray(agentIds) ? agentIds : []).filter((id) => typeof id === "string" && known.has(id)))].slice(0, 24);
    if (!chosen.length) throw new LibraryError(400, "请至少选择一个 Agent。", "invalid-request");
    if (scope === "agent-only" && chosen.length !== 1) throw new LibraryError(400, "“只装到某个 Agent”只能选一个 Agent。", "invalid-request");
    return chosen;
  }

  /** What each target Agent gets, from the library plan's items (for the preview). */
  function targetsOf(targetIds, snapshot, items) {
    return targetIds.map((agentId) => {
      const agent = snapshot.agents.find((item) => item.agentId === agentId);
      const tier = tierOf(agentId);
      const own = items.filter((item) => item.agentId === agentId);
      const outcome =
        tier === "native"
          ? "native"
          : own.some((item) => item.kind === "conflict")
            ? "conflict"
            : own.some((item) => item.kind === "link")
              ? "link"
              : own.some((item) => item.kind === "copy")
                ? "copy"
                : own.some((item) => item.kind === "dedupe")
                  ? "replace-copy"
                  : own.some((item) => item.kind === "config")
                    ? "config"
                    : tier === "none"
                      ? "unsupported"
                      : "already";
      return { agentId, name: agent?.name || agentId, tier, method: TIER_LABELS[tier] || TIER_LABELS.none, outcome };
    });
  }

  /**
   * POST /api/install/plan { source: { importId } | { instanceId } | { library } | { bundled },
   * scope, agentIds?, choices? }.
   */
  async function plan({ source, scope, agentIds = null, choices = {} } = {}) {
    if (!INSTALL_SCOPES.includes(scope)) throw new LibraryError(400, "安装范围无效。", "invalid-request");
    const config = await context.getConfig();
    const settings = normalizeLibrarySettings(config.library);
    const targetAgentIds = await targetsFor(config, scope, agentIds);
    const mode = scope === "agent-only" || settings.installMode === "per-agent" ? "per-agent" : "library";
    const snapshot = await context.library.snapshot();
    const skipAgentIds = scope === "primary" ? [] : await context.library.autoLink.unpickedAgents(targetAgentIds, { snapshot });
    if (mode === "per-agent") {
      if (source?.bundled) throw new LibraryError(400, "随附技能只能放进技能库。", "invalid-request");
      const preview = await context.perAgent.plan({ source, targetAgentIds });
      const name = skipAgentIds.length ? (await context.resolveSource(source)).name : null;
      const skip = name ? skipAgentIds.map((agentId) => ({ agentId, skill: name })) : [];
      const planId = plans.remember({ mode, source, targetAgentIds, skip });
      return { ...preview, planId, mode, scope, installMode: settings.installMode, targetAgentIds, autoLinkSkip: skip.map((pair) => pair.agentId), expiresAt: new Date(now() + PLAN_TTL_MS).toISOString() };
    }
    const resolved = await context.resolveSource(source);
    const libraryPlan = await context.library.plan({
      action: "install",
      install: { sourcePath: resolved.sourcePath, name: resolved.name, sourceHash: resolved.sourceHash, agentIds: targetAgentIds, skipAgentIds },
      choices: choices && typeof choices === "object" ? choices : {},
    });
    const nativeAgents = snapshot.agents.filter((agent) => tierOf(agent.agentId) === "native").map((agent) => agent.agentId);
    const planId = libraryPlan.planId ? plans.remember({ mode, libraryPlanId: libraryPlan.planId }) : null;
    return {
      ...libraryPlan,
      planId,
      mode,
      scope,
      installMode: settings.installMode,
      skillName: resolved.name,
      label: resolved.label || resolved.name,
      library: snapshot.library.root,
      targets: targetsOf(targetAgentIds, snapshot, libraryPlan.items),
      // Native readers see every library skill, chosen or not.
      alsoVisibleTo: nativeAgents.filter((agentId) => !targetAgentIds.includes(agentId)),
      ...(libraryPlan.planId ? { expiresAt: new Date(now() + PLAN_TTL_MS).toISOString() } : {}),
    };
  }

  /** POST /api/install/apply { planId, confirm: true } (confirm header checked by the route). */
  async function apply({ planId, confirm } = {}) {
    if (confirm !== true) throw new LibraryError(400, "需要明确确认后才能安装。", "confirm-required");
    const stored = plans.take(planId);
    // Library mode: the library plan writes the tombstones with the links, under its lock.
    if (stored.mode === "library") return { mode: "library", ...(await context.library.apply({ planId: stored.libraryPlanId, confirm: true })) };
    const install = async () => {
      const result = await context.perAgent.apply({ source: stored.source, targetAgentIds: stored.targetAgentIds });
      if (stored.skip.length) await context.library.autoLink.record({ removed: stored.skip });
      return { mode: "per-agent", ...result };
    };
    // Under the library lock, so an auto-link run cannot slip in between the copy and the tombstones.
    return stored.skip.length ? context.library.autoLink.locked(install) : install();
  }

  return { plan, apply };
}
