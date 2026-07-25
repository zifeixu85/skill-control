"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const DEFAULT_API_BASE = "http://127.0.0.1:43110";
const API_BASE =
  typeof window !== "undefined"
    ? (
        window as Window & {
          skillManagerDesktop?: { apiBase?: string };
        }
      ).skillManagerDesktop?.apiBase || DEFAULT_API_BASE
    : DEFAULT_API_BASE;
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function useModalFocus<T extends HTMLElement>() {
  const dialogRef = useRef<T>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const getFocusableElements = () =>
      [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) =>
          !element.hasAttribute("disabled") &&
          element.getAttribute("aria-hidden") !== "true" &&
          element.tabIndex >= 0 &&
          window.getComputedStyle(element).visibility !== "hidden",
      );
    const focusFrame = window.requestAnimationFrame(() => {
      (getFocusableElements()[0] || dialog).focus();
    });

    function keepFocusInside(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements();
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", keepFocusInside, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", keepFocusInside, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return dialogRef;
}

type SkillStatus = "synced" | "partial" | "single" | "conflict";
type ViewName = "skills" | "sync" | "sources";

type AgentRoot = {
  configuredPath: string;
  path: string;
  available: boolean;
  skillCount: number;
};

type Agent = {
  id: string;
  name: string;
  shortName: string;
  color: string;
  paths: string[];
  roots: AgentRoot[];
  available: boolean;
  visible: boolean;
  installationCount: number;
  skillCount: number;
};

type SkillInstance = {
  id: string;
  agentId: string;
  agentName: string;
  root: string;
  path: string;
  directoryName: string;
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  excerpt: string;
  hash: string;
  shortHash: string;
  fileCount: number;
  byteCount: number;
  modifiedAt: string | null;
  isSymlink: boolean;
  linkTarget: string | null;
  truncated: boolean;
};

type Skill = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  excerpt: string;
  status: SkillStatus;
  conflict: boolean;
  coverage: number;
  installedAgentIds: string[];
  missingAgentIds: string[];
  hashes: string[];
  modifiedAt: string | null;
  fileCount: number;
  instances: SkillInstance[];
};

type SkillFileEntry = {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modifiedAt: string;
  language: string | null;
  linkTarget: string | null;
};

type SkillFileListing = {
  entries: SkillFileEntry[];
  fileCount: number;
  directoryCount: number;
  truncated: boolean;
  instance: {
    id: string;
    agentId: string;
    agentName: string;
    path: string;
    shortHash: string;
  };
};

type SkillFileContent = {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  language: string;
  content: string | null;
  previewable: boolean;
  reason: string | null;
};

type HistoryEntry = {
  id: string;
  type: string;
  skillName: string;
  mode: "copy" | "symlink";
  targets: string[];
  backups: number;
  createdAt: string;
};

type ScanData = {
  agents: Agent[];
  skills: Skill[];
  totals: {
    uniqueSkills: number;
    installations: number;
    synced: number;
    conflicts: number;
    incomplete: number;
    coverage: number;
  };
  history: HistoryEntry[];
  scannedAt: string;
};

type AgentConfig = {
  id: string;
  name: string;
  shortName: string;
  color: string;
  paths: string[];
};

type ManagerConfig = {
  version: number;
  syncMode: "copy" | "symlink";
  agents: AgentConfig[];
  visibleAgentIds: string[];
};

type SyncAction = {
  agentId: string;
  agentName: string;
  action: "noop" | "replace" | "create";
  mode: "copy" | "symlink";
  source: string;
  destination: string;
  backup: string | null;
  sourceHash: string;
  targetHash: string | null;
  identical: boolean;
  result?: "skipped" | "completed";
};

type SyncPlan = {
  skillId: string;
  skillName: string;
  sourceInstanceId: string;
  sourceAgentId: string;
  mode: "copy" | "symlink";
  actions: SyncAction[];
};

type ImportedSkill = {
  importId: string;
  originalFilename: string;
  directoryName: string;
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  fileCount: number;
  directoryCount: number;
  byteCount: number;
  shortHash: string;
  entries: SkillFileEntry[];
};

type ImportInstallPlan = {
  importId: string;
  skillName: string;
  displayName: string;
  actions: SyncAction[];
};

const STATUS_COPY: Record<
  SkillStatus,
  { label: string; detail: string; symbol: string }
> = {
  synced: { label: "已对齐", detail: "各端内容一致", symbol: "●" },
  partial: { label: "待补齐", detail: "部分工具未安装", symbol: "◐" },
  single: { label: "单端", detail: "仅一个工具安装", symbol: "◔" },
  conflict: { label: "有冲突", detail: "同名内容不一致", symbol: "!" },
};

async function requestJson<T>(
  pathname: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options?.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "本地服务暂时不可用。");
  }
  return payload;
}

function formatRelativeDate(value: string | null) {
  if (!value) return "未知";
  const difference = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(difference / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function statusTone(status: SkillStatus) {
  return `status-${status}`;
}

function displaySkillName(skill: Pick<Skill, "name" | "displayName">) {
  return skill.displayName || skill.name;
}

function isMarkdownPath(pathname: string) {
  return /\.(md|markdown)$/i.test(pathname);
}

function markdownDocumentBody(content: string) {
  return content.replace(
    /^---\s*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/,
    "",
  );
}

function MarkdownDocument({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children }) => {
          if (!href || !/^https:\/\//i.test(href)) {
            return <span>{children}</span>;
          }
          return (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        },
        img: ({ alt }) => (
          <span className="markdown-image-placeholder">
            图片未自动加载{alt ? `：${alt}` : ""}
          </span>
        ),
      }}
    >
      {markdownDocumentBody(content)}
    </Markdown>
  );
}

function missingAgentCount(skill: Skill, agents: Agent[]) {
  const availableIds = new Set(agents.map((agent) => agent.id));
  return skill.missingAgentIds.filter((agentId) => availableIds.has(agentId))
    .length;
}

function AgentMark({
  agent,
  active,
  conflict,
  compact = false,
}: {
  agent: Agent;
  active: boolean;
  conflict?: boolean;
  compact?: boolean;
}) {
  return (
    <span
      className={`agent-mark ${active ? "is-active" : ""} ${
        conflict && active ? "is-conflict" : ""
      } ${compact ? "is-compact" : ""}`}
      style={{ "--agent-color": agent.color } as React.CSSProperties}
      title={`${agent.name}：${active ? (conflict ? "内容有差异" : "已安装") : "未安装"}`}
      aria-label={`${agent.name}${active ? "已安装" : "未安装"}`}
    >
      {active ? agent.shortName : "—"}
    </span>
  );
}

