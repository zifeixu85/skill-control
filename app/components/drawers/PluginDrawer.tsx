"use client";

import { useState } from "react";
import { componentsOf, pluginConnectors, pluginDetailId, pluginState } from "../../lib/plugins";
import { baseName, formatMonthDay } from "../../lib/format";
import type { Plugin } from "../../lib/types";
import { ConfigDetailView } from "../files/ConfigDetailView";
import { useData } from "../providers/DataProvider";
import { LetterLogo, PluginLogo } from "../ui/Avatar";
import { Tabs } from "../ui/basics";
import { Drawer } from "./Drawer";

type Tab = "overview" | "config";

function NameList({ title, names }: { title: string; names: string[] }) {
  if (!names.length) return null;
  return (
    <section>
      <h3>{title}</h3>
      <div className="list-names">
        {names.slice(0, 60).map((name) => (
          <span key={name}>{baseName(name)}</span>
        ))}
        {names.length > 60 ? <span>另有 {names.length - 60} 个</span> : null}
      </div>
    </section>
  );
}

function Overview({ plugin, variants }: { plugin: Plugin; variants: Plugin[] }) {
  const { integrations, agentName } = useData();
  const state = pluginState(plugin);
  const connectors = pluginConnectors(plugin, integrations.data?.connectors || []);
  const components = componentsOf(plugin);
  return (
    <>
      <p className="desc">{plugin.longDescription || plugin.shortDescription || "没有介绍"}</p>
      <div className="inside">
        <span className={`tag ${state.tone === "ok" ? "" : state.tone}`}>{state.label}</span>
        {plugin.version && plugin.version !== "unknown" ? <span className="tag mute">v{plugin.version}</span> : null}
        {plugin.scope && plugin.scope !== "user" ? <span className="tag warn">作用域：{plugin.scope}</span> : null}
      </div>
      <NameList title={`包含 ${components.skills.length} 个技能`} names={components.skills} />
      {connectors.length ? (
        <section>
          <h3>连接器</h3>
          <div className="clist">
            {connectors.map((connector) => (
              <div className="crow" key={connector.id}>
                <LetterLogo text={connector.name} />
                <div className="crow-main">
                  <b>{connector.name}</b>
                  <span>{connector.description}</span>
                </div>
                <div className="tools">
                  <b>{connector.toolCount}</b>
                  <span>个工具</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : components.apps.length ? (
        <section>
          <h3>连接器</h3>
          <p className="muted small">还没在 {agentName(plugin.agentId)} 里连接。</p>
        </section>
      ) : null}
      <NameList title="MCP 服务" names={components.mcpServers.map((server) => server.name)} />
      <NameList title="子代理" names={components.agents} />
      <NameList title="命令" names={components.commands} />
      <NameList title="频道" names={components.channels} />
      {components.hooks ? <p className="muted small">这个插件带有 Hook，会在 Agent 的特定时机自动运行。</p> : null}
      <section>
        <h3>来源</h3>
        <div className="copies">
          <div>
            <code>{plugin.id}</code>
            <em>{plugin.marketplace}</em>
            <em>{plugin.lastUpdated ? formatMonthDay(plugin.lastUpdated) : ""}</em>
          </div>
          {plugin.projectPath ? (
            <div>
              <code>{plugin.projectPath}</code>
              <em>只在这个项目里</em>
              <em />
            </div>
          ) : null}
          {variants.length > 1 ? (
            <div>
              <code>另有 {variants.length - 1} 个版本或作用域</code>
              <em />
              <em />
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}

export function PluginDrawer({ pluginKey, onClose }: { pluginKey: string; onClose: () => void }) {
  const { integrations, agentName } = useData();
  const [tab, setTab] = useState<Tab>("overview");
  const plugins = integrations.data?.plugins || [];
  const plugin = plugins.find((item) => item.key === pluginKey);
  if (!plugin) return null;
  const variants = plugins.filter((item) => item.agentId === plugin.agentId && item.name === plugin.name);
  return (
    <Drawer
      label={`${plugin.displayName || plugin.name} 插件`}
      icon={<PluginLogo plugin={plugin} size="lg" />}
      title={plugin.displayName || plugin.name}
      subtitle={`${agentName(plugin.agentId)} · ${plugin.id}`}
      onClose={onClose}
      wide={tab === "config"}
      tabs={
        <Tabs
          tabs={[
            { id: "overview", label: "概览" },
            { id: "config", label: "配置详情" },
          ]}
          value={tab}
          onChange={setTab}
          label="插件详情"
        />
      }
    >
      <div role="tabpanel" className="insp-body">
        {tab === "overview" ? (
          <Overview plugin={plugin} variants={variants} />
        ) : (
          <ConfigDetailView kind="plugin" id={pluginDetailId(plugin)} filesTitle="清单与声明的配置文件" />
        )}
      </div>
    </Drawer>
  );
}
