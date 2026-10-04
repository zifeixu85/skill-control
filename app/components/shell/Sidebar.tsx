"use client";

import type { ComponentType, SVGProps } from "react";
import { useNow } from "../../hooks/useNow";
import { formatRelative } from "../../lib/format";
import type { MainPage } from "../../lib/navigation";
import { mergePlugins } from "../../lib/plugins";
import {
  ConnectorsIcon,
  ExpertsIcon,
  HealthIcon,
  HomeIcon,
  PluginsIcon,
  SettingsIcon,
  SkillsIcon,
  UsageIcon,
} from "../icons";
import { useData } from "../providers/DataProvider";
import { useNav } from "../providers/NavProvider";
import { AgentAvatar } from "../ui/Avatar";

type NavItem = { id: MainPage; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>>; count?: number };

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none">
        <path d="M3 4.5h6M3 8h10M3 11.5h7" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="12" cy="4.5" r="1.6" fill="#3cc48f" />
      </svg>
    </span>
  );
}

function ScanState() {
  const { scan } = useData();
  const now = useNow();
  const label =
    scan.status === "error"
      ? "扫描失败"
      : !scan.data || scan.refreshing
        ? "扫描中…"
        : now
          ? `${formatRelative(scan.data.scannedAt, now)}扫描完成`
          : "扫描完成";
  return (
    <div className={`scan-state ${scan.status === "error" ? "bad" : !scan.data || scan.refreshing ? "busy" : ""}`}>
      <i aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Sidebar() {
  const { views, integrations, capabilities, primary, agents, activityById } = useData();
  const { route, go } = useNav();
  const plugins = mergePlugins(integrations.data?.plugins || []);
  // Grouped so later sections (统一技能库、更新) slot into "管理" without reshuffling.
  const manage: NavItem[] = [
    { id: "home", label: "概览", Icon: HomeIcon },
    { id: "skills", label: "技能", Icon: SkillsIcon, count: views.length || undefined },
    { id: "plugins", label: "插件", Icon: PluginsIcon, count: plugins.length || undefined },
    {
      id: "experts",
      label: "专家与 Agent",
      Icon: ExpertsIcon,
      count: capabilities.data?.products.reduce((sum, product) => sum + product.items.length, 0) || undefined,
    },
    {
      id: "connectors",
      label: "连接器与 MCP",
      Icon: ConnectorsIcon,
      count: (integrations.data?.connectors.length || 0) + (integrations.data?.mcpMatrix.length || 0) || undefined,
    },
  ];
  const insight: NavItem[] = [
    { id: "usage", label: "数据", Icon: UsageIcon },
    { id: "health", label: "体检", Icon: HealthIcon },
  ];
  const others = agents
    .filter((agent) => agent.available && agent.skillCount > 0 && !primary.includes(agent.id))
    .sort(
      (left, right) =>
        (activityById.get(right.id)?.weight30d || 0) - (activityById.get(left.id)?.weight30d || 0) ||
        right.skillCount - left.skillCount,
    );
  const navButton = ({ id, label, Icon, count }: NavItem) => (
    <button
      key={id}
      type="button"
      className={route.page === id ? "on" : ""}
      aria-current={route.page === id ? "page" : undefined}
      aria-label={count ? `${label}，${count} 个` : label}
      title={label}
      onClick={() => go(id)}
    >
      <Icon />
      <span>{label}</span>
      {count ? <span className="count">{count}</span> : null}
    </button>
  );
  const agentButton = (id: string, name: string, count: number, dim: boolean) => (
    <button
      key={id}
      type="button"
      className={`agent-item ${dim ? "dim" : ""} ${route.page === "agent" && route.agentId === id ? "on" : ""}`}
      aria-current={route.page === "agent" && route.agentId === id ? "page" : undefined}
      onClick={() => go("agent", { agentId: id })}
    >
      <AgentAvatar id={id} />
      <span className="nm">{name}</span>
      <span className="n">{count}</span>
    </button>
  );

  return (
    <aside className="side" aria-label="侧栏">
      <div className="brand">
        <BrandMark />
        <b>Skill Control</b>
      </div>
      <nav className="nav" aria-label="主导航">
        {manage.map(navButton)}
        <span className="nav-sep" aria-hidden="true" />
        {insight.map(navButton)}
      </nav>
      {primary.length ? (
        <>
          <p className="side-label">常用 Agent</p>
          <div className="agent-list">
            {primary.map((id) => {
              const agent = agents.find((item) => item.id === id);
              return agentButton(id, agent?.name || id, agent?.skillCount || 0, false);
            })}
          </div>
        </>
      ) : null}
      {others.length ? (
        <>
          <p className="side-label">其他已安装</p>
          <div className="agent-list">{others.map((agent) => agentButton(agent.id, agent.name, agent.skillCount, true))}</div>
        </>
      ) : null}
      <div className="side-foot">
        <nav className="nav" aria-label="设置">
          <button
            type="button"
            className={route.page === "settings" ? "on" : ""}
            aria-current={route.page === "settings" ? "page" : undefined}
            title="设置"
            onClick={() => go("settings")}
          >
            <SettingsIcon />
            <span>设置</span>
          </button>
        </nav>
        <ScanState />
      </div>
    </aside>
  );
}