function AgentDock({
  agents,
  activeAgentId,
  totalSkills,
  onChange,
  onManage,
}: {
  agents: Agent[];
  activeAgentId: string;
  totalSkills: number;
  onChange: (agentId: string) => void;
  onManage: () => void;
}) {
  return (
    <section className="agent-dock" aria-label="按工具切换技能">
      <div className="agent-dock-label">
        <span>工具切换</span>
        <small>按本机产品切换</small>
      </div>
      <div className="agent-dock-scroll">
        <button
          className={`agent-dock-item agent-dock-all ${
            activeAgentId === "all" ? "is-active" : ""
          }`}
          aria-pressed={activeAgentId === "all"}
          onClick={() => onChange("all")}
        >
          <span className="dock-monogram">全</span>
          <span>
            <strong>全部</strong>
            <small>跨工具汇总</small>
          </span>
          <b>{totalSkills}</b>
        </button>
        {agents.map((agent) => (
          <button
            key={agent.id}
            className={`agent-dock-item ${
              activeAgentId === agent.id ? "is-active" : ""
            }`}
            style={{ "--agent-color": agent.color } as React.CSSProperties}
            aria-pressed={activeAgentId === agent.id}
            onClick={() => onChange(agent.id)}
          >
            <span className="dock-monogram">{agent.shortName}</span>
            <span>
              <strong>{agent.name}</strong>
              <small>{agent.roots.filter((root) => root.available).length} 个目录</small>
            </span>
            <b>{agent.skillCount}</b>
          </button>
        ))}
      </div>
      <button
        className="dock-more-button"
        onClick={onManage}
        title="接入更多工具"
      >
        <strong>+{Math.max(0, 14 - agents.length)}</strong>
        <small>更多工具</small>
      </button>
    </section>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-glyph">∅</div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

function SkillTable({
  skills,
  agents,
  onSelect,
  onSync,
}: {
  skills: Skill[];
  agents: Agent[];
  onSelect: (skill: Skill) => void;
  onSync: (skill: Skill) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(60);

  if (!skills.length) {
    return (
      <EmptyState
        title="没有匹配的技能"
        description="试试清空搜索词，或切换状态筛选。"
      />
    );
  }

  const visibleSkills = skills.slice(0, visibleCount);
  const remainingCount = Math.max(0, skills.length - visibleSkills.length);

  return (
    <div className="skill-table-wrap">
      <table className="skill-table">
        <thead>
          <tr>
            <th className="skill-name-column">技能 / 描述</th>
            <th>安装覆盖</th>
            <th>状态</th>
            <th>最近变化</th>
            <th>
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visibleSkills.map((skill, index) => (
            <tr
              key={skill.id}
              onClick={() => onSelect(skill)}
              className="skill-row"
              style={{ "--row-index": index } as React.CSSProperties}
            >
              <td>
                <div className="skill-identity">
                  <span className={`skill-index ${statusTone(skill.status)}`}>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <strong>{displaySkillName(skill)}</strong>
                    {skill.displayName !== skill.name && (
                      <code className="technical-name">{skill.name}</code>
                    )}
                    <p>{skill.description}</p>
                  </div>
                </div>
              </td>
              <td>
                <div className="coverage-cell">
                  <div className="agent-marks">
                    {agents.map((agent) => (
                      <AgentMark
                        key={agent.id}
                        agent={agent}
                        active={skill.installedAgentIds.includes(agent.id)}
                        conflict={skill.conflict}
                        compact
                      />
                    ))}
                  </div>
                  <small>
                    {
                      skill.installedAgentIds.filter((agentId) =>
                        agents.some((agent) => agent.id === agentId),
                      ).length
                    }
                    /{agents.length}
                  </small>
                </div>
              </td>
              <td>
                <span className={`status-pill ${statusTone(skill.status)}`}>
                  <span aria-hidden>{STATUS_COPY[skill.status].symbol}</span>
                  {STATUS_COPY[skill.status].label}
                </span>
              </td>
              <td>
                <span className="date-cell">
                  {formatRelativeDate(skill.modifiedAt)}
                </span>
              </td>
              <td className="row-action-cell">
                <button
                  className={`row-action ${
                    missingAgentCount(skill, agents) || skill.conflict
                      ? "is-primary"
                      : ""
                  }`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (missingAgentCount(skill, agents) || skill.conflict) {
                      onSync(skill);
                    } else {
                      onSelect(skill);
                    }
                  }}
                >
                  {missingAgentCount(skill, agents)
                    ? `补齐 ${missingAgentCount(skill, agents)}`
                    : skill.conflict
                      ? "处理冲突"
                      : "查看"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {remainingCount > 0 && (
        <div className="skill-table-more">
          <span>
            当前显示 {visibleSkills.length} / {skills.length}
          </span>
          <button
            type="button"
            onClick={() =>
              setVisibleCount((current) => Math.min(current + 60, skills.length))
            }
          >
            再显示 {Math.min(60, remainingCount)} 个
          </button>
        </div>
      )}
    </div>
  );
}

function DetailPanel({
  skill,
  agents,
  onClose,
  onSync,
  onReveal,
  onExport,
}: {
  skill: Skill;
  agents: Agent[];
  onClose: () => void;
  onSync: () => void;
  onReveal: (instanceId: string) => void;
  onExport: (instanceId: string) => void;
}) {
  const dialogRef = useModalFocus<HTMLElement>();
  const instancesByAgent = new Map(
    skill.instances.map((instance) => [instance.agentId, instance]),
  );
  const [activeInstanceId, setActiveInstanceId] = useState(
    skill.instances[0]?.id || "",
  );
  const [fileListing, setFileListing] = useState<SkillFileListing | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [fileContent, setFileContent] = useState<SkillFileContent | null>(null);
  const [listingLoading, setListingLoading] = useState(
    Boolean(skill.instances[0]),
  );
  const [contentLoading, setContentLoading] = useState(false);
  const [browserError, setBrowserError] = useState("");
  const [detailTab, setDetailTab] = useState<"files" | "installations">(
    "files",
  );
  const [previewMode, setPreviewMode] = useState<"rendered" | "source">(
    "rendered",
  );
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(
    new Set(),
  );

  const visibleFileEntries = useMemo(() => {
    if (!fileListing) return [];
    return fileListing.entries.filter((entry) => {
      const pathParts = entry.path.split("/");
      const parentParts = pathParts.slice(0, -1);
      let parentPath = "";
      return parentParts.every((part) => {
        parentPath = parentPath ? `${parentPath}/${part}` : part;
        return !collapsedDirectories.has(parentPath);
      });
    });
  }, [collapsedDirectories, fileListing]);

  useEffect(() => {
    if (!activeInstanceId) return;
    let cancelled = false;
    requestJson<SkillFileListing>(
      `/api/skill-files?instanceId=${encodeURIComponent(activeInstanceId)}`,
    )
      .then((listing) => {
        if (cancelled) return;
        setFileListing(listing);
        setBrowserError("");
        const readableEntries = listing.entries.filter(
          (entry) => entry.type !== "directory",
        );
        const defaultPath =
          readableEntries.find(
            (entry) => entry.path.toLowerCase() === "skill.md",
          )?.path ||
          readableEntries[0]?.path ||
          "";
        setSelectedFilePath(defaultPath);
        setPreviewMode(isMarkdownPath(defaultPath) ? "rendered" : "source");
        setCollapsedDirectories(
          new Set(
            listing.entries
              .filter((entry) => entry.type === "directory")
              .map((entry) => entry.path),
          ),
        );
        setContentLoading(Boolean(defaultPath));
      })
      .catch((error) => {
        if (!cancelled) setBrowserError(error.message);
      })
      .finally(() => {
        if (!cancelled) setListingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeInstanceId]);

  useEffect(() => {
    if (!activeInstanceId || !selectedFilePath) return;
    let cancelled = false;
    requestJson<SkillFileContent>(
      `/api/skill-file?instanceId=${encodeURIComponent(activeInstanceId)}&path=${encodeURIComponent(selectedFilePath)}`,
    )
      .then((content) => {
        if (!cancelled) setFileContent(content);
      })
      .catch((error) => {
        if (!cancelled) {
          setFileContent(null);
          setBrowserError(error.message);
        }
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeInstanceId, selectedFilePath]);

  function selectInstance(instanceId: string) {
    if (instanceId === activeInstanceId) return;
    setActiveInstanceId(instanceId);
    setFileListing(null);
    setSelectedFilePath("");
    setFileContent(null);
    setBrowserError("");
    setListingLoading(true);
    setContentLoading(false);
    setPreviewMode("rendered");
    setCollapsedDirectories(new Set());
  }

  function selectFile(filePath: string) {
    if (filePath === selectedFilePath) return;
    setSelectedFilePath(filePath);
    setFileContent(null);
    setBrowserError("");
    setContentLoading(true);
    setPreviewMode(isMarkdownPath(filePath) ? "rendered" : "source");
  }

  function toggleDirectory(directoryPath: string) {
    setCollapsedDirectories((current) => {
      const next = new Set(current);
      if (next.has(directoryPath)) {
        next.delete(directoryPath);
      } else {
        next.add(directoryPath);
      }
      return next;
    });
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <aside
        ref={dialogRef}
        className="detail-panel"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${displaySkillName(skill)} 详情`}
        tabIndex={-1}
      >
        <div className="panel-topline">
          <span>技能详情</span>
          <button className="icon-button" onClick={onClose} aria-label="关闭详情">
            ×
          </button>
        </div>
        <div className="detail-heading">
          <div className={`detail-status-mark ${statusTone(skill.status)}`}>
            {STATUS_COPY[skill.status].symbol}
          </div>
          <div className="detail-heading-copy">
            <div className="detail-title-line">
              <h2>{displaySkillName(skill)}</h2>
              <span>{STATUS_COPY[skill.status].detail}</span>
            </div>
            {skill.displayName !== skill.name && (
              <code className="detail-technical-name">{skill.name}</code>
            )}
          </div>
        </div>

        <div className="detail-panel-tabs" role="tablist" aria-label="Skill 详情">
          <button
            role="tab"
            aria-selected={detailTab === "files"}
            className={detailTab === "files" ? "is-active" : ""}
            onClick={() => setDetailTab("files")}
          >
            文件内容
            <span>{fileListing?.fileCount ?? skill.fileCount}</span>
          </button>
          <button
            role="tab"
            aria-selected={detailTab === "installations"}
            className={detailTab === "installations" ? "is-active" : ""}
            onClick={() => setDetailTab("installations")}
          >
            安装信息
            <span>{skill.instances.length}</span>
          </button>
        </div>

        <div className="detail-panel-workspace">
          {detailTab === "files" ? (
            <section className="detail-files-view" aria-label="文件与内容">
              <div className="detail-workspace-heading">
                <div
                  className="skill-browser-instance-tabs"
                  aria-label="选择安装版本"
                >
                  {skill.instances.map((instance) => {
                    const agent = agents.find(
                      (item) => item.id === instance.agentId,
                    );
                    return (
                      <button
                        key={instance.id}
                        className={
                          activeInstanceId === instance.id ? "is-active" : ""
                        }
                        onClick={() => selectInstance(instance.id)}
                        title={`查看 ${instance.agentName} 中的版本`}
                      >
                        {agent && <AgentMark agent={agent} active />}
                        <span>{instance.agentName}</span>
                        <code>{instance.shortHash}</code>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="skill-browser">
                <aside className="skill-file-tree" aria-label="技能文件列表">
                  <div className="file-tree-heading">
                    <span>文件目录</span>
                    <div>
                      {fileListing && (
                        <small>
                          {fileListing.fileCount} 文件 ·{" "}
                          {fileListing.directoryCount} 目录
                        </small>
                      )}
                      {fileListing?.truncated && <em>已截断</em>}
                    </div>
                  </div>
                  {listingLoading ? (
                    <div className="browser-loading">正在读取目录…</div>
                  ) : fileListing?.entries.length ? (
                    <div className="file-tree-list">
                      {visibleFileEntries.map((entry) => {
                        const depth = entry.path.split("/").length - 1;
                        if (entry.type === "directory") {
                          const isCollapsed = collapsedDirectories.has(
                            entry.path,
                          );
                          return (
                            <button
                              key={entry.path}
                              type="button"
                              className="file-tree-directory"
                              aria-expanded={!isCollapsed}
                              style={
                                {
                                  "--file-depth": depth,
                                } as React.CSSProperties
                              }
                              onClick={() => toggleDirectory(entry.path)}
                              title={`${isCollapsed ? "展开" : "折叠"} ${entry.path}`}
                            >
                              <span aria-hidden>
                                {isCollapsed ? "▸" : "▾"}
                              </span>
                              <strong>{entry.name}</strong>
                              <small>目录</small>
                            </button>
                          );
                        }
                        return (
                          <button
                            key={entry.path}
                            type="button"
                            className={
                              selectedFilePath === entry.path ? "is-active" : ""
                            }
                            aria-current={
                              selectedFilePath === entry.path ? "page" : undefined
                            }
                            style={
                              {
                                "--file-depth": depth,
                              } as React.CSSProperties
                            }
                            onClick={() => selectFile(entry.path)}
                            title={entry.path}
                          >
                            <span aria-hidden>
                              {entry.type === "symlink" ? "↗" : "·"}
                            </span>
                            <strong>{entry.name}</strong>
                            <small>{entry.language || "文件"}</small>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="browser-loading">
                      目录中没有可显示的文件。
                    </div>
                  )}
                </aside>

                <div className="skill-file-preview" aria-live="polite">
                  <div className="file-preview-heading">
                    <div>
                      <strong>
                        {fileContent?.path || selectedFilePath || "选择文件"}
                      </strong>
                      {fileContent && (
                        <span>
                          {fileContent.language} ·{" "}
                          {formatBytes(fileContent.size)} ·{" "}
                          {formatRelativeDate(fileContent.modifiedAt)}
                        </span>
                      )}
                    </div>
                    <div className="file-preview-tools">
                      {fileContent?.previewable &&
                      isMarkdownPath(fileContent.path) ? (
                        <div
                          className="file-view-toggle"
                          aria-label="Markdown 显示方式"
                        >
                          <button
                            type="button"
                            className={
                              previewMode === "rendered" ? "is-active" : ""
                            }
                            aria-pressed={previewMode === "rendered"}
                            onClick={() => setPreviewMode("rendered")}
                          >
                            预览
                          </button>
                          <button
                            type="button"
                            className={
                              previewMode === "source" ? "is-active" : ""
                            }
                            aria-pressed={previewMode === "source"}
                            onClick={() => setPreviewMode("source")}
                          >
                            原文
                          </button>
                        </div>
                      ) : (
                        fileContent?.language && (
                          <code>{fileContent.language}</code>
                        )
                      )}
                    </div>
                  </div>
                  <div
                    className={`skill-file-body ${
                      previewMode === "rendered" ? "is-rendered" : "is-source"
                    }`}
                  >
                    {contentLoading ? (
                      <div className="browser-loading browser-loading-content">
                        正在读取文件内容…
                      </div>
                    ) : browserError ? (
                      <div className="browser-empty-state">
                        <strong>无法读取</strong>
                        <p>{browserError}</p>
                      </div>
                    ) : fileContent?.previewable ? (
                      isMarkdownPath(fileContent.path) &&
                      previewMode === "rendered" ? (
                        <article className="markdown-preview">
                          <MarkdownDocument content={fileContent.content || ""} />
                        </article>
                      ) : (
                        <pre className="skill-file-content">
                          {fileContent.content}
                        </pre>
                      )
                    ) : fileContent ? (
                      <div className="browser-empty-state">
                        <strong>无法预览此文件</strong>
                        <p>{fileContent.reason}</p>
                        <span>{formatBytes(fileContent.size)}</span>
                      </div>
                    ) : (
                      <div className="browser-empty-state">
                        <strong>选择左侧文件</strong>
                        <p>
                          Markdown 默认展示排版效果，也可以切换到原始内容。
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>
          ) : (
            <section className="detail-install-view" aria-label="安装信息">
              <div className="detail-install-summary">
                <div className="section-label">
                  <span>技能概览</span>
                  <span>{STATUS_COPY[skill.status].label}</span>
                </div>
                <p>{skill.description}</p>
                <div className="detail-install-metrics">
                  <div>
                    <span>工具覆盖</span>
                    <strong>
                      {
                        skill.installedAgentIds.filter((agentId) =>
                          agents.some((agent) => agent.id === agentId),
                        ).length
                      }
                      /{agents.length}
                    </strong>
                  </div>
                  <div>
                    <span>文件总数</span>
                    <strong>{skill.fileCount}</strong>
                  </div>
                  <div>
                    <span>版本指纹</span>
                    <strong>{skill.hashes.length}</strong>
                  </div>
                </div>
              </div>
              <div className="section-label">
                <span>安装位置</span>
                <span>{skill.instances.length} 个安装位置</span>
              </div>
              <div className="instance-list">
                {agents.map((agent) => {
                  const instance = instancesByAgent.get(agent.id);
                  return (
                    <article
                      key={agent.id}
                      className={`instance-card ${
                        instance ? "is-installed" : ""
                      }`}
                      style={
                        {
                          "--agent-color": agent.color,
                        } as React.CSSProperties
                      }
                    >
                      <div className="instance-agent">
                        <AgentMark agent={agent} active={Boolean(instance)} />
                        <div>
                          <strong>{agent.name}</strong>
                          <span>{instance ? "已安装" : "缺失"}</span>
                        </div>
                      </div>
                      {instance ? (
                        <>
                          <button
                            className="path-button"
                            onClick={() => onReveal(instance.id)}
                            title="在文件管理器中显示"
                          >
                            {instance.path}
                          </button>
                          <div className="instance-meta">
                            <span>
                              {instance.fileCount} 文件 ·{" "}
                              {formatBytes(instance.byteCount)}
                            </span>
                            <code>{instance.shortHash}</code>
                            {instance.isSymlink && <em>软链接</em>}
                          </div>
                        </>
                      ) : (
                        <p className="missing-copy">可以从现有安装安全补齐。</p>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        <div className="panel-sticky-actions">
          <button className="button button-ghost" onClick={onClose}>
            关闭
          </button>
          <button
            className="button button-ghost"
            onClick={() => onExport(activeInstanceId)}
            disabled={!activeInstanceId}
          >
            导出 .skill
          </button>
          <button className="button button-acid" onClick={onSync}>
            {skill.conflict
              ? "选择权威版本"
              : missingAgentCount(skill, agents)
                ? "同步到其他工具"
                : "管理同步"}{" "}
            →
          </button>
        </div>
      </aside>
    </div>
  );
}

function SyncDialog({
  skill,
  agents,
  defaultMode,
  onClose,
  onComplete,
}: {
  skill: Skill;
  agents: Agent[];
  defaultMode: "copy" | "symlink";
  onClose: () => void;
  onComplete: () => Promise<void>;
}) {
  const dialogRef = useModalFocus<HTMLElement>();
  const newestInstance = skill.instances[0];
  const visibleMissingAgentIds = skill.missingAgentIds.filter((agentId) =>
    agents.some((agent) => agent.id === agentId),
  );
  const [sourceId, setSourceId] = useState(newestInstance?.id || "");
  const [targetIds, setTargetIds] = useState<string[]>(
    visibleMissingAgentIds.length
      ? visibleMissingAgentIds
      : agents
          .filter((agent) => agent.id !== newestInstance?.agentId)
          .map((agent) => agent.id),
  );
  const [mode, setMode] = useState<"copy" | "symlink">(defaultMode);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);

  const source = skill.instances.find((instance) => instance.id === sourceId);

  function toggleTarget(agentId: string) {
    setPlan(null);
    setTargetIds((current) =>
      current.includes(agentId)
        ? current.filter((item) => item !== agentId)
        : [...current, agentId],
    );
  }

  async function preview() {
    setBusy(true);
    setError("");
    try {
      const nextPlan = await requestJson<SyncPlan>("/api/sync", {
        method: "POST",
        body: JSON.stringify({
          sourceInstanceId: sourceId,
          targetAgentIds: targetIds,
          mode,
          dryRun: true,
        }),
      });
      setPlan(nextPlan);
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "无法生成同步计划。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    setBusy(true);
    setError("");
    try {
      await requestJson<SyncPlan>("/api/sync", {
        method: "POST",
        headers: { "x-skill-manager-confirm": "yes" },
        body: JSON.stringify({
          sourceInstanceId: sourceId,
          targetAgentIds: targetIds,
          mode,
          dryRun: false,
          confirm: true,
        }),
      });
      setCompleted(true);
      await onComplete();
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "同步执行失败。",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay modal-overlay" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="sync-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`同步 ${displaySkillName(skill)}`}
        tabIndex={-1}
      >
        <div className="panel-topline">
          <span>技能同步</span>
          <button className="icon-button" onClick={onClose} aria-label="关闭同步">
            ×
          </button>
        </div>

        {completed ? (
          <div className="sync-success">
            <span className="success-seal">✓</span>
            <p className="eyebrow">操作已完成</p>
            <h2>同步完成</h2>
            <p>
              {displaySkillName(skill)} 已写入所选工具。原有内容如被替换，已经存入本地备份。
            </p>
            <button className="button button-acid" onClick={onClose}>
              返回技能列表
            </button>
          </div>
        ) : (
          <>
            <div className="sync-title">
              <p className="eyebrow">同步技能</p>
              <h2>{displaySkillName(skill)}</h2>
              {skill.displayName !== skill.name && (
                <code className="detail-technical-name">{skill.name}</code>
              )}
              <p>先确认权威来源，再选择需要更新的目标。执行前会展示全部改动。</p>
            </div>

            <div className="sync-grid">
              <section>
                <div className="section-label">
                  <span>01 / 权威来源</span>
                  <span>来源版本</span>
                </div>
                <div className="source-options">
                  {skill.instances.map((instance) => {
                    const agent = agents.find(
                      (item) => item.id === instance.agentId,
                    );
                    if (!agent) return null;
                    return (
                      <label
                        className={`source-option ${
                          sourceId === instance.id ? "is-selected" : ""
                        }`}
                        key={instance.id}
                      >
                        <input
                          type="radio"
                          name="source"
                          value={instance.id}
                          checked={sourceId === instance.id}
                          onChange={() => {
                            setSourceId(instance.id);
                            setPlan(null);
                          }}
                        />
                        <AgentMark agent={agent} active />
                        <span>
                          <strong>{agent.name}</strong>
                          <small>
                            {instance.shortHash} ·{" "}
                            {formatRelativeDate(instance.modifiedAt)}
                          </small>
                        </span>
                        <b>●</b>
                      </label>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="section-label">
                  <span>02 / 同步目标</span>
                  <span>目标工具</span>
                </div>
                <div className="target-options">
                  {agents.map((agent) => {
                    const current = skill.instances.find(
                      (instance) => instance.agentId === agent.id,
                    );
                    const isSource = current?.id === sourceId;
                    const selected = targetIds.includes(agent.id);
                    return (
                      <label
                        className={`target-option ${
                          selected ? "is-selected" : ""
                        } ${isSource ? "is-disabled" : ""}`}
                        key={agent.id}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={isSource}
                          onChange={() => toggleTarget(agent.id)}
                        />
                        <span
                          className="target-check"
                          aria-hidden
                          style={
                            { "--agent-color": agent.color } as React.CSSProperties
                          }
                        >
                          {selected ? "✓" : ""}
                        </span>
                        <span>
                          <strong>{agent.name}</strong>
                          <small>
                            {isSource
                              ? "当前来源"
                              : current
                                ? current.hash === source?.hash
                                  ? "内容已一致"
                                  : "将更新现有版本"
                                : "将新增安装"}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </section>
            </div>

            <section className="sync-mode-section">
              <div className="section-label">
                <span>03 / 同步方式</span>
                <span>安装方式</span>
              </div>
              <div className="mode-switch">
                <button
                  className={mode === "copy" ? "is-selected" : ""}
                  onClick={() => {
                    setMode("copy");
                    setPlan(null);
                  }}
                >
                  <span>复制</span>
                  <small>各端保留独立副本，最稳妥</small>
                </button>
                <button
                  className={mode === "symlink" ? "is-selected" : ""}
                  onClick={() => {
                    setMode("symlink");
                    setPlan(null);
                  }}
                >
                  <span>软链接</span>
                  <small>一处修改，多端即时生效</small>
                </button>
              </div>
            </section>

            {plan && (
              <section className="plan-preview">
                <div className="section-label">
                  <span>改动预览</span>
                  <span>{plan.actions.length} 项操作</span>
                </div>
                {plan.actions.map((action) => (
                  <div className="plan-action" key={action.agentId}>
                    <span className={`action-code action-${action.action}`}>
                      {action.action === "create"
                        ? "新增"
                        : action.action === "replace"
                          ? "更新"
                          : "不变"}
                    </span>
                    <div>
                      <strong>{action.agentName}</strong>
                      <code>{action.destination}</code>
                      {action.backup && (
                        <small>原版本备份至 {action.backup}</small>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}

            {error && <p className="inline-error">{error}</p>}

            <div className="dialog-actions">
              <div className="safety-note">
                <span>安全</span>
                <p>覆盖前自动备份；不会修改来源。</p>
              </div>
              <button className="button button-ghost" onClick={onClose}>
                取消
              </button>
              {plan ? (
                <button
                  className="button button-orange"
                  disabled={busy || !plan.actions.some((item) => item.action !== "noop")}
                  onClick={execute}
                >
                  {busy ? "正在执行…" : "确认并执行同步"}
                </button>
              ) : (
                <button
                  className="button button-acid"
                  disabled={busy || !sourceId || targetIds.length === 0}
                  onClick={preview}
                >
                  {busy ? "正在检查…" : "生成同步计划"} →
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function SkillImportDropDialog({
  loading,
  dragActive,
  onClose,
  onFile,
  onDragStateChange,
}: {
  loading: boolean;
  dragActive: boolean;
  onClose: () => void;
  onFile: (file: File) => void;
  onDragStateChange: (active: boolean) => void;
}) {
  const dialogRef = useModalFocus<HTMLElement>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dropError, setDropError] = useState("");

  function acceptDroppedFile(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    onDragStateChange(false);
    const file = [...event.dataTransfer.files].find((item) =>
      item.name.toLowerCase().endsWith(".skill"),
    );
    if (file) {
      setDropError("");
      onFile(file);
    } else {
      setDropError("请选择扩展名为 .skill 的技能包。");
    }
  }

  return (
    <div
      className={`overlay modal-overlay import-drop-overlay ${
        dragActive ? "is-dragging" : ""
      }`}
      onMouseDown={loading ? undefined : onClose}
      onDragEnter={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDragStateChange(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.currentTarget === event.target) onDragStateChange(false);
      }}
      onDrop={acceptDroppedFile}
    >
      <section
        ref={dialogRef}
        className="import-drop-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="导入 .skill 技能包"
        tabIndex={-1}
      >
        <div className="panel-topline">
          <span>打开 .skill 技能包</span>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={loading}
            aria-label="关闭导入"
          >
            ×
          </button>
        </div>
        <div className="import-drop-copy">
          <p className="eyebrow">本地技能包</p>
          <h2>拖进来，先看清再安装。</h2>
          <p>
            支持标准 <code>.skill</code> 文件。解析后会先展示名称、说明、全部文件与内容，
            由你选择要安装到哪些工具。
          </p>
        </div>
        <div
          className={`import-drop-zone ${dragActive ? "is-active" : ""}`}
          role="button"
          tabIndex={loading ? -1 : 0}
          onClick={() => {
            if (!loading) fileInputRef.current?.click();
          }}
          onKeyDown={(event) => {
            if (
              !loading &&
              (event.key === "Enter" || event.key === " ")
            ) {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
        >
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".skill"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file?.name.toLowerCase().endsWith(".skill")) {
                setDropError("");
                onFile(file);
              } else if (file) {
                setDropError("请选择扩展名为 .skill 的技能包。");
              }
              event.target.value = "";
            }}
          />
          <span className="import-drop-icon" aria-hidden>
            {loading ? "···" : "↓"}
          </span>
          <strong>
            {loading
              ? "正在解析技能包"
              : dragActive
                ? "松手即可打开预览"
                : "把 .skill 文件拖到这里"}
          </strong>
          <small>{loading ? "正在检查包结构与文件安全性…" : "或点击选择文件"}</small>
        </div>
        {dropError && (
          <p className="import-drop-error" role="alert">
            {dropError}
          </p>
        )}
        <div className="import-drop-footnote">
          <span>先预览</span>
          <p>这一步不会修改 Codex、Claude Code 或其他工具的技能目录。</p>
        </div>
      </section>
    </div>
  );
}

function ImportSkillDialog({
  imported,
  agents,
  onClose,
  onInstalled,
}: {
  imported: ImportedSkill;
  agents: Agent[];
  onClose: () => void;
  onInstalled: () => Promise<void>;
}) {
  const dialogRef = useModalFocus<HTMLElement>();
  const firstFilePath =
    imported.entries.find(
      (entry) => entry.path.toLowerCase() === "skill.md",
    )?.path ||
    imported.entries.find((entry) => entry.type !== "directory")?.path ||
    "";
  const [selectedFilePath, setSelectedFilePath] = useState(firstFilePath);
  const [fileContent, setFileContent] = useState<SkillFileContent | null>(null);
  const [contentLoading, setContentLoading] = useState(Boolean(firstFilePath));
  const [previewMode, setPreviewMode] = useState<"rendered" | "source">(
    isMarkdownPath(firstFilePath) ? "rendered" : "source",
  );
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(
    () =>
      new Set(
        imported.entries
          .filter((entry) => entry.type === "directory")
          .map((entry) => entry.path),
      ),
  );
  const [targetIds, setTargetIds] = useState(() =>
    agents.map((agent) => agent.id),
  );
  const [plan, setPlan] = useState<ImportInstallPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const visibleEntries = useMemo(
    () =>
      imported.entries.filter((entry) => {
        const pathParts = entry.path.split("/");
        const parentParts = pathParts.slice(0, -1);
        let parentPath = "";
        return parentParts.every((part) => {
          parentPath = parentPath ? `${parentPath}/${part}` : part;
          return !collapsedDirectories.has(parentPath);
        });
      }),
    [collapsedDirectories, imported.entries],
  );

  useEffect(() => {
    if (!selectedFilePath) return;
    let cancelled = false;
    requestJson<SkillFileContent>(
      `/api/import-file?importId=${encodeURIComponent(imported.importId)}&path=${encodeURIComponent(selectedFilePath)}`,
    )
      .then((content) => {
        if (!cancelled) setFileContent(content);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setFileContent(null);
          setError(
            loadError instanceof Error ? loadError.message : "无法读取文件。",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [imported.importId, selectedFilePath]);

  function selectFile(filePath: string) {
    if (filePath === selectedFilePath) return;
    setSelectedFilePath(filePath);
    setFileContent(null);
    setError("");
    setContentLoading(true);
    setPreviewMode(isMarkdownPath(filePath) ? "rendered" : "source");
  }

  function toggleDirectory(directoryPath: string) {
    setCollapsedDirectories((current) => {
      const next = new Set(current);
      if (next.has(directoryPath)) {
        next.delete(directoryPath);
      } else {
        next.add(directoryPath);
      }
      return next;
    });
  }

  function toggleTarget(agentId: string) {
    setTargetIds((current) =>
      current.includes(agentId)
        ? current.filter((item) => item !== agentId)
        : [...current, agentId],
    );
    setPlan(null);
  }

  async function previewInstall() {
    setBusy(true);
    setError("");
    try {
      setPlan(
        await requestJson<ImportInstallPlan>("/api/import-install", {
          method: "POST",
          body: JSON.stringify({
            importId: imported.importId,
            targetAgentIds: targetIds,
            dryRun: true,
          }),
        }),
      );
    } catch (previewError) {
      setError(
        previewError instanceof Error ? previewError.message : "无法生成安装计划。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    setBusy(true);
    setError("");
    try {
      await requestJson<ImportInstallPlan>("/api/import-install", {
        method: "POST",
        headers: { "x-skill-manager-confirm": "yes" },
        body: JSON.stringify({
          importId: imported.importId,
          targetAgentIds: targetIds,
          dryRun: false,
          confirm: true,
        }),
      });
      await onInstalled();
      onClose();
    } catch (installError) {
      setError(
        installError instanceof Error ? installError.message : "安装失败。",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay modal-overlay" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="import-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`导入 ${imported.displayName}`}
        tabIndex={-1}
      >
        <div className="panel-topline">
          <span>导入 .skill 技能包</span>
          <button className="icon-button" onClick={onClose} aria-label="关闭导入">
            ×
          </button>
        </div>

        <div className="import-heading">
          <div className="import-package-mark">S</div>
          <div>
            <p className="eyebrow">可移植技能包</p>
            <h2>{imported.displayName}</h2>
            {imported.displayName !== imported.name && (
              <code className="detail-technical-name">{imported.name}</code>
            )}
            <p>{imported.description}</p>
          </div>
        </div>

        <div className="detail-metrics import-metrics">
          <div>
            <span>文件</span>
            <strong>{imported.fileCount}</strong>
          </div>
          <div>
            <span>体积</span>
            <strong>{formatBytes(imported.byteCount)}</strong>
          </div>
          <div>
            <span>指纹</span>
            <strong>{imported.shortHash}</strong>
          </div>
        </div>

        <div className="import-dialog-content">
          <section className="panel-section skill-browser-section">
            <div className="section-label">
              <span>打包内容预览</span>
              <span>{imported.originalFilename}</span>
            </div>
            <div className="skill-browser import-skill-browser">
              <aside className="skill-file-tree" aria-label="导入文件列表">
                <div className="file-tree-heading">
                  <span>文件</span>
                  <em>{imported.fileCount}</em>
                </div>
                <div className="file-tree-list">
                  {visibleEntries.map((entry) => {
                    const depth = entry.path.split("/").length - 1;
                    if (entry.type === "directory") {
                      const isCollapsed = collapsedDirectories.has(entry.path);
                      return (
                        <button
                          type="button"
                          key={entry.path}
                          className="file-tree-directory"
                          aria-expanded={!isCollapsed}
                          style={
                            {
                              "--file-depth": depth,
                            } as React.CSSProperties
                          }
                          onClick={() => toggleDirectory(entry.path)}
                        >
                          <span aria-hidden>{isCollapsed ? "▸" : "▾"}</span>
                          <strong>{entry.name}</strong>
                          <small>目录</small>
                        </button>
                      );
                    }
                    return (
                      <button
                        key={entry.path}
                        className={
                          selectedFilePath === entry.path ? "is-active" : ""
                        }
                        aria-current={
                          selectedFilePath === entry.path ? "page" : undefined
                        }
                        style={
                          {
                            "--file-depth": depth,
                          } as React.CSSProperties
                        }
                        onClick={() => selectFile(entry.path)}
                      >
                        <span aria-hidden>·</span>
                        <strong>{entry.name}</strong>
                        <small>{entry.language || "文件"}</small>
                      </button>
                    );
                  })}
                </div>
              </aside>
              <div className="skill-file-preview">
                <div className="file-preview-heading">
                  <div>
                    <strong>{fileContent?.path || selectedFilePath}</strong>
                    {fileContent && (
                      <span>
                        {fileContent.language} · {formatBytes(fileContent.size)}
                      </span>
                    )}
                  </div>
                  {fileContent?.previewable &&
                  isMarkdownPath(fileContent.path) ? (
                    <div
                      className="file-view-toggle"
                      aria-label="Markdown 显示方式"
                    >
                      <button
                        type="button"
                        className={previewMode === "rendered" ? "is-active" : ""}
                        aria-pressed={previewMode === "rendered"}
                        onClick={() => setPreviewMode("rendered")}
                      >
                        预览
                      </button>
                      <button
                        type="button"
                        className={previewMode === "source" ? "is-active" : ""}
                        aria-pressed={previewMode === "source"}
                        onClick={() => setPreviewMode("source")}
                      >
                        原文
                      </button>
                    </div>
                  ) : (
                    fileContent?.language && <code>{fileContent.language}</code>
                  )}
                </div>
                {contentLoading ? (
                  <div className="browser-loading browser-loading-content">
                    正在读取文件…
                  </div>
                ) : fileContent?.previewable ? (
                  isMarkdownPath(fileContent.path) &&
                  previewMode === "rendered" ? (
                    <div className="skill-file-body is-rendered">
                      <article className="markdown-preview">
                        <MarkdownDocument content={fileContent.content || ""} />
                      </article>
                    </div>
                  ) : (
                    <pre className="skill-file-content">{fileContent.content}</pre>
                  )
                ) : (
                  <div className="browser-empty-state">
                    <strong>无法预览此文件</strong>
                    <p>{fileContent?.reason || "请选择一个文本文件。"}</p>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="import-target-section">
            <div className="section-label">
              <span>安装到工具</span>
              <span>已选 {targetIds.length} 个</span>
            </div>
            <div className="import-target-grid">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  className={targetIds.includes(agent.id) ? "is-selected" : ""}
                  onClick={() => toggleTarget(agent.id)}
                >
                  <AgentMark agent={agent} active />
                  <span>
                    <strong>{agent.name}</strong>
                    <small>
                      {targetIds.includes(agent.id) ? "将安装" : "不安装"}
                    </small>
                  </span>
                  <b>{targetIds.includes(agent.id) ? "✓" : "+"}</b>
                </button>
              ))}
            </div>
          </section>

          {plan && (
            <section className="plan-preview import-plan-preview">
              <div className="section-label">
                <span>安装计划</span>
                <span>{plan.actions.length} 项操作</span>
              </div>
              {plan.actions.map((action) => (
                <div className="plan-action" key={action.agentId}>
                  <span className={`action-code action-${action.action}`}>
                    {action.action === "create"
                      ? "新增"
                      : action.action === "replace"
                        ? "更新"
                        : "不变"}
                  </span>
                  <div>
                    <strong>{action.agentName}</strong>
                    <code>{action.destination}</code>
                    {action.backup && <small>原版本会自动备份</small>}
                  </div>
                </div>
              ))}
            </section>
          )}

          {error && <p className="inline-error">{error}</p>}
        </div>

        <div className="dialog-actions">
          <div className="safety-note">
            <span>本机</span>
            <p>包内容仅在本机解析；覆盖前自动备份。</p>
          </div>
          <button className="button button-ghost" onClick={onClose}>
            取消
          </button>
          {plan ? (
            <button
              className="button button-orange"
              onClick={install}
              disabled={
                busy || !plan.actions.some((action) => action.action !== "noop")
              }
            >
              {busy ? "正在安装…" : "确认安装"}
            </button>
          ) : (
            <button
              className="button button-acid"
              onClick={previewInstall}
              disabled={busy || targetIds.length === 0}
            >
              {busy ? "正在检查…" : "生成安装计划"} →
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function SettingsDialog({
  config,
  onClose,
  onSave,
}: {
  config: ManagerConfig;
  onClose: () => void;
  onSave: (config: ManagerConfig) => Promise<void>;
}) {
  const dialogRef = useModalFocus<HTMLElement>();
  const [draft, setDraft] = useState<ManagerConfig>(() =>
    JSON.parse(JSON.stringify(config)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const agentListRef = useRef<HTMLDivElement>(null);

  function updateAgent(
    index: number,
    patch: Partial<AgentConfig>,
  ) {
    setDraft((current) => ({
      ...current,
      agents: current.agents.map((agent, agentIndex) =>
        agentIndex === index ? { ...agent, ...patch } : agent,
      ),
    }));
  }

  function addAgent() {
    const index = draft.agents.length + 1;
    setDraft((current) => ({
      ...current,
      agents: [
        ...current.agents,
        {
          id: `agent-${index}`,
          name: `智能工具 ${index}`,
          shortName: `A${index}`,
          color: "#f6ca45",
          paths: [`~/.agent-${index}/skills`],
        },
      ],
    }));
    window.requestAnimationFrame(() => {
      agentListRef.current?.scrollTo({
        top: agentListRef.current.scrollHeight,
        behavior: "auto",
      });
    });
  }

  function toggleAgentVisibility(agentId: string) {
    setDraft((current) => {
      const isVisible = current.visibleAgentIds.includes(agentId);
      if (isVisible && current.visibleAgentIds.length === 1) return current;
      return {
        ...current,
        visibleAgentIds: isVisible
          ? current.visibleAgentIds.filter((id) => id !== agentId)
          : [...current.visibleAgentIds, agentId],
      };
    });
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      await onSave(draft);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay modal-overlay" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="settings-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="工具与技能目录设置"
        tabIndex={-1}
      >
        <div className="panel-topline">
          <span>工具数据源</span>
          <button className="icon-button" onClick={onClose} aria-label="关闭设置">
            ×
          </button>
        </div>
        <div className="settings-heading">
          <p className="eyebrow">本地数据源</p>
          <h2>工具与技能目录</h2>
          <p>每行一个目录。支持以 ~/ 开头的用户目录，也支持绝对路径。</p>
          <div className="default-sync-mode" aria-label="默认同步方式">
            <span>默认同步方式</span>
            <button
              type="button"
              className={draft.syncMode === "copy" ? "is-active" : ""}
              aria-pressed={draft.syncMode === "copy"}
              onClick={() =>
                setDraft((current) => ({ ...current, syncMode: "copy" }))
              }
            >
              复制
            </button>
            <button
              type="button"
              className={draft.syncMode === "symlink" ? "is-active" : ""}
              aria-pressed={draft.syncMode === "symlink"}
              onClick={() =>
                setDraft((current) => ({ ...current, syncMode: "symlink" }))
              }
            >
              软链接
            </button>
          </div>
        </div>
        <div className="agent-config-list" ref={agentListRef}>
          {draft.agents.map((agent, index) => (
            <article
              className="agent-config-card"
              key={`${agent.id}-${index}`}
              style={{ "--agent-color": agent.color } as React.CSSProperties}
            >
              <div className="config-accent" />
              <div className="agent-config-toolbar">
                <span>{agent.id}</span>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.visibleAgentIds.includes(agent.id)}
                    onChange={() => toggleAgentVisibility(agent.id)}
                    disabled={
                      draft.visibleAgentIds.includes(agent.id) &&
                      draft.visibleAgentIds.length === 1
                    }
                  />
                  <span>在列表与安装目标中展示</span>
                </label>
              </div>
              <div className="config-fields config-fields-title">
                <label>
                  <span>工具名称</span>
                  <input
                    value={agent.name}
                    onChange={(event) =>
                      updateAgent(index, { name: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span>标识</span>
                  <input
                    value={agent.shortName}
                    maxLength={3}
                    onChange={(event) =>
                      updateAgent(index, {
                        shortName: event.target.value.toUpperCase(),
                      })
                    }
                  />
                </label>
                <label className="color-field">
                  <span>颜色</span>
                  <input
                    type="color"
                    value={agent.color}
                    onChange={(event) =>
                      updateAgent(index, { color: event.target.value })
                    }
                  />
                </label>
                <button
                  className="remove-agent"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      agents: current.agents.filter(
                        (_, agentIndex) => agentIndex !== index,
                      ),
                    }))
                  }
                  disabled={draft.agents.length <= 1}
                  aria-label={`移除 ${agent.name}`}
                >
                  ×
                </button>
              </div>
              <label className="paths-field">
                <span>技能目录</span>
                <textarea
                  value={agent.paths.join("\n")}
                  onChange={(event) =>
                    updateAgent(index, {
                      paths: event.target.value
                        .split("\n")
                        .map((item) => item.trim())
                        .filter(Boolean),
                    })
                  }
                  rows={Math.max(2, agent.paths.length)}
                />
              </label>
            </article>
          ))}
        </div>
        <button className="add-agent-button" onClick={addAgent}>
          ＋ 添加其他智能工具
        </button>
        {error && <p className="inline-error">{error}</p>}
        <div className="dialog-actions">
          <span className="settings-note">
            默认展示 Codex 与 Claude Code；保存后立即重新扫描。
          </span>
          <button className="button button-ghost" onClick={onClose}>
            取消
          </button>
          <button className="button button-acid" onClick={save} disabled={busy}>
            {busy ? "保存中…" : "保存并扫描"} →
          </button>
        </div>
      </section>
    </div>
  );
}

function SyncCenter({
  data,
  onSync,
  onSelect,
}: {
  data: ScanData;
  onSync: (skill: Skill) => void;
  onSelect: (skill: Skill) => void;
}) {
  const conflicts = data.skills.filter((skill) => skill.conflict);
  const incomplete = data.skills.filter(
    (skill) => !skill.conflict && skill.missingAgentIds.length > 0,
  );
  const [visibleConflictCount, setVisibleConflictCount] = useState(12);
  const [visibleIncompleteCount, setVisibleIncompleteCount] = useState(12);

  return (
    <div className="sync-center page-enter">
      <div className="view-intro">
        <div>
          <p className="eyebrow">技能同步中心</p>
          <h1>把版本差异，变成可控事务。</h1>
        </div>
        <p>
          每次同步都会先生成计划。现有内容被替换前自动备份，执行记录保存在本机。
        </p>
      </div>

      <section className="priority-board">
        <div className="priority-header">
          <span>优先处理</span>
          <span>{conflicts.length + incomplete.length} 个待处理技能</span>
        </div>
        <div className="priority-columns">
          <div>
            <div className="column-heading conflict-heading">
              <span>!</span>
              <div>
                <strong>版本冲突</strong>
                <small>选择一个权威来源</small>
              </div>
              <b>{conflicts.length}</b>
            </div>
            <div className="priority-list">
              {conflicts.length ? (
                conflicts.slice(0, visibleConflictCount).map((skill) => (
                  <button key={skill.id} onClick={() => onSync(skill)}>
                    <span>
                      <strong>{displaySkillName(skill)}</strong>
                      {skill.displayName !== skill.name && (
                        <code className="priority-technical-name">
                          {skill.name}
                        </code>
                      )}
                      <small>{skill.hashes.length} 个内容指纹</small>
                    </span>
                    <em>处理 →</em>
                  </button>
                ))
              ) : (
                <p className="column-empty">没有发现同名冲突。</p>
              )}
              {conflicts.length > visibleConflictCount && (
                <button
                  type="button"
                  className="priority-load-more"
                  onClick={() =>
                    setVisibleConflictCount((count) =>
                      Math.min(count + 12, conflicts.length),
                    )
                  }
                >
                  再显示{" "}
                  {Math.min(12, conflicts.length - visibleConflictCount)} 个冲突
                </button>
              )}
            </div>
          </div>
          <div>
            <div className="column-heading incomplete-heading">
              <span>↗</span>
              <div>
                <strong>覆盖不完整</strong>
                <small>补齐到其他工具</small>
              </div>
              <b>{incomplete.length}</b>
            </div>
            <div className="priority-list">
              {incomplete.length ? (
                incomplete.slice(0, visibleIncompleteCount).map((skill) => (
                  <button key={skill.id} onClick={() => onSync(skill)}>
                    <span>
                      <strong>{displaySkillName(skill)}</strong>
                      {skill.displayName !== skill.name && (
                        <code className="priority-technical-name">
                          {skill.name}
                        </code>
                      )}
                      <small>缺少 {skill.missingAgentIds.length} 个工具</small>
                    </span>
                    <em>补齐 →</em>
                  </button>
                ))
              ) : (
                <p className="column-empty">所有技能已覆盖全部工具。</p>
              )}
              {incomplete.length > visibleIncompleteCount && (
                <button
                  type="button"
                  className="priority-load-more"
                  onClick={() =>
                    setVisibleIncompleteCount((count) =>
                      Math.min(count + 12, incomplete.length),
                    )
                  }
                >
                  再显示{" "}
                  {Math.min(12, incomplete.length - visibleIncompleteCount)}{" "}
                  个待补齐技能
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="history-section">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">本机操作记录</p>
            <h2>最近同步记录</h2>
          </div>
          <span>仅保存在本机</span>
        </div>
        {data.history.length ? (
          <div className="history-list">
            {data.history.map((entry) => (
              <button
                key={entry.id}
                onClick={() => {
                  const skill = data.skills.find(
                    (item) => item.name === entry.skillName,
                  );
                  if (skill) onSelect(skill);
                }}
              >
                <time>{formatRelativeDate(entry.createdAt)}</time>
                <span className="history-mode">
                  {entry.mode === "copy" ? "复制" : "软链接"}
                </span>
                <strong>{entry.skillName}</strong>
                <span>
                  → {entry.targets.join("、") || "无变更"}
                  {entry.backups ? ` · ${entry.backups} 份备份` : ""}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            title="还没有同步记录"
            description="执行第一笔同步后，变更与备份信息会出现在这里。"
          />
        )}
      </section>
    </div>
  );
}

function SourcesView({
  data,
  onSettings,
}: {
  data: ScanData;
  onSettings: () => void;
}) {
  return (
    <div className="sources-view page-enter">
      <div className="view-intro">
        <div>
          <p className="eyebrow">工具数据源</p>
          <h1>一张本地技能网络。</h1>
        </div>
        <button className="button button-acid" onClick={onSettings}>
          管理工具与目录 →
        </button>
      </div>

      <div className="source-network">
        {data.agents.map((agent, index) => (
          <article
            className="source-card"
            key={agent.id}
            style={
              {
                "--agent-color": agent.color,
                "--agent-index": index,
              } as React.CSSProperties
            }
          >
            <div className="source-card-top">
              <AgentMark agent={agent} active={agent.available} />
              <span className={`source-health ${agent.available ? "online" : ""}`}>
                {agent.available ? "可用" : "目录缺失"}
              </span>
            </div>
            <h2>{agent.name}</h2>
            <div className="source-count">
              <strong>{agent.skillCount}</strong>
              <span>个技能</span>
            </div>
            <div className="source-roots">
              {agent.roots.map((root) => (
                <div key={root.configuredPath}>
                  <span className={root.available ? "root-ok" : "root-missing"}>
                    {root.available ? "●" : "○"}
                  </span>
                  <code>{root.path}</code>
                  <b>{root.skillCount}</b>
                </div>
              ))}
            </div>
          </article>
        ))}
        <button className="source-card add-source-card" onClick={onSettings}>
          <span>＋</span>
          <strong>接入其他工具</strong>
          <small>配置一个或多个技能目录</small>
        </button>
      </div>

      <section className="architecture-note">
        <span className="architecture-number">01</span>
        <div>
          <p className="eyebrow">推荐架构</p>
          <h2>把共享目录作为唯一真源</h2>
          <p>
            如果你经常编辑同一批技能，可以将它们集中在一个共享目录，再以软链接接入各个工具。复制模式更稳妥，软链接模式更高效；管理器同时支持两种策略。
          </p>
        </div>
        <div className="mini-diagram" aria-label="共享技能目录连接多个智能工具">
          <span className="hub">共享目录</span>
          <i />
          <div>
            {data.agents.slice(0, 4).map((agent) => (
              <span key={agent.id} style={{ borderColor: agent.color }}>
                {agent.shortName}
              </span>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState<ScanData | null>(null);
  const [config, setConfig] = useState<ManagerConfig | null>(null);
  const [view, setView] = useState<ViewName>("skills");
  const [activeAgentId, setActiveAgentId] = useState("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SkillStatus | "all">("all");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [syncSkillId, setSyncSkillId] = useState<string | null>(null);
  const [importedSkill, setImportedSkill] = useState<ImportedSkill | null>(null);
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const [importDragActive, setImportDragActive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [serviceError, setServiceError] = useState("");
  const [toast, setToast] = useState("");
  const dragDepthRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modalOpen = Boolean(
    selectedSkillId ||
      syncSkillId ||
      importedSkill ||
      importPickerOpen ||
      settingsOpen,
  );
  const blocksGlobalDrop = Boolean(
    selectedSkillId || syncSkillId || importedSkill || settingsOpen,
  );

  const loadData = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const [scan, nextConfig] = await Promise.all([
        requestJson<ScanData>(`/api/scan${force ? "?force=1" : ""}`),
        requestJson<ManagerConfig>("/api/config"),
      ]);
      setData(scan);
      setConfig(nextConfig);
      setServiceError("");
    } catch (loadError) {
      setServiceError(
        loadError instanceof Error
          ? loadError.message
          : "无法连接本地技能服务。",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!modalOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [modalOpen]);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (importedSkill) setImportedSkill(null);
        else if (importPickerOpen) {
          setImportPickerOpen(false);
          setImportDragActive(false);
          dragDepthRef.current = 0;
        } else if (syncSkillId) setSyncSkillId(null);
        else if (selectedSkillId) setSelectedSkillId(null);
        else if (settingsOpen) setSettingsOpen(false);
        return;
      }

      if (
        event.key.toLocaleLowerCase() === "k" &&
        (event.metaKey || event.ctrlKey) &&
        !importedSkill &&
        !importPickerOpen &&
        !syncSkillId &&
        !selectedSkillId &&
        !settingsOpen
      ) {
        event.preventDefault();
        setView("skills");
        window.setTimeout(() => {
          searchInputRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
          searchInputRef.current?.focus({ preventScroll: true });
        }, 0);
      }
    }

    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [
    importPickerOpen,
    importedSkill,
    selectedSkillId,
    settingsOpen,
    syncSkillId,
  ]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activeAgentId, view]);

  const availableAgents = useMemo(
    () =>
      data?.agents.filter((agent) => agent.available && agent.visible) || [],
    [data],
  );
  const activeAgent =
    availableAgents.find((agent) => agent.id === activeAgentId) || null;
  const scopedSkills = useMemo(() => {
    if (!data) return [];
    if (activeAgentId === "all") return data.skills;
    return data.skills.filter((skill) =>
      skill.installedAgentIds.includes(activeAgentId),
    );
  }, [activeAgentId, data]);
  const scopedMetrics = useMemo(() => {
    const installations = activeAgent
      ? activeAgent.installationCount
      : data?.totals.installations || 0;
    const synced = scopedSkills.filter(
      (skill) => skill.status === "synced",
    ).length;
    const conflicts = scopedSkills.filter((skill) => skill.conflict).length;
    const incomplete = scopedSkills.filter(
      (skill) => !skill.conflict && skill.missingAgentIds.length > 0,
    ).length;
    const coverage = scopedSkills.length
      ? scopedSkills.reduce((sum, skill) => sum + skill.coverage, 0) /
        scopedSkills.length
      : 0;
    return { installations, synced, conflicts, incomplete, coverage };
  }, [activeAgent, data, scopedSkills]);

  const filteredSkills = useMemo(() => {
    if (!data) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return scopedSkills.filter((skill) => {
      const matchesQuery =
        !normalizedQuery ||
        `${skill.name} ${skill.displayName} ${skill.description} ${skill.tags.join(" ")}`
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      const matchesStatus = status === "all" || skill.status === status;
      return matchesQuery && matchesStatus;
    });
  }, [data, query, scopedSkills, status]);

  const selectedSkill =
    data?.skills.find((skill) => skill.id === selectedSkillId) || null;
  const syncSkill =
    data?.skills.find((skill) => skill.id === syncSkillId) || null;

  async function reveal(instanceId: string) {
    try {
      await requestJson("/api/reveal", {
        method: "POST",
        body: JSON.stringify({ instanceId }),
      });
      setToast("已在文件管理器中定位");
    } catch (revealError) {
      setToast(
        revealError instanceof Error ? revealError.message : "无法打开目录",
      );
    }
  }

  async function saveConfig(nextConfig: ManagerConfig) {
    const saved = await requestJson<ManagerConfig>("/api/config", {
      method: "PUT",
      body: JSON.stringify(nextConfig),
    });
    setConfig(saved);
    setActiveAgentId("all");
    await loadData(true);
    setToast("数据源已更新");
  }

  async function openSkillPackage(file: File) {
    if (!file.name.toLowerCase().endsWith(".skill")) {
      setToast("请选择 .skill 格式的文件");
      return;
    }
    setImporting(true);
    try {
      const response = await fetch(`${API_BASE}/api/import-skill`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-skill-filename": encodeURIComponent(file.name),
        },
        body: file,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "无法读取 .skill 文件。");
      }
      setImportedSkill(payload as ImportedSkill);
      setImportPickerOpen(false);
      setImportDragActive(false);
    } catch (importError) {
      setToast(
        importError instanceof Error ? importError.message : "导入失败。",
      );
    } finally {
      setImporting(false);
    }
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    if (blocksGlobalDrop) return;
    dragDepthRef.current += 1;
    setImportDragActive(true);
    setImportPickerOpen(true);
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    if (blocksGlobalDrop) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    if (blocksGlobalDrop) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setImportDragActive(false);
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (blocksGlobalDrop) {
      setToast("请先关闭当前窗口，再导入 .skill 技能包");
      return;
    }
    dragDepthRef.current = 0;
    setImportDragActive(false);
    const file = [...event.dataTransfer.files].find((item) =>
      item.name.toLowerCase().endsWith(".skill"),
    );
    if (file) {
      void openSkillPackage(file);
    } else {
      setImportPickerOpen(true);
      setToast("这里只支持 .skill 技能包");
    }
  }

  async function exportSkill(instanceId: string) {
    const instance = data?.skills
      .flatMap((skill) => skill.instances)
      .find((item) => item.id === instanceId);
    if (!instance) {
      setToast("找不到要导出的 Skill 实例");
      return;
    }
    try {
      const response = await fetch(
        `${API_BASE}/api/export-skill?instanceId=${encodeURIComponent(instanceId)}`,
      );
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || "打包失败。");
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${instance.directoryName}.skill`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setToast(`${instance.displayName || instance.name} 已打包`);
    } catch (exportError) {
      setToast(
        exportError instanceof Error ? exportError.message : "打包失败。",
      );
    }
  }

  const navItems: { id: ViewName; label: string; code: string; badge?: number }[] =
    [
      { id: "skills", label: "技能总览", code: "01" },
      {
        id: "sync",
        label: "同步中心",
        code: "02",
        badge: data ? data.totals.conflicts + data.totals.incomplete : undefined,
      },
      { id: "sources", label: "工具数据源", code: "03" },
    ];

  return (
    <div
      className="app-shell"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <aside className="sidebar" inert={modalOpen ? true : undefined}>
        <div className="brand">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <span className="brand-copy">
            <strong>技能</strong>
            <small>管理器</small>
          </span>
        </div>

        <nav aria-label="主要导航">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "is-active" : ""}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => {
                setView(item.id);
                if (item.id !== "skills") setActiveAgentId("all");
              }}
            >
              <span>{item.code}</span>
              <strong>{item.label}</strong>
              {item.badge ? <b>{item.badge}</b> : <em>↗</em>}
            </button>
          ))}
        </nav>

        <div className="sidebar-agents">
          <p>本地工具 / 点击切换</p>
          <button
            className={activeAgentId === "all" ? "is-active" : ""}
            aria-pressed={activeAgentId === "all"}
            onClick={() => {
              setActiveAgentId("all");
              setView("skills");
              setQuery("");
              setStatus("all");
            }}
            title="查看全部工具的技能"
          >
            <span className="sidebar-all-agent">全</span>
            <strong>全部技能</strong>
            <i className="online" />
          </button>
          {availableAgents.map((agent) => (
            <button
              key={agent.id}
              className={activeAgentId === agent.id ? "is-active" : ""}
              aria-pressed={activeAgentId === agent.id}
              onClick={() => {
                setActiveAgentId(agent.id);
                setView("skills");
                setQuery("");
                setStatus("all");
              }}
              title={`切换到 ${agent.name} 技能`}
            >
              <span style={{ background: agent.color }}>{agent.shortName}</span>
              <strong>{agent.name}</strong>
              <i className={agent.available ? "online" : ""} />
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <button onClick={() => setSettingsOpen(true)}>
            <span>⌁</span>
            <strong>目录设置</strong>
          </button>
          <div>
            <span className="privacy-dot">●</span>
            <p>
              <strong>仅限本机</strong>
              <small>数据不会离开本机</small>
            </p>
          </div>
        </div>
      </aside>

      <main className="main-area" inert={modalOpen ? true : undefined}>
        <header className="topbar">
          <div className="mobile-brand">技能管理器</div>
          <div className="scan-indicator">
            <span className={serviceError ? "is-error" : ""} />
            <p>
              <strong>{serviceError ? "本地服务未连接" : "本地扫描已就绪"}</strong>
              <small>
                {data
                  ? `上次扫描 ${formatRelativeDate(data.scannedAt)}`
                  : "正在读取技能目录"}
              </small>
            </p>
          </div>
          <div className="topbar-actions">
            <button
              className="import-skill-button"
              onClick={() => setImportPickerOpen(true)}
              disabled={importing}
            >
              <span>＋</span>
              {importing ? "解析中…" : "导入 .skill"}
            </button>
            <button
              className="scan-button"
              onClick={() => void loadData(true)}
              disabled={refreshing}
            >
              <span className={refreshing ? "is-spinning" : ""}>↻</span>
              {refreshing ? "扫描中" : "重新扫描"}
            </button>
            <button
              className="quick-sync-button"
              onClick={() => {
                setActiveAgentId("all");
                setView("sync");
              }}
              disabled={!data}
              title="查看覆盖不完整或存在版本冲突、需要你处理的技能"
            >
              查看待处理技能 <span>→</span>
            </button>
          </div>
        </header>

        <nav className="mobile-nav" aria-label="移动端主要导航">
          {[
            ["skills", "技能", "01"],
            ["sync", "待处理", "02"],
            ["sources", "数据源", "03"],
          ].map(([itemView, label, code]) => (
            <button
              type="button"
              key={itemView}
              className={view === itemView ? "is-active" : ""}
              aria-current={view === itemView ? "page" : undefined}
              onClick={() => {
                setView(itemView as ViewName);
                if (itemView !== "skills") setActiveAgentId("all");
              }}
            >
              <span>{code}</span>
              <strong>{label}</strong>
            </button>
          ))}
          <button
            type="button"
            className={settingsOpen ? "is-active" : ""}
            aria-pressed={settingsOpen}
            onClick={() => setSettingsOpen(true)}
          >
            <span>⌁</span>
            <strong>设置</strong>
          </button>
        </nav>

        {serviceError && (
          <div className="service-error-banner" role="alert">
            <span>!</span>
            <div>
              <strong>无法连接本地扫描服务</strong>
              <p>
                {serviceError} 请重新启动应用；源码开发环境可运行{" "}
                <code>npm run dev</code>，然后重试。
              </p>
            </div>
            <button onClick={() => void loadData(true)}>重试</button>
          </div>
        )}

        {loading ? (
          <div className="loading-screen" role="status">
            <div className="loading-grid">
              <span />
              <span />
              <span />
              <span />
            </div>
            <p>正在建立本地技能索引…</p>
          </div>
        ) : data ? (
          <>
            <AgentDock
              agents={availableAgents}
              activeAgentId={activeAgentId}
              totalSkills={data.totals.uniqueSkills}
              onChange={(agentId) => {
                setActiveAgentId(agentId);
                setView("skills");
                setQuery("");
                setStatus("all");
              }}
              onManage={() => {
                setActiveAgentId("all");
                setView("sources");
                setSettingsOpen(true);
              }}
            />
            {view === "skills" && (
              <div className="skills-view page-enter">
                <section
                  className={`hero ${activeAgent ? "is-agent-focused" : ""}`}
                  style={
                    activeAgent
                      ? ({
                          "--focus-color": activeAgent.color,
                        } as React.CSSProperties)
                      : undefined
                  }
                >
                  <div className="hero-heading">
                    <p className="eyebrow">
                      {activeAgent
                        ? `正在查看 / ${activeAgent.shortName}`
                        : "本地技能管理器"}
                    </p>
                    {activeAgent ? (
                      <>
                        <h1>
                          {activeAgent.name}
                          <br />
                          技能库<span>。</span>
                        </h1>
                        <p>
                          当前只展示安装在 {activeAgent.name} 中的技能。共连接{" "}
                          {activeAgent.roots.filter((root) => root.available).length}{" "}
                          个本地目录，可继续按状态筛选或同步到其他工具。
                        </p>
                      </>
                    ) : (
                      <>
                        <h1>
                          本机技能，
                          <br />
                          全景掌控<span>。</span>
                        </h1>
                        <p>
                          已自动识别 {availableAgents.length} 个智能工具。切换上方工具栏，
                          即可查看每个工具实际安装的技能。
                        </p>
                      </>
                    )}
                  </div>
                  <div className="coverage-display">
                    <div
                      className="coverage-ring"
                      style={
                        {
                          "--coverage": `${Math.round(
                            scopedMetrics.coverage * 100,
                          ) * 3.6}deg`,
                        } as React.CSSProperties
                      }
                    >
                      <div>
                        <strong>
                          {Math.round(scopedMetrics.coverage * 100)}
                          <small>%</small>
                        </strong>
                        <span>跨端覆盖率</span>
                      </div>
                    </div>
                    <p>
                      {scopedMetrics.incomplete
                        ? `${scopedMetrics.incomplete} 个技能可补齐到更多工具`
                        : "所有技能都已覆盖全部工具"}
                    </p>
                  </div>
                </section>

                <section className="metric-strip">
                  <div className="metric-primary">
                    <span>技能总数</span>
                    <strong>{scopedSkills.length}</strong>
                    <small>{scopedMetrics.installations} 个本地安装实例</small>
                  </div>
                  <div>
                    <span>全端一致</span>
                    <strong>{scopedMetrics.synced}</strong>
                    <small>全端一致</small>
                  </div>
                  <div>
                    <span>待补齐</span>
                    <strong>{scopedMetrics.incomplete}</strong>
                    <small>覆盖不完整</small>
                  </div>
                  <div className={scopedMetrics.conflicts ? "metric-alert" : ""}>
                    <span>版本冲突</span>
                    <strong>{scopedMetrics.conflicts}</strong>
                    <small>同名不同内容</small>
                  </div>
                  <div className="agent-stack-metric">
                    <span>本地工具</span>
                    <div>
                      {availableAgents.map((agent) => (
                        <AgentMark
                          key={agent.id}
                          agent={agent}
                          active={agent.available}
                        />
                      ))}
                    </div>
                    <small>{availableAgents.length} 个本机产品</small>
                  </div>
                </section>

                <section className="inventory-section">
                  <div className="inventory-heading">
                    <div>
                      <p className="eyebrow">技能清单</p>
                      <h2>
                        {activeAgent ? `${activeAgent.name} 已安装` : "全部已安装技能"}
                      </h2>
                    </div>
                    <span>
                      {filteredSkills.length} / {scopedSkills.length}
                    </span>
                  </div>

                  <div className="toolbar">
                    <label className="search-box">
                      <span>⌕</span>
                      <input
                        ref={searchInputRef}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="搜索名称、描述或标签…"
                      aria-label="搜索技能"
                      />
                      <kbd>⌘ K</kbd>
                    </label>
                    <div className="filter-tabs" aria-label="状态筛选">
                      {(
                        [
                          ["all", "全部"],
                          ["synced", "已对齐"],
                          ["partial", "待补齐"],
                          ["single", "单端"],
                          ["conflict", "冲突"],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          className={status === value ? "is-active" : ""}
                          aria-pressed={status === value}
                          onClick={() => setStatus(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <SkillTable
                    key={`${activeAgentId}:${query}:${status}:${data.scannedAt}`}
                    skills={filteredSkills}
                    agents={availableAgents}
                    onSelect={(skill) => setSelectedSkillId(skill.id)}
                    onSync={(skill) => setSyncSkillId(skill.id)}
                  />
                </section>
              </div>
            )}

            {view === "sync" && (
              <SyncCenter
                data={data}
                onSync={(skill) => setSyncSkillId(skill.id)}
                onSelect={(skill) => setSelectedSkillId(skill.id)}
              />
            )}

            {view === "sources" && (
              <SourcesView
                data={data}
                onSettings={() => setSettingsOpen(true)}
              />
            )}
          </>
        ) : (
          <EmptyState
            title="还没有扫描结果"
            description="连接本地服务后，技能清单会显示在这里。"
          />
        )}
      </main>

      {selectedSkill && data && (
        <DetailPanel
          key={selectedSkill.id}
          skill={selectedSkill}
          agents={availableAgents}
          onClose={() => setSelectedSkillId(null)}
          onSync={() => {
            setSelectedSkillId(null);
            setSyncSkillId(selectedSkill.id);
          }}
          onReveal={(instanceId) => void reveal(instanceId)}
          onExport={(instanceId) => void exportSkill(instanceId)}
        />
      )}

      {syncSkill && data && (
        <SyncDialog
          skill={syncSkill}
          agents={availableAgents}
          defaultMode={config?.syncMode || "copy"}
          onClose={() => setSyncSkillId(null)}
          onComplete={async () => {
            await loadData(true);
            setToast(`${displaySkillName(syncSkill)} 已同步`);
          }}
        />
      )}

      {settingsOpen && config && (
        <SettingsDialog
          config={config}
          onClose={() => setSettingsOpen(false)}
          onSave={saveConfig}
        />
      )}

      {importPickerOpen && (
        <SkillImportDropDialog
          loading={importing}
          dragActive={importDragActive}
          onClose={() => {
            setImportPickerOpen(false);
            setImportDragActive(false);
            dragDepthRef.current = 0;
          }}
          onFile={(file) => void openSkillPackage(file)}
          onDragStateChange={setImportDragActive}
        />
      )}

      {importedSkill && data && (
        <ImportSkillDialog
          key={importedSkill.importId}
          imported={importedSkill}
          agents={availableAgents}
          onClose={() => setImportedSkill(null)}
          onInstalled={async () => {
            await loadData(true);
            setToast(`${importedSkill.displayName} 已安装`);
          }}
        />
      )}

      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}
