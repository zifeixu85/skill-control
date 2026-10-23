"use client";

import { useEffect, type ComponentType, type ReactNode, type SVGProps } from "react";
import { useAppUpdate } from "../../hooks/useAppUpdate";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePageMemory } from "../../hooks/usePageMemory";
import { appUpdateStore, hasNews } from "../../lib/app-update";
import { useNow } from "../../hooks/useNow";
import { formatRelative } from "../../lib/format";
import type { MainPage } from "../../lib/navigation";
import { mergePlugins } from "../../lib/plugins";
import { actionableCount } from "../../lib/updates";
import { agentsWithUpdates } from "../../lib/agent-versions";
import { AGENT_VERSIONS_KEY, loadAgentVersions } from "../pages/updates/AgentVersions";
import { useResource } from "../../hooks/useResource";
import { api } from "../../lib/api";
import {
  ChevronIcon,
  ConnectorsIcon,
  KeyIcon,
  UpdateIcon,
  LibraryIcon,
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

type NavItem = {
  id: MainPage;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  count?: number;
  /** Count shown as an attention badge rather than a plain total. */
  badge?: boolean;
  /** Indented under the item above (密钥 under 连接器与 MCP). */
  sub?: boolean;
};

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      {/* Same mark as the app icon: one library (green) shared with every Agent. */}
      <svg viewBox="0 0 16 16" fill="none">
        <path
          d="M5.8 8C8.4 8 8.9 3.9 11.4 3.9M5.8 8h5.6M5.8 8c2.6 0 3.1 4.1 5.6 4.1"
          stroke="#fff"
          strokeOpacity="0.55"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
        <circle cx="12.2" cy="3.9" r="1.45" fill="#f4f4f0" />
        <circle cx="12.2" cy="8" r="1.45" fill="#f4f4f0" />
        <circle cx="12.2" cy="12.1" r="1.45" fill="#f4f4f0" />
        <circle cx="4.6" cy="8" r="2.5" fill="#3cc48f" />
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
  const updates = useResource("updates", () => api.updates());
  const library = useResource("library", () => api.library());
  const agentVersions = useResource(AGENT_VERSIONS_KEY, loadAgentVersions);
  const pendingUpdates = actionableCount(updates.data) + agentsWithUpdates(agentVersions.data).length;
  const { route, go } = useNav();
  const plugins = mergePlugins(integrations.data?.plugins || []);
  // Grouped so later sections (统一技能库、更新) slot into "管理" without reshuffling.
  const manage: NavItem[] = [
    { id: "home", label: "概览", Icon: HomeIcon },
    { id: "skills", label: "技能", Icon: SkillsIcon, count: views.length || undefined },
    { id: "library", label: "技能库", Icon: LibraryIcon, count: library.data?.issues.length || undefined, badge: true },
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
    { id: "secrets", label: "密钥", Icon: KeyIcon, sub: true },
    { id: "updates", label: "更新", Icon: UpdateIcon, count: pendingUpdates || undefined, badge: true },
  ];
  const insight: NavItem[] = [
    { id: "usage", label: "数据", Icon: UsageIcon },
    { id: "health", label: "体检", Icon: HealthIcon },
  ];
  const others = agents
    .filter((agent) => agent.available && (agent.skillCount > 0 || agent.isNew) && !primary.includes(agent.id))
    .sort(
      (left, right) =>
        Number(Boolean(right.isNew)) - Number(Boolean(left.isNew)) ||
        (activityById.get(right.id)?.weight30d || 0) - (activityById.get(left.id)?.weight30d || 0) ||
        right.skillCount - left.skillCount,
    );
  // 模型价格表 lives under 数据.
  const current = (id: string) => route.page === id || (id === "usage" && route.page === "pricing");
  const navButton = ({ id, label, Icon, count, badge, sub }: NavItem) => (
    <button
      key={id}
      type="button"
      className={`${current(id) ? "on" : ""} ${sub ? "sub" : ""}`}
      aria-current={current(id) ? "page" : undefined}
      aria-label={count ? `${label}，${count} 个${badge ? "待处理" : ""}` : label}
      title={label}
      onClick={() => go(id)}
    >
      <Icon />
      <span>{label}</span>
      {count ? <span className={badge ? "count badge" : "count"}>{count}</span> : null}
    </button>
  );
  const agentButton = (id: string, name: string, count: number, dim: boolean, isNew = false) => (
    <button
      key={id}
      type="button"
      className={`agent-item ${dim ? "dim" : ""} ${route.page === "agent" && route.agentId === id ? "on" : ""}`}
      aria-current={route.page === "agent" && route.agentId === id ? "page" : undefined}
      aria-label={isNew ? `${name}（新发现）` : name}
      title={name}
      onClick={() => go("agent", { agentId: id })}
    >
      <AgentAvatar id={id} />
      <span className="nm">{name}</span>
      {isNew ? <span className="new-mark">新</span> : <span className="n">{count}</span>}
    </button>
  );
  const lists = (
    <>
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
          <div className="agent-list">{others.map((agent) => agentButton(agent.id, agent.name, agent.skillCount, true, agent.isNew === true))}</div>
        </>
      ) : null}
    </>
  );

  return (
    <aside className="side" aria-label="侧栏">
      <div className="side-top">
        <div className="brand">
          <BrandMark />
          <b>Skill Control</b>
        </div>
        <nav className="nav" aria-label="主导航">
          {manage.map(navButton)}
          <span className="nav-sep" aria-hidden="true" />
          {insight.map(navButton)}
        </nav>
      </div>
      <AgentLists newCount={others.filter((agent) => agent.isNew).length}>{lists}</AgentLists>
      <div className="side-foot">
        <AppUpdateHint />
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

/**
 * The only scrolling part of the sidebar. In short windows (< 600 high) the lists fold behind
 * an "Agent" disclosure so the main nav and 设置 stay reachable.
 */
function AgentLists({ children, newCount }: { children: ReactNode; newCount: number }) {
  const short = useMediaQuery("(max-height: 599px)");
  const [open, setOpen] = usePageMemory<boolean>("side:agents-open", false);
  if (!short) return <div className="side-mid">{children}</div>;
  return (
    <div className={`side-mid folded ${open ? "open" : ""}`}>
      <button type="button" className="side-disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronIcon className="chev" aria-hidden="true" />
        <span>Agent</span>
        {newCount ? <span className="new-mark">新</span> : null}
      </button>
      {open ? children : null}
    </div>
  );
}

/** A quiet line above 设置 when a newer Skill Control is out. Reads state only, never checks. */
function AppUpdateHint() {
  const state = useAppUpdate();
  const { go } = useNav();
  useEffect(() => {
    void appUpdateStore.start();
  }, []);
  if (!hasNews(state)) return null;
  return (
    <button type="button" className="app-update-hint" onClick={() => go("settings", { section: "about" })} title="查看新版本">
      <i aria-hidden="true" />
      <span>{state.status === "ready" ? `新版本 ${state.latest || ""} 已下载，重启即可` : `有新版本 ${state.latest || ""}`}</span>
    </button>
  );
}
