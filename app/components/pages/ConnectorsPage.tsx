"use client";

import type { KeyboardEvent } from "react";
import { useNow } from "../../hooks/useNow";
import { useScrollMemory } from "../../hooks/useScrollMemory";
import { errorMessage } from "../../lib/api";
import { formatRelative } from "../../lib/format";
import { mergePlugins } from "../../lib/plugins";
import type { Connector } from "../../lib/types";
import { useData } from "../providers/DataProvider";
import { useNav } from "../providers/NavProvider";
import { AgentAvatar, LetterLogo, PluginLogo } from "../ui/Avatar";
import { EmptyState, Loading, SectionHeading, TopBar } from "../ui/basics";

function ConnectorRow({ connector }: { connector: Connector }) {
  const { integrations } = useData();
  const plugins = mergePlugins(integrations.data?.plugins || []);
  const provider = plugins.find((plugin) =>
    connector.providedByPlugins.some((id) => id === plugin.id || id.split("@")[0] === plugin.name.toLowerCase()),
  );
  return (
    <div className="crow">
      {provider ? <PluginLogo plugin={provider} /> : <LetterLogo text={connector.name} />}
      <div className="crow-main">
        <b>{connector.name}</b>
        <span title={connector.description}>{connector.description}</span>
        <span className="muted">{provider ? `由插件 ${provider.displayName || provider.name} 提供` : "Codex 内置"}</span>
      </div>
      <div className="tools">
        <b>{connector.toolCount}</b>
        <span>个工具</span>
      </div>
    </div>
  );
}

function McpMatrix() {
  const { integrations, agentName } = useData();
  const { openDrawer } = useNav();
  const matrix = integrations.data?.mcpMatrix || [];
  const servers = integrations.data?.mcpServers || [];
  const agentIds = [...new Set(matrix.flatMap((row) => row.agentIds))];
  const open = (name: string) => openDrawer({ kind: "mcp", id: name });
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, name: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(name);
    }
  };
  return (
    <div className="matrix">
      <table>
        <caption className="sr-only">MCP 服务在各 Agent 中的配置情况</caption>
        <thead>
          <tr>
            <th scope="col">名称</th>
            {agentIds.map((agentId) => (
              <th scope="col" key={agentId}>
                <span className="th-agent">
                  <AgentAvatar id={agentId} size="xs" />
                  {agentName(agentId)}
                </span>
              </th>
            ))}
            <th scope="col">提醒</th>
          </tr>
        </thead>
        <tbody>
          {matrix.map((row) => {
            const own = servers.filter((server) => server.name === row.name);
            const secret = own.some((server) => server.likelySecretFields.length);
            const project = row.entries.every((entry) => entry.scope === "project");
            const disabled = row.entries.length > 0 && row.entries.every((entry) => entry.enabled === false);
            return (
              <tr key={row.name} className="click" tabIndex={0} onClick={() => open(row.name)} onKeyDown={(event) => onKeyDown(event, row.name)}>
                <th scope="row">{row.name}</th>
                {agentIds.map((agentId) => {
                  const on = row.agentIds.includes(agentId);
                  return (
                    <td key={agentId}>
                      <span className={`dot ${on ? "" : "off"}`} role="img" aria-label={on ? `${agentName(agentId)} 已配置` : `${agentName(agentId)} 未配置`} />
                    </td>
                  );
                })}
                <td>
                  {secret ? <span className="tag danger">请求头或环境变量里写着密钥</span> : null}
                  {project ? <span className="tag mute">只在项目里</span> : null}
                  {disabled ? <span className="tag mute">已停用</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ConnectorsPage() {
  const { integrations } = useData();
  const now = useNow();
  const scrollRef = useScrollMemory<HTMLDivElement>("connectors");
  const connectors = integrations.data?.connectors || [];
  const cachedAt = integrations.data?.sources.codex?.connectorsCachedAt;
  const tools = connectors.reduce((sum, connector) => sum + connector.toolCount, 0);
  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar title={<span id="page-title">连接器与 MCP</span>} sub="连接器是 Codex 通过账号接入的应用；MCP 服务写在各 Agent 的配置文件里" />
      <div className="scroll" ref={scrollRef}>
        {integrations.status === "error" && !integrations.data ? (
          <EmptyState tone="error" title="读取失败">
            {errorMessage(integrations.error)}
          </EmptyState>
        ) : !integrations.data ? (
          <Loading rows={6} />
        ) : (
          <>
            <SectionHeading
              title={
                <>
                  <AgentAvatar id="codex" size="xs" />
                  Codex 连接器
                </>
              }
              note={connectors.length ? `${connectors.length} 个可用 · 共 ${tools} 个工具` : "没有找到"}
            />
            {connectors.length ? (
              <div className="clist">
                {connectors.map((connector) => (
                  <ConnectorRow key={connector.id} connector={connector} />
                ))}
              </div>
            ) : (
              <p className="muted small">Codex 的连接器缓存里没有内容。</p>
            )}
            <p className="footnote">
              来自 Codex 本地缓存{cachedAt && now ? `（${formatRelative(cachedAt, now)}更新）` : ""}。连接和授权在 Codex 里管理。
            </p>
            <SectionHeading title="MCP 服务" note={`${integrations.data.mcpMatrix.length} 个 · 按 Agent 对照`} />
            {integrations.data.mcpMatrix.length ? <McpMatrix /> : <p className="muted small">没有找到 MCP 服务配置。</p>}
            <p className="footnote">点任意一行查看各 Agent 里的配置原文。密钥在读取时就被隐藏，界面只显示字段名。</p>
          </>
        )}
      </div>
    </section>
  );
}
