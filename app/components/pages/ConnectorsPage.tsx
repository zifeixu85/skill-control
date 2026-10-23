"use client";

import type { KeyboardEvent } from "react";
import { useNow } from "../../hooks/useNow";
import { usePersistent } from "../../hooks/usePersistent";
import { useScrollMemory } from "../../hooks/useScrollMemory";
import { errorMessage } from "../../lib/api";
import { formatRelative } from "../../lib/format";
import { mergePlugins, pluginConnectors } from "../../lib/plugins";
import type { SortFields, SortKey } from "../../lib/sort";
import { persistentStore } from "../../lib/storage";
import type { Connector, McpMatrixRow, McpServer } from "../../lib/types";
import { useData } from "../providers/DataProvider";
import { useNav } from "../providers/NavProvider";
import { AgentAvatar, LetterLogo, PluginLogo } from "../ui/Avatar";
import { EmptyState, Loading, SectionHeading, Segmented, TopBar } from "../ui/basics";
import { ItemText, TagStack } from "../ui/Item";
import { SortControl, useSortedList } from "../ui/SortControl";
import { CliTools } from "./cli/CliTools";
import { SecretsView } from "./SecretsPage";
import { CONNECTORS_TABS, connectorsTabStore } from "../../lib/connectors-tab";

type View = "grid" | "list";
const VIEWS: { id: View; label: string }[] = [
  { id: "grid", label: "网格" },
  { id: "list", label: "列表" },
];
const isView = (value: string) => value === "grid" || value === "list";
const connectorsViewStore = persistentStore<View>("connectors-view", "grid", isView);
const mcpViewStore = persistentStore<View>("mcp-view", "grid", isView);

export { connectorsTabStore } from "../../lib/connectors-tab";

function useProvider(connector: Connector) {
  const { integrations } = useData();
  const plugins = mergePlugins(integrations.data?.plugins || []);
  return plugins.find((plugin) => pluginConnectors(plugin, [connector]).length > 0) || null;
}

function ConnectorTile({ connector }: { connector: Connector }) {
  const { openDrawer } = useNav();
  const provider = useProvider(connector);
  return (
    <button type="button" className="tile" data-detail-trigger="" onClick={() => openDrawer({ kind: "connector", id: connector.id })}>
      {provider ? <PluginLogo plugin={provider} /> : <LetterLogo text={connector.name} />}
      <span className="tile-text">
        <span className="tile-name" title={connector.name}>
          {connector.name}
        </span>
        <span className="tile-meta">{connector.toolCount} 个工具</span>
      </span>
    </button>
  );
}

function ConnectorRow({ connector }: { connector: Connector }) {
  const { openDrawer } = useNav();
  const provider = useProvider(connector);
  return (
    <button type="button" className="crow click" data-detail-trigger="" onClick={() => openDrawer({ kind: "connector", id: connector.id })}>
      {provider ? <PluginLogo plugin={provider} /> : <LetterLogo text={connector.name} />}
      <ItemText
        title={connector.name}
        meta={provider ? `由插件 ${provider.displayName || provider.name} 提供` : "Codex 内置"}
        desc={connector.description || null}
      />
      <div className="metric tools">
        <b>{connector.toolCount}</b>
        <small>个工具</small>
      </div>
    </button>
  );
}

interface McpItem {
  row: McpMatrixRow;
  servers: McpServer[];
  secret: boolean;
  project: boolean;
  disabled: boolean;
}

function mcpChips(item: McpItem) {
  return [
    ...(item.secret ? [{ id: "secret", kind: "status" as const, tone: "danger" as const, text: "明文密钥", title: "请求头或环境变量里写着密钥" }] : []),
    ...(item.disabled ? [{ id: "off", kind: "status" as const, tone: "mute" as const, text: "已停用" }] : []),
    ...(item.project ? [{ id: "project", kind: "kind" as const, text: "只在项目里" }] : []),
  ];
}

const mcpFields = (item: McpItem): SortFields => ({
  name: item.row.name,
  updatedAt: item.servers.map((server) => server.updatedAt || "").filter(Boolean).sort().pop() || null,
});
const MCP_SORTS: SortKey[] = ["updated", "name"];

function McpTile({ item }: { item: McpItem }) {
  const { openDrawer } = useNav();
  const { agentName } = useData();
  const transports = [...new Set(item.row.entries.map((entry) => entry.transport).filter(Boolean))];
  return (
    <button type="button" className="tile mcp-tile" data-detail-trigger="" onClick={() => openDrawer({ kind: "mcp", id: item.row.name })}>
      <LetterLogo text={item.row.name} />
      <span className="tile-text">
        <span className="tile-name mono" title={item.row.name}>
          {item.row.name}
        </span>
        <span className="tile-meta">
          <span className="avatar-row" aria-label={`配置在 ${item.row.agentIds.map(agentName).join("、")}`}>
            {item.row.agentIds.slice(0, 5).map((agentId) => (
              <AgentAvatar key={agentId} id={agentId} size="xs" />
            ))}
          </span>
          {transports.length ? <span>{transports.join(" / ")}</span> : null}
        </span>
        {item.secret || item.disabled || item.project ? <TagStack chips={mcpChips(item)} /> : null}
      </span>
    </button>
  );
}

