"use client";

import { usePersistent } from "../../hooks/usePersistent";
import { useScrollMemory } from "../../hooks/useScrollMemory";
import { errorMessage } from "../../lib/api";
import { baseName } from "../../lib/format";
import { mergePlugins, PLUGIN_SOURCE_NOTES, pluginInside, pluginState, type PluginView } from "../../lib/plugins";
import { persistentStore } from "../../lib/storage";
import { useData } from "../providers/DataProvider";
import { useNav } from "../providers/NavProvider";
import type { ChipSpec } from "../../lib/chips";
import { AgentAvatar, PluginLogo } from "../ui/Avatar";
import { ChipRow, ItemText } from "../ui/Item";
import { EmptyState, Loading, SectionHeading, Segmented, TopBar } from "../ui/basics";

export const pluginAgentStore = persistentStore<string>("plugins-agent", "codex", (value) => /^[a-z0-9._-]{1,64}$/i.test(value));

export function PluginCard({ plugin }: { plugin: PluginView }) {
  const { openDrawer } = useNav();
  const state = pluginState(plugin);
  const chips: ChipSpec[] = [...pluginInside(plugin)];
  if (plugin.scope === "local" || plugin.scope === "project") {
    chips.unshift({ id: "project", kind: "status", tone: "warn", text: `仅项目 ${baseName(plugin.projectPath) || "内"}` });
  }
  return (
    <button type="button" className="pcard card" data-detail-trigger="" onClick={() => openDrawer({ kind: "plugin", id: plugin.key })}>
      <div className="card-head">
        <PluginLogo plugin={plugin} />
        <ItemText
          title={plugin.displayName || plugin.name}
          meta={[plugin.developerName, plugin.category].filter(Boolean).join(" · ") || plugin.marketplace}
        />
        <span className={`tag card-status ${state.tone === "ok" ? "" : state.tone}`}>{state.label}</span>
      </div>
      <p className="card-desc">{plugin.shortDescription || plugin.longDescription || "没有介绍"}</p>
      <ChipRow className="card-foot" chips={chips} max={4} />
    </button>
  );
}

export function PluginsPage() {
  const { integrations, agentName, primary } = useData();
  const [agentChoice, setAgent] = usePersistent(pluginAgentStore);
  const scrollRef = useScrollMemory<HTMLDivElement>("plugins");
  const all = mergePlugins(integrations.data?.plugins || []);
  const counts = new Map<string, number>();
  for (const plugin of all) counts.set(plugin.agentId, (counts.get(plugin.agentId) || 0) + 1);
  const agentIds = [...counts.keys()].sort(
    (left, right) =>
      Number(primary.includes(right)) - Number(primary.includes(left)) ||
      primary.indexOf(left) - primary.indexOf(right) ||
      (counts.get(right) || 0) - (counts.get(left) || 0),
  );
  const agentId = agentIds.includes(agentChoice) ? agentChoice : agentIds[0] || agentChoice;
  const list = all.filter((plugin) => plugin.agentId === agentId);
  const enabled = list.filter((plugin) => plugin.enabled === true);
  const rest = list.filter((plugin) => plugin.enabled !== true);

  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar title={<span id="page-title">插件</span>} sub="插件把技能、连接器、MCP 打包在一起，由各 Agent 自己管理">
        {agentIds.length ? (
          <Segmented
            label="选择 Agent"
            value={agentId}
            onChange={setAgent}
            items={agentIds.map((id) => ({
              id,
              label: (
                <>
                  <AgentAvatar id={id} size="xs" />
                  {agentName(id)}
                </>
              ),
              count: all.filter((plugin) => plugin.agentId === id).length,
            }))}
          />
        ) : null}
      </TopBar>
      <div className="scroll" ref={scrollRef}>
        {integrations.status === "error" && !integrations.data ? (
          <EmptyState tone="error" title="读取插件失败">
            {errorMessage(integrations.error)}
          </EmptyState>
        ) : !integrations.data ? (
          <Loading label="正在读取插件…" rows={6} />
        ) : !list.length ? (
          <EmptyState title="没有找到插件">本机的 Agent 里还没有安装插件。</EmptyState>
        ) : (
          <>
            <SectionHeading title="已启用" note={`${enabled.length} 个`} />
            {enabled.length ? (
              <div className="pgrid">
                {enabled.map((plugin) => (
                  <PluginCard key={plugin.key} plugin={plugin} />
                ))}
              </div>
            ) : (
              <p className="muted small">没有确认启用的插件。</p>
            )}
            {rest.length ? (
              <>
                <SectionHeading
                  title={agentId === "codex" ? "已下载、未确认启用" : "已安装、未确认启用"}
                  note={`${rest.length} 个${agentId === "codex" ? " · 来自 Codex 的插件缓存" : ""}`}
                />
                <div className="pgrid">
                  {rest.map((plugin) => (
                    <PluginCard key={plugin.key} plugin={plugin} />
                  ))}
                </div>
              </>
            ) : null}
            <p className="footnote">{PLUGIN_SOURCE_NOTES[agentId] || "只读显示，安装和启用在对应的 Agent 里完成。"}</p>
          </>
        )}
      </div>
    </section>
  );
}
