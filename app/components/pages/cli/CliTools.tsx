"use client";

import { useMemo, useState } from "react";
import { usePersistent } from "../../../hooks/usePersistent";
import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import { OWNER_LABELS, type CliTool } from "../../../lib/cli-tools";
import type { SortFields, SortKey } from "../../../lib/sort";
import { persistentStore } from "../../../lib/storage";
import { SearchIcon } from "../../icons";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { EmptyState, Loading, Segmented } from "../../ui/basics";
import { SortControl, useSortedList } from "../../ui/SortControl";

export const CLI_KEY = "cli-tools";
export const loadCliTools = () => api.cliTools();

type Scope = "ai" | "all";
const scopeStore = persistentStore<Scope>("cli-scope", "ai", (value) => value === "ai" || value === "all");
const cliFields = (tool: CliTool): SortFields => ({ name: tool.name, uses: tool.referencedCount, installedAt: tool.mtime });
const CLI_SORTS: SortKey[] = ["uses", "installed", "name"];
const CLI_SORT_LABELS: Partial<Record<SortKey, string>> = { uses: "被技能引用最多", installed: "最近安装" };
const NO_TOOLS: CliTool[] = [];

/** "npm 全局包 · @larksuite/cli 1.0.97" */
export function ownerText(tool: CliTool): string | null {
  if (!tool.owner) return tool.binaries[0]?.version ? `版本 ${tool.binaries[0].version}` : null;
  const name = [tool.owner.name, tool.owner.version].filter(Boolean).join(" ");
  return [OWNER_LABELS[tool.owner.type], name].filter(Boolean).join(" · ");
}

function matches(tool: CliTool, query: string): boolean {
  if (!query) return true;
  const text = [tool.name, tool.description, tool.path, tool.owner?.name, ...tool.referencedBySkills].filter(Boolean).join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

/** Per-Agent availability as small avatars with a status dot. */
export function Availability({ tool }: { tool: CliTool }) {
  const { agentName } = useData();
  if (!tool.availability.length) return null;
  return (
    <span className="avail-row" aria-label={tool.availability.map((entry) => `${agentName(entry.agentId)}${entry.available === true ? "能用" : entry.available === false ? "找不到" : "未知"}`).join("，")}>
      {tool.availability.map((entry) => (
        <span
          key={entry.agentId}
          className={`avail ${entry.available === true ? "ok" : entry.available === false ? "bad" : "na"}`}
          title={`${agentName(entry.agentId)}：${entry.available === true ? "能用" : entry.available === false ? "找不到这个命令" : "不确定"}${entry.allowed === false ? "，没有放行规则（每次运行都要先问你）" : entry.allowed === true ? "，已放行" : ""}${entry.detail ? `（${entry.detail}）` : ""}`}
        >
          <AgentAvatar id={entry.agentId} size="xs" />
          <i aria-hidden="true" />
        </span>
      ))}
    </span>
  );
}

function ToolRow({ tool }: { tool: CliTool }) {
  const { openDrawer } = useNav();
  const owner = ownerText(tool);
  const second = [tool.description, tool.path].filter(Boolean);
  return (
    <button type="button" className="cli-row" data-detail-trigger="" data-memory-id={tool.id} onClick={() => openDrawer({ kind: "cli", id: tool.id })}>
      <span className="cli-main">
        <span className="cli-line1">
          <b className="mono clamp-1">{tool.name}</b>
          {owner ? <span className="cli-owner clamp-1">{owner}</span> : null}
          {tool.deep ? <span className="tag info">逐个 Agent 检查</span> : null}
        </span>
        {second.length ? (
          <span className="cli-line2 clamp-1" title={second.join(" · ")}>
            {tool.description ? <span>{tool.description}</span> : null}
            {tool.description && tool.path ? <span className="sep">·</span> : null}
            {tool.path ? <code>{tool.path}</code> : null}
          </span>
        ) : null}
      </span>
      <span className="cli-side">
        {tool.referencedCount ? <span className="tag">被 {tool.referencedCount} 个技能使用</span> : null}
        <Availability tool={tool} />
      </span>
    </button>
  );
}

/** 命令行工具: every tool detected on this Mac, AI-related ones first; a row opens its detail. */
export function CliTools() {
  const tools = useResource(CLI_KEY, loadCliTools);
  const [scope, setScope] = usePersistent(scopeStore);
  const [query, setQuery] = useState("");
  const all = tools.data?.tools || NO_TOOLS;
  const scoped = useMemo(() => (scope === "ai" ? all.filter((tool) => tool.aiRelated) : all), [all, scope]);
  const filtered = useMemo(() => scoped.filter((tool) => matches(tool, query.trim())), [scoped, query]);
  const { sorted, key, options, setKey } = useSortedList("cli-tools", filtered, cliFields, CLI_SORTS);
  if (isUnsupported(tools.error)) {
    return <EmptyState title="本地服务还没有提供命令行工具检查">更新 Skill Control 后可以看到本机的命令行工具在各 Agent 里能不能用。</EmptyState>;
  }
  if (tools.status === "error" && !tools.data) return <EmptyState tone="error" title="检查失败">{errorMessage(tools.error)}</EmptyState>;
  if (!tools.data) return <Loading label="正在检查命令行工具…" rows={5} />;
  const aiCount = tools.data.summary.aiRelated;
  return (
    <div className="stack">
      <div className="list-tools" role="toolbar" aria-label="筛选命令行工具">
        <label className="search">
          <SearchIcon />
          <input type="search" placeholder="搜索名称、介绍或路径" aria-label="搜索命令行工具" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <Segmented
          label="范围"
          value={scope}
          onChange={setScope}
          items={[
            { id: "ai", label: "AI 相关", count: aiCount },
            { id: "all", label: "全部", count: tools.data.summary.total },
          ]}
        />
        <SortControl value={key} options={options} onChange={setKey} labels={CLI_SORT_LABELS} />
      </div>
      {!all.length ? (
        <EmptyState title="没有找到命令行工具">在 ~/.local/bin、npm 全局目录、uv 工具目录和应用里都没有找到。</EmptyState>
      ) : !sorted.length ? (
        <EmptyState
          title={query ? `没有匹配“${query}”的工具` : "没有 AI 相关的命令行工具"}
          action={
            query ? (
              <button type="button" className="btn" onClick={() => setQuery("")}>
                清空搜索
              </button>
            ) : scope === "ai" ? (
              <button type="button" className="btn" onClick={() => setScope("all")}>
                显示全部 {all.length} 个
              </button>
            ) : null
          }
        />
      ) : (
        <div className="cli-list">
          {sorted.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>
      )}
      <p className="footnote">只读取文件信息、版本号和配置是否存在，不运行这些命令，也不读取任何密钥。点开一行查看各 Agent 能不能用，以及可以怎么修。</p>
    </div>
  );
}
