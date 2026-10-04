"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { usePolling } from "../../hooks/usePolling";
import {
  cachedResourceKeys,
  invalidateResources,
  loadResource,
  peekResource,
  primeResource,
  useResource,
  type ResourceState,
} from "../../hooks/useResource";
import { agentMeta } from "../../lib/agents";
import { api, errorMessage } from "../../lib/api";
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
import { shouldPollUsage, type UsageSummary } from "../../lib/usage";

export interface ConfigWrite {
  saved: ManagerConfig;
  /** The previous values of exactly the fields that were changed, for undo. */
  previous: Partial<ManagerConfig>;
}

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
  /** Re-reads every cached resource; `force` asks the service to rescan first. */
  refresh: (force?: boolean) => Promise<void>;
  /** Applies a patch to the latest config. Writes are queued, never interleaved. */
  updateConfig: (patch: Partial<ManagerConfig>) => Promise<ConfigWrite>;
  savingConfig: boolean;
}

const DataContext = createContext<AppData | null>(null);

export const DATA_KEYS = {
  scan: "scan",
  config: "config",
  integrations: "integrations",
  capabilities: "capabilities",
  usage: "usage:summary:30",
};

const FORCED = [
  { key: DATA_KEYS.scan, label: "技能扫描", run: () => api.scan(true) },
  { key: DATA_KEYS.integrations, label: "插件与 MCP", run: () => api.integrations(true) },
  { key: DATA_KEYS.capabilities, label: "专家", run: () => api.capabilities(true) },
];

export function DataProvider({ children }: { children: ReactNode }) {
  const scan = useResource(DATA_KEYS.scan, () => api.scan());
  const config = useResource(DATA_KEYS.config, () => api.config());
  const integrations = useResource(DATA_KEYS.integrations, () => api.integrations());
  const capabilities = useResource(DATA_KEYS.capabilities, () => api.capabilities());
  const usage = useResource(DATA_KEYS.usage, () => api.usageSummary(30));
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [pendingWrites, setPendingWrites] = useState(0);

  // Keep usage-backed numbers growing while the first index is being built.
  usePolling(
    Boolean(usage.data && shouldPollUsage(usage.data.status, usage.data.index)),
    () => void loadResource(DATA_KEYS.usage, undefined, true),
    5_000,
  );

  const refresh = useCallback(async (force = false) => {
    if (!force) {
      await invalidateResources("");
      return;
    }
    const results = await Promise.allSettled(FORCED.map((item) => item.run()));
    const failures: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") primeResource(FORCED[index].key, result.value);
      else failures.push(`${FORCED[index].label}：${errorMessage(result.reason, "失败")}`);
    });
    const primed = new Set(FORCED.filter((_, index) => results[index].status === "fulfilled").map((item) => item.key));
    await invalidateResources(...cachedResourceKeys().filter((key) => !primed.has(key)));
    if (failures.length) throw new Error(`部分内容没有刷新。${failures.join("；")}`);
  }, []);

  const updateConfig = useCallback((patch: Partial<ManagerConfig>) => {
    setPendingWrites((count) => count + 1);
    const write = queue.current.catch(() => undefined).then(async (): Promise<ConfigWrite> => {
      const current = peekResource<ManagerConfig>(DATA_KEYS.config) || (await api.config());
      const previous = Object.fromEntries(
        Object.keys(patch).map((key) => [key, current[key as keyof ManagerConfig]]),
      ) as Partial<ManagerConfig>;
      const saved = await api.saveConfig({ ...current, ...patch });
      primeResource(DATA_KEYS.config, saved);
      void invalidateResources(DATA_KEYS.scan, "usage:", "health-report", "updates");
      return { saved, previous };
    });
    queue.current = write;
    return write.finally(() => setPendingWrites((count) => count - 1));
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
      updateConfig,
      savingConfig: pendingWrites > 0,
    };
  }, [scan, config, integrations, capabilities, usage, refresh, updateConfig, pendingWrites]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): AppData {
  const value = useContext(DataContext);
  if (!value) throw new Error("useData must be used inside DataProvider");
  return value;
}

