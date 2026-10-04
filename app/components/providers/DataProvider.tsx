"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { usePolling } from "../../hooks/usePolling";
import { loadResource, reloadResources, useResource, type ResourceState } from "../../hooks/useResource";
import { agentMeta } from "../../lib/agents";
import { api } from "../../lib/api";
import {
  buildPluginSkillIndex,
  buildSkillView,
  buildUsageIndex,
  type SkillView,
} from "../../lib/skill-model";
import type {
  ActivityAgent,
  CapabilityCatalog,
  IntegrationsData,
  ManagerConfig,
  ScanAgent,
  ScanData,
} from "../../lib/types";
import { isIndexing, type UsageSummary } from "../../lib/usage";

export interface AppData {
  scan: ResourceState<ScanData>;
  config: ResourceState<ManagerConfig>;
  integrations: ResourceState<IntegrationsData>;
  capabilities: ResourceState<CapabilityCatalog>;
  usage: ResourceState<UsageSummary>;
  agents: ScanAgent[];
  agentsById: Map<string, ScanAgent>;
  activityById: Map<string, ActivityAgent>;
  primary: string[];
  agentName: (id: string) => string;
  views: SkillView[];
  viewsById: Map<string, SkillView>;
  needsOnboarding: boolean;
  /** Re-reads everything; `force` asks the service to rescan instead of using its cache. */
  refresh: (force?: boolean) => Promise<void>;
  saveConfig: (next: ManagerConfig) => Promise<ManagerConfig>;
}

const DataContext = createContext<AppData | null>(null);

export const DATA_KEYS = {
  scan: "scan",
  config: "config",
  integrations: "integrations",
  capabilities: "capabilities",
  usage: "usage:summary:30",
};

export function DataProvider({ children }: { children: ReactNode }) {
  const scan = useResource(DATA_KEYS.scan, () => api.scan());
  const config = useResource(DATA_KEYS.config, () => api.config());
  const integrations = useResource(DATA_KEYS.integrations, () => api.integrations());
  const capabilities = useResource(DATA_KEYS.capabilities, () => api.capabilities());
  const usage = useResource(DATA_KEYS.usage, () => api.usageSummary(30));

  // Keep usage-backed numbers (home cards, skill usage) growing while the first index runs.
  usePolling(
    Boolean(usage.data && isIndexing(usage.data.status, usage.data.index)),
    () => void loadResource(DATA_KEYS.usage, undefined, true),
    5_000,
  );

  const refresh = useCallback(async (force = false) => {
    if (force) {
      // Ask the service to rescan; the cached resources then pick up fresh results.
      await Promise.allSettled([api.scan(true), api.integrations(true), api.capabilities(true)]);
    }
    await reloadResources(...Object.values(DATA_KEYS));
  }, []);

  const saveConfig = useCallback(async (next: ManagerConfig) => {
    const saved = await api.saveConfig(next);
    await reloadResources(DATA_KEYS.config, DATA_KEYS.scan);
    return saved;
  }, []);

  const value = useMemo<AppData>(() => {
    const agents = scan.data?.agents || [];
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const activityById = new Map(
      (scan.data?.agentActivity?.agents || []).map((entry) => [entry.agentId, entry]),
    );
    const chosen = config.data?.primaryAgentIds ?? scan.data?.effectivePrimaryAgentIds ?? [];
    const primary = chosen.filter((id) => agentsById.has(id));
    const context = {
      primary,
      agents: agentsById,
      pluginSkills: buildPluginSkillIndex(integrations.data?.plugins || []),
      usage: buildUsageIndex(scan.data?.skills || [], usage.data?.topSkills || []),
    };
    const views = (scan.data?.skills || []).map((skill) => buildSkillView(skill, context));
    return {
      scan,
      config,
      integrations,
      capabilities,
      usage,
      agents,
      agentsById,
      activityById,
      primary,
      agentName: (id: string) => agentMeta(id, agentsById.get(id)).name,
      views,
      viewsById: new Map(views.map((view) => [view.id, view])),
      needsOnboarding: config.status === "ready" && config.data?.primaryAgentIds == null,
      refresh,
      saveConfig,
    };
  }, [scan, config, integrations, capabilities, usage, refresh, saveConfig]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): AppData {
  const value = useContext(DataContext);
  if (!value) throw new Error("useData must be used inside DataProvider");
  return value;
}
