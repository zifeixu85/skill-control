"use client";

import { useState } from "react";
import { errorMessage } from "../../../lib/api";
import { mergePlugins } from "../../../lib/plugins";
import type { ScanAgent } from "../../../lib/types";
import { ConfigDetailView } from "../../files/ConfigDetailView";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { useToast } from "../../providers/ToastProvider";
import { ExpertCard } from "../ExpertsPage";
import { PluginCard } from "../PluginsPage";

const PROFILE_TITLES: Record<string, string> = {
  hermes: "Profile",
  openclaw: "Agent",
  qclaw: "Agent",
  workbuddy: "专家",
};

function SkillFolders({ agent }: { agent: ScanAgent }) {
  const { config, saveConfig, primary } = useData();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const scanned = agent.visible || primary.includes(agent.id);
  const startReading = async () => {
    if (!config.data) return;
    setSaving(true);
    try {
      await saveConfig({ ...config.data, visibleAgentIds: [...new Set([...config.data.visibleAgentIds, agent.id])] });
      toast.show(`开始读取 ${agent.name} 的技能`);
    } catch (error) {
      toast.show(errorMessage(error, "保存失败。"), { tone: "error" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="set-block" aria-labelledby="agent-folders">
      <h2 id="agent-folders">技能文件夹</h2>
      <p>
        {agent.installRoot ? (
          <>
            新技能会装到 <code>{agent.installRoot}</code>
            {agent.copyOnly ? "，只支持复制" : ""}。
          </>
        ) : (
          "Skill Control 从这些文件夹读取技能。"
        )}
        {agent.archivedCount ? ` 另有 ${agent.archivedCount} 个已归档的技能，只显示，不参与对比。` : ""}
      </p>
      <div className="copies">
        {agent.roots.length ? (
          agent.roots.map((root) => (
            <div key={root.path}>
              <code title={root.path}>
                {root.path}
                {root.realPath && root.realPath !== root.path ? ` → ${root.realPath}` : ""}
              </code>
              <em>{root.realPath && root.realPath !== root.path ? "软链接" : ""}</em>
              <em>{root.available ? `${root.skillCount} 个` : "不存在"}</em>
            </div>
          ))
        ) : (
          <p className="muted small">没有找到技能文件夹。</p>
        )}
      </div>
      {!scanned ? (
        <div className="inline-note">
          <span>还没有读取 {agent.name} 的技能内容，所以它不会出现在技能列表里。</span>
          <button type="button" className="btn sm" disabled={saving} onClick={startReading}>
            读取它的技能
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function AgentOverview({ agent }: { agent: ScanAgent }) {
  const { capabilities, integrations } = useData();
  const { go } = useNav();
  const profiles = (capabilities.data?.products || []).find((product) => product.id === agent.id)?.items || [];
  const plugins = mergePlugins(integrations.data?.plugins || []).filter((plugin) => plugin.agentId === agent.id);
  const mcp = (integrations.data?.mcpServers || []).filter((server) => server.agentId === agent.id);
  const shownProfiles = agent.id === "workbuddy" ? profiles.slice(0, 6) : profiles;
  return (
    <div className="set-grid wide">
      <section className="set-block" aria-labelledby="agent-config">
        <h2 id="agent-config">配置详情</h2>
        <p>从 {agent.name} 的配置文件里读出的关键设置，只读；密钥和令牌不会显示。</p>
        <ConfigDetailView kind="agent" id={agent.id} rowsTitle="" emptyText={`暂时读不了 ${agent.name} 的全局配置`} />
      </section>
      <SkillFolders agent={agent} />
      {shownProfiles.length ? (
        <section className="set-block" aria-labelledby="agent-profiles">
          <h2 id="agent-profiles">
            {PROFILE_TITLES[agent.id] || "Agent"} <em className="count-inline">{profiles.length}</em>
          </h2>
          <div className="pgrid">
            {shownProfiles.map((item) => (
              <ExpertCard key={item.id} capability={item} />
            ))}
          </div>
          {profiles.length > shownProfiles.length ? (
            <p>
              <button type="button" className="btn sm" onClick={() => go("experts")}>
                查看全部 {profiles.length} 个
              </button>
            </p>
          ) : null}
        </section>
      ) : null}
      {plugins.length ? (
        <section className="set-block" aria-labelledby="agent-plugins">
          <h2 id="agent-plugins">
            插件 <em className="count-inline">{plugins.length}</em>
          </h2>
          <div className="pgrid">
            {plugins.map((plugin) => (
              <PluginCard key={plugin.key} plugin={plugin} />
            ))}
          </div>
        </section>
      ) : null}
      {mcp.length ? (
        <section className="set-block" aria-labelledby="agent-mcp">
          <h2 id="agent-mcp">
            MCP 服务 <em className="count-inline">{mcp.length}</em>
          </h2>
          <div className="list-names">
            {mcp.map((server) => (
              <span key={server.id} className={server.likelySecretFields.length ? "warn" : ""}>
                {server.name}
                {server.scope === "project" ? " · 项目" : ""}
              </span>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