function McpMatrix({ items }: { items: McpItem[] }) {
  const { agentName } = useData();
  const { openDrawer } = useNav();
  const agentIds = [...new Set(items.flatMap((item) => item.row.agentIds))];
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
            <th scope="col" className="th-tags">提醒</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.row.name} className="click" tabIndex={0} data-detail-trigger="" onClick={() => open(item.row.name)} onKeyDown={(event) => onKeyDown(event, item.row.name)}>
              <th scope="row" className="cell-main">
                <ItemText title={<span className="mono">{item.row.name}</span>} titleText={item.row.name} />
              </th>
              {agentIds.map((agentId) => {
                const on = item.row.agentIds.includes(agentId);
                return (
                  <td key={agentId}>
                    <span className={`dot ${on ? "" : "off"}`} role="img" aria-label={on ? `${agentName(agentId)} 已配置` : `${agentName(agentId)} 未配置`} />
                  </td>
                );
              })}
              <td className="cell-tags">
                <TagStack chips={mcpChips(item)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ViewToggle({ value, onChange, label }: { value: View; onChange: (view: View) => void; label: string }) {
  return <Segmented label={label} value={value} onChange={onChange} items={VIEWS} />;
}

const NO_ITEMS: McpItem[] = [];

function McpSection() {
  const { integrations } = useData();
  const [view, setView] = usePersistent(mcpViewStore);
  const matrix = integrations.data?.mcpMatrix || [];
  const servers = integrations.data?.mcpServers || [];
  const items: McpItem[] = matrix.length
    ? matrix.map((row) => {
        const own = servers.filter((server) => server.name === row.name);
        return {
          row,
          servers: own,
          secret: own.some((server) => server.likelySecretFields.length),
          project: row.entries.every((entry) => entry.scope === "project"),
          disabled: row.entries.length > 0 && row.entries.every((entry) => entry.enabled === false),
        };
      })
    : NO_ITEMS;
  const { sorted, key, options, setKey } = useSortedList("mcp", items, mcpFields, MCP_SORTS);
  return (
    <>
      <SectionHeading
        title="MCP 服务"
        note={`${matrix.length} 个 · 写在各 Agent 的配置文件里`}
        action={
          matrix.length ? (
            <span className="section-tools">
              <SortControl value={key} options={options} onChange={setKey} />
              <ViewToggle value={view} onChange={setView} label="MCP 服务的显示方式" />
            </span>
          ) : null
        }
      />
      {!matrix.length ? (
        <p className="muted small">没有找到 MCP 服务配置。</p>
      ) : view === "grid" ? (
        <div className="connector-grid">
          {sorted.map((item) => (
            <McpTile key={item.row.name} item={item} />
          ))}
        </div>
      ) : (
        <McpMatrix items={sorted} />
      )}
      <p className="footnote">点开任意一项查看各 Agent 里的配置原文。密钥在读取时就被隐藏，界面只显示字段名；保存位置见“密钥”标签。</p>
    </>
  );
}

export function ConnectorsPage() {
  const { integrations } = useData();
  const [tab, setTab] = usePersistent(connectorsTabStore);
  const [view, setView] = usePersistent(connectorsViewStore);
  const now = useNow();
  const scrollRef = useScrollMemory<HTMLDivElement>("connectors");
  const connectors = integrations.data?.connectors || [];
  const cachedAt = integrations.data?.sources.codex?.connectorsCachedAt;
  const tools = connectors.reduce((sum, connector) => sum + connector.toolCount, 0);
  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar
        title={<span id="page-title">连接器与 MCP</span>}
        sub={
          tab === "cli"
            ? "本机上 Agent 能调用的命令行工具：装在哪、谁装的、各 Agent 能不能用"
            : tab === "secrets"
              ? "连接器、MCP 和命令行工具用到的密钥存在哪里、谁在用；只显示名称和位置，从不读取或显示它的值"
              : "连接器是 Codex 通过账号接入的应用；MCP 服务写在各 Agent 的配置文件里"
        }
      >
        <Segmented label="显示内容" value={tab} onChange={setTab} items={CONNECTORS_TABS} />
      </TopBar>
      <div className="scroll" ref={scrollRef}>
        {tab === "cli" ? (
          <CliTools />
        ) : tab === "secrets" ? (
          <SecretsView />
        ) : integrations.status === "error" && !integrations.data ? (
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
              action={connectors.length ? <ViewToggle value={view} onChange={setView} label="连接器的显示方式" /> : null}
            />
            {connectors.length ? (
              view === "grid" ? (
                <div className="connector-grid">
                  {connectors.map((connector) => (
                    <ConnectorTile key={connector.id} connector={connector} />
                  ))}
                </div>
              ) : (
                <div className="clist">
                  {connectors.map((connector) => (
                    <ConnectorRow key={connector.id} connector={connector} />
                  ))}
                </div>
              )
            ) : (
              <p className="muted small">Codex 的连接器缓存里没有内容。</p>
            )}
            <p className="footnote">
              来自 Codex 本地缓存{cachedAt && now ? `（${formatRelative(cachedAt, now)}更新）` : ""}。点开查看提供方、工具和授权状态；连接和授权在 Codex 里管理。
            </p>
            <McpSection />
          </>
        )}
      </div>
    </section>
  );
}
