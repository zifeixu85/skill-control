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
    const activeDialog = dialogRef.current;
    if (!activeDialog) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const getFocusableElements = () =>
      [...activeDialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) =>
          !element.hasAttribute("disabled") &&
          element.getAttribute("aria-hidden") !== "true" &&
          element.tabIndex >= 0 &&
          window.getComputedStyle(element).visibility !== "hidden",
      );
    const focusFrame = window.requestAnimationFrame(() => {
      (getFocusableElements()[0] || activeDialog).focus();
    });

    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements();
      if (!focusable.length) {
        event.preventDefault();
        activeDialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!activeDialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

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
type ViewName = "skills" | "sync" | "capabilities" | "sources" | "connectors";

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
  hash: string;
  shortHash: string;
  fileCount: number;
  byteCount: number;
  modifiedAt: string | null;
  isSymlink: boolean;
  readOnly?: boolean;
  sourceLabel?: string;
};

type Skill = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  tags: string[];
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
  mimeType: string | null;
  previewKind: "text" | "image" | "unavailable";
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

type CapabilityMember = {
  id: string;
  name: string;
  displayName: string;
  profession: string;
  description: string;
  maxTurns: number | null;
  filePath: string;
};

type Capability = {
  id: string;
  productId: "workbuddy" | "hermes";
  productName: string;
  productShortName: string;
  productColor: string;
  kind: "expert" | "expert-team" | "agent-profile";
  kindLabel: string;
  name: string;
  displayName: string;
  description: string;
  profession: string;
  version: string;
  tags: string[];
  members: CapabilityMember[];
  memberCount: number;
  fileCount: number;
  connectorCount: number;
  skillCount: number;
  model: string;
  maxTurns?: number | null;
  delegation?: {
    enabled: boolean;
    maxConcurrentChildren: number | null;
    maxSpawnDepth: number | null;
  };
  sourcePath: string;
  primaryFilePath: string;
  modifiedAt: string;
};

type CapabilityProduct = {
  id: "workbuddy" | "hermes";
  name: string;
  shortName: string;
  color: string;
  kindLabel: string;
  sourcePath: string;
  available: boolean;
  catalogCount: number;
  itemCount: number;
  memberCount: number;
  items: Capability[];
};

type CapabilityCatalog = {
  products: CapabilityProduct[];
  totals: {
    products: number;
    profiles: number;
    members: number;
  };
  scannedAt: string;
};

type CapabilityFileListing = {
  entries: SkillFileEntry[];
  fileCount: number;
  directoryCount: number;
  truncated: boolean;
  capability: Capability;
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
  dismissedAgentIds: string[];
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

type SkillDiffChange =
  | "modified"
  | "left-only"
  | "right-only"
  | "type-changed";

type SkillDiffEntrySide = {
  type: "file" | "symlink";
  size: number;
  modifiedAt: string;
  language: string | null;
  mimeType: string | null;
  linkTarget: string | null;
};

type SkillDiffEntry = {
  path: string;
  name: string;
  change: SkillDiffChange;
  left: SkillDiffEntrySide | null;
  right: SkillDiffEntrySide | null;
};

type SkillDiffInstance = {
  id: string;
  agentId: string;
  agentName: string;
  shortHash: string;
  modifiedAt: string | null;
  fileCount: number;
  byteCount: number;
};

type SkillDiffSummary = {
  skillId: string;
  skillName: string;
  left: SkillDiffInstance;
  right: SkillDiffInstance;
  summary: {
    modified: number;
    leftOnly: number;
    rightOnly: number;
    typeChanged: number;
    unchanged: number;
    total: number;
  };
  entries: SkillDiffEntry[];
  truncated: boolean;
};

type SkillDiffLine = {
  kind: "context" | "added" | "removed" | "skip";
  text: string;
  leftNumber: number | null;
  rightNumber: number | null;
};

type SkillDiffFile = {
  path: string;
  name: string;
  previewKind: "text" | "image" | "unavailable";
  left: SkillFileContent | null;
  right: SkillFileContent | null;
  leftLinkTarget: string | null;
  rightLinkTarget: string | null;
  lines: SkillDiffLine[];
  truncated: boolean;
  reason: string | null;
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

const DIFF_CHANGE_COPY: Record<
  SkillDiffChange,
  { label: string; symbol: string }
> = {
  modified: { label: "已修改", symbol: "±" },
  "left-only": { label: "仅候选版本", symbol: "+" },
  "right-only": { label: "仅对比版本", symbol: "−" },
  "type-changed": { label: "类型变化", symbol: "↻" },
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

function isImagePath(pathname: string) {
  return /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(pathname);
}

function defaultPreviewMode(pathname: string) {
  return isMarkdownPath(pathname) || isImagePath(pathname)
    ? "rendered"
    : "source";
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

function SkillImagePreview({
  source,
  name,
}: {
  source: string;
  name: string;
}) {
  const [preview, setPreview] = useState<{
    source: string;
    objectUrl: string;
    error: string;
  }>({ source: "", objectUrl: "", error: "" });
  const [dimensions, setDimensions] = useState("");

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";

    async function loadImage() {
      try {
        const response = await fetch(source);
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error || `图片读取失败（${response.status}）`);
        }
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setPreview({ source, objectUrl, error: "" });
      } catch (error) {
        if (cancelled) return;
        setPreview({
          source,
          objectUrl: "",
          error: error instanceof Error ? error.message : "图片读取失败。",
        });
      }
    }

    void loadImage();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source]);

  const currentPreview = preview.source === source ? preview : null;

  if (currentPreview?.error) {
    return (
      <div className="browser-empty-state">
        <strong>无法渲染这张图片</strong>
        <p>{currentPreview.error}</p>
      </div>
    );
  }

  if (!currentPreview?.objectUrl) {
    return (
      <div className="browser-loading browser-loading-content">
        正在加载图片预览…
      </div>
    );
  }

  return (
    <figure className="skill-image-preview">
      <div className="skill-image-stage">
        {/* Local user-selected assets need their original bytes and dynamic loopback URL. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={currentPreview.objectUrl}
          alt={`${name} 预览`}
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget;
            setDimensions(`${image.naturalWidth} × ${image.naturalHeight} px`);
          }}
          onError={() =>
            setPreview({
              source,
              objectUrl: "",
              error: "浏览器无法解码这张图片，文件格式可能不完整。",
            })
          }
        />
      </div>
      <figcaption>
        <span>图片预览</span>
        {dimensions && <code>{dimensions}</code>}
      </figcaption>
    </figure>
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
        compact ? "is-compact" : ""
      }`}
      style={{ "--agent-color": agent.color } as React.CSSProperties}
      title={`${agent.name}：${active ? (conflict ? "内容有差异" : "已安装") : "未安装"}`}
      aria-label={`${agent.name}${
        active ? (conflict ? "已安装，内容有差异" : "已安装") : "未安装"
      }`}
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
                  <span className="skill-index">
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
  initialInstanceId,
  reviewMode = false,
  onClose,
  onSync,
  onReveal,
  onExport,
}: {
  skill: Skill;
  agents: Agent[];
  initialInstanceId?: string;
  reviewMode?: boolean;
  onClose: () => void;
  onSync: (instanceId: string) => void;
  onReveal: (instanceId: string) => void;
  onExport: (
    instanceId: string,
    format: "skill" | "zip",
  ) => Promise<void>;
}) {
  const dialogRef = useModalFocus<HTMLElement>();
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const instancesByAgent = new Map(
    skill.instances.map((instance) => [instance.agentId, instance]),
  );
  const initialInstance =
    skill.instances.find((instance) => instance.id === initialInstanceId) ||
    skill.instances[0];
  const [activeInstanceId, setActiveInstanceId] = useState(
    initialInstance?.id || "",
  );
  const [fileListing, setFileListing] = useState<SkillFileListing | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [fileContent, setFileContent] = useState<SkillFileContent | null>(null);
  const [listingLoading, setListingLoading] = useState(
    Boolean(initialInstance),
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
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<
    "skill" | "zip" | null
  >(null);
  const activeInstance = skill.instances.find(
    (instance) => instance.id === activeInstanceId,
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
    if (!exportMenuOpen) return;
    function closeExportMenu(event: PointerEvent) {
      if (
        exportMenuRef.current &&
        !exportMenuRef.current.contains(event.target as Node)
      ) {
        setExportMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeExportMenu);
    return () => document.removeEventListener("pointerdown", closeExportMenu);
  }, [exportMenuOpen]);

  async function exportActiveInstance(format: "skill" | "zip") {
    if (!activeInstanceId || exportingFormat) return;
    setExportingFormat(format);
    try {
      await onExport(activeInstanceId, format);
      setExportMenuOpen(false);
    } finally {
      setExportingFormat(null);
    }
  }

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
        setPreviewMode(defaultPreviewMode(defaultPath));
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

  const imagePreviewSource =
    fileContent?.previewKind === "image" && activeInstanceId
      ? `${API_BASE}/api/skill-asset?instanceId=${encodeURIComponent(activeInstanceId)}&path=${encodeURIComponent(fileContent.path)}`
      : "";
  const supportsSourceToggle = Boolean(
    fileContent?.previewable &&
      (isMarkdownPath(fileContent.path) ||
        (fileContent.mimeType === "image/svg+xml" && fileContent.content)),
  );

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
    setPreviewMode(defaultPreviewMode(filePath));
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
          <span>
            {reviewMode
              ? `版本预览 · ${activeInstance?.agentName || "当前版本"}`
              : "技能详情"}
          </span>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label={reviewMode ? "返回冲突处理" : "关闭详情"}
          >
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
                              {entry.type === "symlink"
                                ? "↗"
                                : isImagePath(entry.path)
                                  ? "▧"
                                  : "·"}
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
                          {fileContent.mimeType || fileContent.language} ·{" "}
                          {formatBytes(fileContent.size)} ·{" "}
                          {formatRelativeDate(fileContent.modifiedAt)}
                        </span>
                      )}
                    </div>
                    <div className="file-preview-tools">
                      {supportsSourceToggle ? (
                        <div
                          className="file-view-toggle"
                          aria-label="文件显示方式"
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
                    } ${
                      fileContent?.previewKind === "image" ? "is-media" : ""
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
                      fileContent.previewKind === "image" &&
                      previewMode === "rendered" &&
                      imagePreviewSource ? (
                        <SkillImagePreview
                          key={imagePreviewSource}
                          source={imagePreviewSource}
                          name={fileContent.name}
                        />
                      ) : isMarkdownPath(fileContent.path) &&
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
                            {instance.sourceLabel && <em>{instance.sourceLabel}{instance.readOnly ? " · 只读" : ""}</em>}
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
            {reviewMode ? "返回冲突处理" : "关闭"}
          </button>
          <div className="export-format-control" ref={exportMenuRef}>
            {exportMenuOpen && (
              <div
                className="export-format-menu"
                role="menu"
                aria-label="选择 Skill 导出格式"
              >
                <div className="export-format-heading">
                  <strong>选择导出格式</strong>
                  <span>文件内容与目录结构保持一致</span>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void exportActiveInstance("skill")}
                  disabled={Boolean(exportingFormat)}
                >
                  <span className="export-format-mark">SKILL</span>
                  <span>
                    <strong>.skill 技能包</strong>
                    <small>适合支持 .skill 导入的工具</small>
                  </span>
                  <b>{exportingFormat === "skill" ? "…" : "→"}</b>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void exportActiveInstance("zip")}
                  disabled={Boolean(exportingFormat)}
                >
                  <span className="export-format-mark is-zip">ZIP</span>
                  <span>
                    <strong>.zip 通用压缩包</strong>
                    <small>解压后可手动安装到任意 Agent</small>
                  </span>
                  <b>{exportingFormat === "zip" ? "…" : "→"}</b>
                </button>
              </div>
            )}
            <button
              type="button"
              className={`button button-ghost export-format-trigger ${
                exportMenuOpen ? "is-open" : ""
              }`}
              onClick={() => setExportMenuOpen((current) => !current)}
              disabled={!activeInstanceId || Boolean(exportingFormat)}
              aria-expanded={exportMenuOpen}
              aria-haspopup="menu"
            >
              {exportingFormat ? "导出中…" : "导出"}
              <svg
                className="export-format-chevron"
                viewBox="0 0 12 12"
                aria-hidden="true"
              >
                <path
                  d={
                    exportMenuOpen
                      ? "M2.5 4.25 6 7.75l3.5-3.5"
                      : "M2.5 7.75 6 4.25l3.5 3.5"
                  }
                />
              </svg>
            </button>
          </div>
          <button
            className="button button-acid"
            onClick={() => onSync(activeInstanceId)}
          >
            {reviewMode
              ? "采用此版本"
              : skill.conflict
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

function SkillDiffView({
  skill,
  agents,
  leftInstanceId,
  initialRightInstanceId,
  onBack,
  onChooseSource,
}: {
  skill: Skill;
  agents: Agent[];
  leftInstanceId: string;
  initialRightInstanceId: string;
  onBack: () => void;
  onChooseSource: (instanceId: string) => void;
}) {
  const [rightInstanceId, setRightInstanceId] = useState(
    initialRightInstanceId,
  );
  const [summary, setSummary] = useState<SkillDiffSummary | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [fileDiff, setFileDiff] = useState<SkillDiffFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState("");
  const leftInstance = skill.instances.find(
    (instance) => instance.id === leftInstanceId,
  );
  const rightInstance = skill.instances.find(
    (instance) => instance.id === rightInstanceId,
  );
  const leftAgent = agents.find(
    (agent) => agent.id === leftInstance?.agentId,
  );
  const rightAgent = agents.find(
    (agent) => agent.id === rightInstance?.agentId,
  );
  const comparisonInstances = skill.instances.filter(
    (instance) => instance.id !== leftInstanceId,
  );

  useEffect(() => {
    let cancelled = false;

    async function loadComparison() {
      try {
        const nextSummary = await requestJson<SkillDiffSummary>(
          `/api/skill-diff?leftInstanceId=${encodeURIComponent(leftInstanceId)}&rightInstanceId=${encodeURIComponent(rightInstanceId)}`,
        );
        if (cancelled) return;
        setSummary(nextSummary);
        setError("");
        const preferredEntry =
          nextSummary.entries.find(
            (entry) => entry.path.toLowerCase() === "skill.md",
          ) || nextSummary.entries[0];
        if (!preferredEntry) {
          setSelectedPath("");
          setFileDiff(null);
          setLoading(false);
          return;
        }
        setSelectedPath(preferredEntry.path);
        const nextFileDiff = await requestJson<SkillDiffFile>(
          `/api/skill-diff-file?leftInstanceId=${encodeURIComponent(leftInstanceId)}&rightInstanceId=${encodeURIComponent(rightInstanceId)}&path=${encodeURIComponent(preferredEntry.path)}`,
        );
        if (cancelled) return;
        setFileDiff(nextFileDiff);
        setLoading(false);
      } catch (requestError) {
        if (cancelled) return;
        setError(
          requestError instanceof Error
            ? requestError.message
            : "无法读取版本差异。",
        );
        setLoading(false);
      }
    }

    void loadComparison();
    return () => {
      cancelled = true;
    };
  }, [leftInstanceId, rightInstanceId]);

  async function selectFile(entryPath: string) {
    setSelectedPath(entryPath);
    setFileLoading(true);
    setError("");
    try {
      const nextFileDiff = await requestJson<SkillDiffFile>(
        `/api/skill-diff-file?leftInstanceId=${encodeURIComponent(leftInstanceId)}&rightInstanceId=${encodeURIComponent(rightInstanceId)}&path=${encodeURIComponent(entryPath)}`,
      );
      setFileDiff(nextFileDiff);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "无法读取文件差异。",
      );
    } finally {
      setFileLoading(false);
    }
  }

  function changeComparison(nextInstanceId: string) {
    setRightInstanceId(nextInstanceId);
    setSummary(null);
    setSelectedPath("");
    setFileDiff(null);
    setLoading(true);
    setFileLoading(false);
    setError("");
  }

  const changedCount = summary
    ? summary.summary.modified +
      summary.summary.leftOnly +
      summary.summary.rightOnly +
      summary.summary.typeChanged
    : 0;
  const diffAssetUrl = (instanceId: string) =>
    `${API_BASE}/api/skill-asset?instanceId=${encodeURIComponent(instanceId)}&path=${encodeURIComponent(fileDiff?.path || "")}`;

  return (
    <div className="skill-diff-view">
      <header className="skill-diff-heading">
        <button className="diff-back-button" onClick={onBack}>
          ← 返回同步设置
        </button>
        <div>
          <p className="eyebrow">内容级比较</p>
          <h2>{displaySkillName(skill)}</h2>
          <p>绿色“+”属于候选权威版本，红色“−”属于对比版本。</p>
        </div>
      </header>

      <div className="diff-version-bar">
        <div className="diff-version-card is-candidate">
          <small>候选权威版本</small>
          {leftAgent && <AgentMark agent={leftAgent} active compact />}
          <span>
            <strong>{leftAgent?.name || leftInstance?.agentName}</strong>
            <code>{leftInstance?.shortHash}</code>
          </span>
        </div>
        <span className="diff-versus" aria-hidden>
          对比
        </span>
        <label className="diff-version-picker">
          <span>比较对象</span>
          <select
            value={rightInstanceId}
            onChange={(event) => changeComparison(event.target.value)}
          >
            {comparisonInstances.map((instance) => (
              <option value={instance.id} key={instance.id}>
                {instance.agentName} · {instance.shortHash}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="diff-summary-strip" aria-label="差异概览">
        <div>
          <strong>{loading ? "…" : changedCount}</strong>
          <span>差异文件</span>
        </div>
        <div>
          <strong>{loading ? "…" : summary?.summary.modified || 0}</strong>
          <span>内容修改</span>
        </div>
        <div>
          <strong>{loading ? "…" : summary?.summary.leftOnly || 0}</strong>
          <span>仅候选版本</span>
        </div>
        <div>
          <strong>{loading ? "…" : summary?.summary.rightOnly || 0}</strong>
          <span>仅对比版本</span>
        </div>
        <div>
          <strong>{loading ? "…" : summary?.summary.unchanged || 0}</strong>
          <span>内容一致</span>
        </div>
      </div>

      <div className="skill-diff-workspace">
        <aside className="diff-file-list" aria-label="差异文件">
          <div className="diff-pane-label">
            <span>差异文件</span>
            <b>{summary?.entries.length || 0}</b>
          </div>
          {loading ? (
            <p className="diff-loading">正在逐个核对文件内容…</p>
          ) : summary?.entries.length ? (
            summary.entries.map((entry) => (
              <button
                className={`diff-file-item change-${entry.change} ${
                  selectedPath === entry.path ? "is-active" : ""
                }`}
                key={entry.path}
                onClick={() => selectFile(entry.path)}
                aria-pressed={selectedPath === entry.path}
              >
                <span>{DIFF_CHANGE_COPY[entry.change].symbol}</span>
                <span>
                  <strong>{entry.name}</strong>
                  <small>{entry.path}</small>
                </span>
                <em>{DIFF_CHANGE_COPY[entry.change].label}</em>
              </button>
            ))
          ) : (
            <div className="diff-empty">
              <strong>文件内容一致</strong>
              <p>没有发现新增、删除或修改的文件。</p>
            </div>
          )}
          {summary?.truncated && (
            <p className="diff-limit-note">目录较大，列表按安全上限截断。</p>
          )}
        </aside>

        <section className="diff-file-viewer" aria-live="polite">
          {error ? (
            <div className="diff-empty is-error">
              <strong>无法显示差异</strong>
              <p>{error}</p>
            </div>
          ) : fileLoading || (loading && !fileDiff) ? (
            <div className="diff-empty">
              <strong>正在分析文件</strong>
              <p>比较文本行、文件大小与媒体类型…</p>
            </div>
          ) : fileDiff ? (
            <>
              <div className="diff-file-toolbar">
                <span>
                  <strong>{fileDiff.name}</strong>
                  <code>{fileDiff.path}</code>
                </span>
                <small>
                  {fileDiff.previewKind === "text"
                    ? "逐行差异"
                    : fileDiff.previewKind === "image"
                      ? "并排预览"
                      : "文件信息"}
                </small>
              </div>
              {fileDiff.previewKind === "text" ? (
                <div className="text-diff">
                  <div className="text-diff-legend">
                    <span>
                      <b>−</b> {rightAgent?.name || rightInstance?.agentName}
                    </span>
                    <span>
                      <b>+</b> {leftAgent?.name || leftInstance?.agentName}
                    </span>
                  </div>
                  <div className="text-diff-lines">
                    {fileDiff.lines.map((line, index) => (
                      <div
                        className={`text-diff-line is-${line.kind}`}
                        key={`${line.kind}-${line.leftNumber}-${line.rightNumber}-${index}`}
                      >
                        <span>{line.leftNumber ?? ""}</span>
                        <span>{line.rightNumber ?? ""}</span>
                        <b>
                          {line.kind === "added"
                            ? "+"
                            : line.kind === "removed"
                              ? "−"
                              : line.kind === "skip"
                                ? "⋯"
                                : ""}
                        </b>
                        <code>{line.text || " "}</code>
                      </div>
                    ))}
                  </div>
                  {fileDiff.truncated && (
                    <p className="diff-limit-note">
                      文件较长，当前展示前 2,000 行的差异。
                    </p>
                  )}
                </div>
              ) : fileDiff.previewKind === "image" ? (
                <div className="image-diff-grid">
                  <article>
                    <header>
                      <span>候选权威版本</span>
                      <strong>{leftAgent?.name}</strong>
                    </header>
                    {fileDiff.left ? (
                      <SkillImagePreview
                        source={diffAssetUrl(leftInstanceId)}
                        name={`${fileDiff.name} · ${leftAgent?.name}`}
                      />
                    ) : (
                      <div className="diff-media-missing">此版本没有该图片</div>
                    )}
                  </article>
                  <article>
                    <header>
                      <span>对比版本</span>
                      <strong>{rightAgent?.name}</strong>
                    </header>
                    {fileDiff.right ? (
                      <SkillImagePreview
                        source={diffAssetUrl(rightInstanceId)}
                        name={`${fileDiff.name} · ${rightAgent?.name}`}
                      />
                    ) : (
                      <div className="diff-media-missing">此版本没有该图片</div>
                    )}
                  </article>
                </div>
              ) : (
                <div className="binary-diff">
                  <strong>暂不支持内容级预览</strong>
                  <p>{fileDiff.reason}</p>
                  <div>
                    <span>
                      <b>{leftAgent?.name}</b>
                      <small>
                        {fileDiff.left
                          ? formatBytes(fileDiff.left.size)
                          : fileDiff.leftLinkTarget || "不存在"}
                      </small>
                    </span>
                    <span>
                      <b>{rightAgent?.name}</b>
                      <small>
                        {fileDiff.right
                          ? formatBytes(fileDiff.right.size)
                          : fileDiff.rightLinkTarget || "不存在"}
                      </small>
                    </span>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="diff-empty">
              <strong>选择一个文件</strong>
              <p>这里会显示具体修改内容。</p>
            </div>
          )}
        </section>
      </div>

      <footer className="diff-actions">
        <p>根据实际内容决定哪个版本作为后续同步来源。</p>
        <button className="button button-ghost" onClick={onBack}>
          暂不决定
        </button>
        <button
          className="button diff-source-button"
          style={
            {
              "--agent-color": rightAgent?.color || "#c8cac1",
            } as React.CSSProperties
          }
          onClick={() => onChooseSource(rightInstanceId)}
        >
          采用 {rightAgent?.name || "对比版本"}
        </button>
        <button
          className="button diff-source-button"
          style={
            {
              "--agent-color": leftAgent?.color || "#c8cac1",
            } as React.CSSProperties
          }
          onClick={() => onChooseSource(leftInstanceId)}
        >
          采用 {leftAgent?.name || "候选版本"} →
        </button>
      </footer>
    </div>
  );
}

function SyncDialog({
  skill,
  agents,
  defaultMode,
  initialSourceId,
  onClose,
  onReviewInstance,
  onComplete,
}: {
  skill: Skill;
  agents: Agent[];
  defaultMode: "copy" | "symlink";
  initialSourceId?: string;
  onClose: () => void;
  onReviewInstance: (instanceId: string, sourceInstanceId: string) => void;
  onComplete: () => Promise<void>;
}) {
  const dialogRef = useModalFocus<HTMLElement>();
  const newestInstance = skill.instances[0];
  const initialSource =
    skill.instances.find((instance) => instance.id === initialSourceId) ||
    newestInstance;
  const visibleMissingAgentIds = skill.missingAgentIds.filter((agentId) =>
    agents.some((agent) => agent.id === agentId),
  );
  const [sourceId, setSourceId] = useState(initialSource?.id || "");
  const [targetIds, setTargetIds] = useState<string[]>(
    visibleMissingAgentIds.length
      ? visibleMissingAgentIds
      : agents
          .filter((agent) => agent.id !== initialSource?.agentId)
          .map((agent) => agent.id),
  );
  const [mode, setMode] = useState<"copy" | "symlink">(defaultMode);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);
  const [diffPair, setDiffPair] = useState<{
    leftInstanceId: string;
    rightInstanceId: string;
  } | null>(null);

  const source = skill.instances.find((instance) => instance.id === sourceId);
  const comparisonInstance =
    skill.instances.find(
      (instance) =>
        instance.id !== sourceId && instance.hash !== source?.hash,
    ) || skill.instances.find((instance) => instance.id !== sourceId);

  function selectSource(nextSourceId: string) {
    const nextSource = skill.instances.find(
      (instance) => instance.id === nextSourceId,
    );
    const previousSource = skill.instances.find(
      (instance) => instance.id === sourceId,
    );
    if (!nextSource) return;
    setSourceId(nextSourceId);
    setTargetIds((current) => {
      const nextTargets = current.filter(
        (agentId) => agentId !== nextSource.agentId,
      );
      if (
        previousSource &&
        previousSource.agentId !== nextSource.agentId &&
        agents.some((agent) => agent.id === previousSource.agentId) &&
        !nextTargets.includes(previousSource.agentId)
      ) {
        nextTargets.push(previousSource.agentId);
      }
      return nextTargets;
    });
    setPlan(null);
  }

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
        className={`sync-dialog ${diffPair ? "is-diff-view" : ""}`}
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
        ) : diffPair ? (
          <SkillDiffView
            key={`${diffPair.leftInstanceId}:${diffPair.rightInstanceId}`}
            skill={skill}
            agents={agents}
            leftInstanceId={diffPair.leftInstanceId}
            initialRightInstanceId={diffPair.rightInstanceId}
            onBack={() => setDiffPair(null)}
            onChooseSource={(instanceId) => {
              selectSource(instanceId);
              setDiffPair(null);
            }}
          />
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
                      <div className="source-option-row" key={instance.id}>
                        <label
                          className={`source-option ${
                            sourceId === instance.id ? "is-selected" : ""
                          }`}
                        >
                          <input
                            type="radio"
                            name="source"
                            value={instance.id}
                            checked={sourceId === instance.id}
                            onChange={() => selectSource(instance.id)}
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
                        <button
                          className="source-review-button"
                          onClick={() =>
                            onReviewInstance(instance.id, sourceId)
                          }
                        >
                          查看版本
                        </button>
                      </div>
                    );
                  })}
                </div>
                {comparisonInstance && source && (
                  <button
                    className="diff-launch-button"
                    onClick={() =>
                      setDiffPair({
                        leftInstanceId: source.id,
                        rightInstanceId: comparisonInstance.id,
                      })
                    }
                  >
                    <span aria-hidden>≠</span>
                    <span>
                      <strong>高级比较</strong>
                      <small>
                        需要时查看文件增删和文本逐行变化
                      </small>
                    </span>
                    <b>→</b>
                  </button>
                )}
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
    defaultPreviewMode(firstFilePath),
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

  const imagePreviewSource =
    fileContent?.previewKind === "image"
      ? `${API_BASE}/api/import-asset?importId=${encodeURIComponent(imported.importId)}&path=${encodeURIComponent(fileContent.path)}`
      : "";
  const supportsSourceToggle = Boolean(
    fileContent?.previewable &&
      (isMarkdownPath(fileContent.path) ||
        (fileContent.mimeType === "image/svg+xml" && fileContent.content)),
  );

  function selectFile(filePath: string) {
    if (filePath === selectedFilePath) return;
    setSelectedFilePath(filePath);
    setFileContent(null);
    setError("");
    setContentLoading(true);
    setPreviewMode(defaultPreviewMode(filePath));
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
                        <span aria-hidden>
                          {isImagePath(entry.path) ? "▧" : "·"}
                        </span>
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
                        {fileContent.mimeType || fileContent.language} ·{" "}
                        {formatBytes(fileContent.size)}
                      </span>
                    )}
                  </div>
                  {supportsSourceToggle ? (
                    <div
                      className="file-view-toggle"
                      aria-label="文件显示方式"
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
                  fileContent.previewKind === "image" &&
                  previewMode === "rendered" &&
                  imagePreviewSource ? (
                    <div className="skill-file-body is-media">
                      <SkillImagePreview
                        key={imagePreviewSource}
                        source={imagePreviewSource}
                        name={fileContent.name}
                      />
                    </div>
                  ) : isMarkdownPath(fileContent.path) &&
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
  const [isAddingAgent, setIsAddingAgent] = useState(false);
  const [addAgentError, setAddAgentError] = useState("");
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  const [newAgent, setNewAgent] = useState({
    name: "",
    shortName: "",
    color: "#78d4c7",
    paths: "",
  });
  const agentListRef = useRef<HTMLDivElement>(null);
  const addAgentNameRef = useRef<HTMLInputElement>(null);

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

  function openAddAgent() {
    setIsAddingAgent(true);
    setAddAgentError("");
    window.requestAnimationFrame(() => {
      agentListRef.current?.scrollTo({
        top: agentListRef.current.scrollHeight,
        behavior: "smooth",
      });
      addAgentNameRef.current?.focus();
    });
  }

  function cancelAddAgent() {
    setIsAddingAgent(false);
    setAddAgentError("");
    setNewAgent({
      name: "",
      shortName: "",
      color: "#78d4c7",
      paths: "",
    });
  }

  function addAgent() {
    const name = newAgent.name.trim();
    const paths = newAgent.paths
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);

    if (!name) {
      setAddAgentError("请填写工具名称。");
      addAgentNameRef.current?.focus();
      return;
    }
    if (paths.length === 0) {
      setAddAgentError("请至少填写一个技能目录。");
      return;
    }

    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
    const usedIds = new Set(draft.agents.map((agent) => agent.id));
    const baseId = slug || "custom-agent";
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;

    const compactName = name.replace(/\s+/g, "");
    const shortName =
      newAgent.shortName.trim().slice(0, 3).toUpperCase() ||
      compactName.slice(0, 2).toUpperCase() ||
      "AG";

    setDraft((current) => ({
      ...current,
      agents: [
        ...current.agents,
        {
          id,
          name,
          shortName,
          color: newAgent.color,
          paths,
        },
      ],
      visibleAgentIds: [...new Set([...current.visibleAgentIds, id])],
      dismissedAgentIds: (current.dismissedAgentIds || []).filter(
        (agentId) => agentId !== id,
      ),
    }));
    cancelAddAgent();
    window.requestAnimationFrame(() => {
      agentListRef.current?.scrollTo({
        top: agentListRef.current.scrollHeight,
        behavior: "smooth",
      });
    });
  }

  function removeAgent(agentId: string) {
    setDraft((current) => {
      const agents = current.agents.filter((agent) => agent.id !== agentId);
      const remainingVisibleIds = current.visibleAgentIds.filter(
        (id) => id !== agentId,
      );
      return {
        ...current,
        agents,
        visibleAgentIds:
          remainingVisibleIds.length > 0
            ? remainingVisibleIds
            : agents.slice(0, 1).map((agent) => agent.id),
        dismissedAgentIds: [
          ...new Set([...(current.dismissedAgentIds || []), agentId]),
        ],
      };
    });
    setPendingRemovalId(null);
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

  function setAgentVisibilityPreset(preset: "default" | "all") {
    setDraft((current) => {
      if (preset === "all") {
        return {
          ...current,
          visibleAgentIds: current.agents.map((agent) => agent.id),
        };
      }
      const preferredIds = ["codex", "claude"].filter((id) =>
        current.agents.some((agent) => agent.id === id),
      );
      return {
        ...current,
        visibleAgentIds:
          preferredIds.length > 0
            ? preferredIds
            : current.agents.slice(0, 1).map((agent) => agent.id),
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
          <span>产品与目录</span>
          <button className="icon-button" onClick={onClose} aria-label="关闭设置">
            ×
          </button>
        </div>
        <div className="settings-heading">
          <p className="eyebrow">Skills 数据源</p>
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
          <div className="agent-visibility-guide">
            <div className="agent-visibility-guide-copy">
              <span aria-hidden="true">◉</span>
              <div>
                <strong>
                  已显示 {draft.visibleAgentIds.length} / {draft.agents.length} 个工具
                </strong>
                <p>
                  隐藏只收起技能列表与安装入口，仍会扫描本地目录，也不会删除文件。
                </p>
              </div>
            </div>
            <div className="agent-visibility-presets" aria-label="快捷设置工具显示范围">
              <button
                type="button"
                onClick={() => setAgentVisibilityPreset("default")}
                disabled={
                  draft.visibleAgentIds.length ===
                    ["codex", "claude"].filter((id) =>
                      draft.agents.some((agent) => agent.id === id),
                    ).length &&
                  draft.visibleAgentIds.every((id) =>
                    ["codex", "claude"].includes(id),
                  )
                }
              >
                仅 Codex + Claude
              </button>
              <button
                type="button"
                onClick={() => setAgentVisibilityPreset("all")}
                disabled={
                  draft.visibleAgentIds.length === draft.agents.length
                }
              >
                全部显示
              </button>
            </div>
          </div>
        </div>
        <div className="agent-config-list" ref={agentListRef}>
          {draft.agents.map((agent, index) => {
            const isVisible = draft.visibleAgentIds.includes(agent.id);
            const isOnlyVisibleAgent =
              isVisible && draft.visibleAgentIds.length === 1;
            return (
              <article
                className={`agent-config-card ${
                  pendingRemovalId === agent.id ? "is-pending-removal" : ""
                } ${isVisible ? "is-visible" : "is-hidden"}`}
                key={`${agent.id}-${index}`}
                style={{ "--agent-color": agent.color } as React.CSSProperties}
              >
                <div className="config-accent" />
                <div className="agent-config-toolbar">
                  <span>{agent.id}</span>
                  <button
                    type="button"
                    className={`agent-visibility-toggle ${
                      isVisible ? "is-on" : "is-off"
                    }`}
                    role="switch"
                    aria-checked={isVisible}
                    aria-label={`${isVisible ? "隐藏" : "显示"} ${agent.name}`}
                    onClick={() => toggleAgentVisibility(agent.id)}
                    disabled={isOnlyVisibleAgent}
                    title={
                      isOnlyVisibleAgent
                        ? "至少保留一个显示中的工具"
                        : isVisible
                          ? "点击后从技能列表与安装目标中隐藏"
                          : "点击后在技能列表与安装目标中显示"
                    }
                  >
                    <span className="visibility-switch-track" aria-hidden="true">
                      <i />
                    </span>
                    <span className="visibility-switch-copy">
                      <strong>{isVisible ? "已显示" : "已隐藏"}</strong>
                      <small>
                        {isVisible
                          ? "列表与安装目标可见"
                          : "仍会扫描本地目录"}
                      </small>
                    </span>
                  </button>
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
                  <span title="只用于区分工具，不表示运行状态">身份色</span>
                  <input
                    type="color"
                    value={agent.color}
                    onChange={(event) =>
                      updateAgent(index, { color: event.target.value })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="remove-agent"
                  onClick={() => setPendingRemovalId(agent.id)}
                  disabled={draft.agents.length <= 1}
                  aria-label={`移除 ${agent.name}`}
                  title={
                    draft.agents.length <= 1
                      ? "至少保留一个工具"
                      : `移除 ${agent.name}`
                  }
                >
                  <span aria-hidden="true">−</span>
                  移除
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
              {pendingRemovalId === agent.id && (
                <div className="remove-agent-confirm" role="alert">
                  <div>
                    <strong>从管理器中移除 {agent.name}？</strong>
                    <p>
                      只移除工具配置，不会删除
                      {agent.paths.length === 1
                        ? ` ${agent.paths[0]}`
                        : "这些目录中"}
                      的 Skill 文件。
                    </p>
                  </div>
                  <div className="remove-agent-confirm-actions">
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => setPendingRemovalId(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="button button-danger"
                      onClick={() => removeAgent(agent.id)}
                    >
                      确认移除
                    </button>
                  </div>
                </div>
              )}
              </article>
            );
          })}
          {isAddingAgent && (
            <section className="agent-add-composer" aria-label="添加自定义工具">
              <div className="agent-add-heading">
                <div className="agent-add-mark" aria-hidden="true">
                  +
                </div>
                <div>
                  <strong>添加自定义工具</strong>
                  <p>填写名称和技能目录，确认后才会加入管理器。</p>
                </div>
              </div>
              <div className="agent-add-fields">
                <label>
                  <span>工具名称</span>
                  <input
                    ref={addAgentNameRef}
                    value={newAgent.name}
                    placeholder="例如 Trae"
                    onChange={(event) => {
                      setNewAgent((current) => ({
                        ...current,
                        name: event.target.value,
                      }));
                      setAddAgentError("");
                    }}
                  />
                </label>
                <label>
                  <span>标识</span>
                  <input
                    value={newAgent.shortName}
                    maxLength={3}
                    placeholder="TR"
                    onChange={(event) =>
                      setNewAgent((current) => ({
                        ...current,
                        shortName: event.target.value.toUpperCase(),
                      }))
                    }
                  />
                </label>
                <label className="color-field">
                  <span title="只用于区分工具，不表示运行状态">身份色</span>
                  <input
                    type="color"
                    value={newAgent.color}
                    onChange={(event) =>
                      setNewAgent((current) => ({
                        ...current,
                        color: event.target.value,
                      }))
                    }
                  />
                </label>
              </div>
              <label className="paths-field agent-add-paths">
                <span>技能目录</span>
                <textarea
                  value={newAgent.paths}
                  placeholder={"~/.trae/skills\n每行填写一个目录"}
                  rows={2}
                  onChange={(event) => {
                    setNewAgent((current) => ({
                      ...current,
                      paths: event.target.value,
                    }));
                    setAddAgentError("");
                  }}
                />
              </label>
              <div className="agent-add-actions">
                {addAgentError ? (
                  <p className="agent-add-error">{addAgentError}</p>
                ) : (
                  <p>添加后默认在技能列表和安装目标中展示。</p>
                )}
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={cancelAddAgent}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="button button-acid"
                  onClick={addAgent}
                >
                  确认添加
                </button>
              </div>
            </section>
          )}
        </div>
        {!isAddingAgent && (
          <button
            type="button"
            className="add-agent-button"
            onClick={openAddAgent}
          >
            <span className="add-agent-button-mark" aria-hidden="true">
              +
            </span>
            <span>
              <strong>添加自定义工具</strong>
              <small>配置其他 Agent 的本地技能目录</small>
            </span>
          </button>
        )}
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

function CapabilityProductMark({
  capability,
}: {
  capability: Pick<
    Capability,
    "productName" | "productShortName" | "productColor"
  >;
}) {
  return (
    <span
      className="capability-product-mark"
      style={
        {
          "--capability-color": capability.productColor,
        } as React.CSSProperties
      }
      aria-label={capability.productName}
    >
      {capability.productShortName}
    </span>
  );
}

type ConnectorCatalog = {
  available: boolean;
  productName: string;
  connectors: {
    id: string; name: string; enabled: boolean; transport: string; endpoint: string;
    source: string; toolsRestricted: boolean; enabledTools: string[]; disabledTools: string[];
    approvalMode: string; timeoutSeconds: number | null; hasCredentials: boolean;
  }[];
  plugins: {
    name: string; displayName?: string; marketplace: string; version: string;
    enabled: boolean; status: "available" | "disabled" | "missing" | "ambiguous";
  }[];
  warnings: string[];
  scannedAt: string;
};

function ConnectorsView({ onSettings }: { onSettings: () => void }) {
  const [catalog, setCatalog] = useState<ConnectorCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setCatalog(await requestJson<ConnectorCatalog>("/api/connectors"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取连接器失败，请重试。");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);
  const connectors = (catalog?.connectors || []).filter((item) =>
    `${item.name} ${item.source} ${item.endpoint}`.toLowerCase().includes(query.toLowerCase()));
  const pluginStatuses = { available: "已启用 · 本地可读", disabled: "未启用", missing: "本地文件缺失", ambiguous: "版本待确认" };
  return (
    <section className="connectors-view page-enter" aria-labelledby="connectors-title">
      <header className="connectors-heading">
        <div><p className="eyebrow">其他 / 连接器</p><h1 id="connectors-title">订单来了 · 连接器</h1>
          <p>查看本机的服务连接配置和插件来源。启用状态来自配置，未检测服务连接或登录状态。</p></div>
        <button className="scan-button" onClick={() => void reload()} disabled={loading}>{loading ? "读取中…" : "重新读取"}</button>
      </header>
      <div className="connector-notice">只读展示 · 不调用外部服务 · 凭据、启动参数和完整服务地址不会展示</div>
      {error && <p className="capability-message is-error" role="alert">{error}</p>}
      {loading && <p role="status">正在读取本地配置…</p>}
      {!loading && catalog && !catalog.available && <EmptyState title="尚未检测到订单来了" description="安装并启动订单来了后，重新读取。Windows 与 Mac 均从当前用户目录下的 .smartorder 识别。" />}
      {catalog?.available && <>
        <div className="connector-toolbar">
          <h2>服务连接 <span>{catalog.connectors.length}</span></h2>
          <label><span className="sr-only">搜索连接器</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索连接器、来源或服务域名" /></label>
        </div>
        <div className="connector-list">
          {connectors.map((connector) => <details className="connector-card" key={connector.id}>
            <summary>
              <span className="connector-mark" aria-hidden="true">订</span>
              <span className="connector-title"><strong>{connector.name}</strong><small>{connector.source} · {connector.transport}</small></span>
              <span className="connector-status">{connector.enabled ? "配置已启用" : "配置已停用"}</span>
              <span className="connector-expand" aria-hidden="true">⌄</span>
            </summary>
            <div className="connector-details">
              <dl>
                <div><dt>服务域名</dt><dd>{connector.endpoint || (connector.transport === "stdio" ? "本地进程（启动命令已隐藏）" : "未声明可展示的地址")}</dd></div>
                <div><dt>认证信息</dt><dd>{connector.hasCredentials ? "已声明认证或环境配置，内容已隐藏" : "未声明认证配置"}</dd></div>
                <div><dt>工具执行确认</dt><dd>{{ auto: "自动", prompt: "询问", approve: "允许", deny: "拒绝" }[connector.approvalMode] || "使用客户端默认设置"}</dd></div>
                <div><dt>工具超时</dt><dd>{connector.timeoutSeconds === null ? "使用客户端默认设置" : `${connector.timeoutSeconds} 秒`}</dd></div>
              </dl>
              <div className="connector-tools"><strong>配置允许的工具</strong><p>{connector.enabledTools.length ? connector.enabledTools.join("、") : connector.toolsRestricted ? "清单为空，未开放任何工具" : "未配置限定清单；可用工具由服务决定"}</p></div>
              {!!connector.disabledTools.length && <div className="connector-tools"><strong>配置禁用的工具</strong><p>{connector.disabledTools.join("、")}</p></div>}
              <p className="connector-hint">此处为配置摘要；连接器登录、启停和权限修改请在订单来了客户端完成。</p>
            </div>
          </details>)}
          {!connectors.length && <p className="connector-empty">{query ? "没有匹配的连接器。" : "没有发现已配置的连接器。"}</p>}
        </div>
        <section className="connector-plugins" aria-labelledby="connector-plugins-title">
          <div className="connector-toolbar"><h2 id="connector-plugins-title">技能插件 <span>{catalog.plugins.length}</span></h2><button className="scan-button" onClick={onSettings}>设置技能列表显示</button></div>
          <p>仅识别配置中登记的插件。已启用且本地版本明确的插件技能可在 Skills 页面预览；市场目录和历史缓存不计入。</p>
          <ul>{catalog.plugins.map((plugin) => <li key={`${plugin.name}@${plugin.marketplace}`}>
            <div><strong>{plugin.displayName || plugin.name}</strong><small>{plugin.marketplace} · {plugin.version || "版本未知"}</small></div><span>{pluginStatuses[plugin.status]}</span>
          </li>)}</ul>
          {!catalog.plugins.length && <p>没有发现已登记的技能插件。</p>}
        </section>
        {!!catalog.warnings.length && <div className="connector-notice" role="status">{catalog.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
      </>}
    </section>
  );
}

function CapabilitiesView({
  catalog,
  loading,
  error,
  onRefresh,
  onSelect,
}: {
  catalog: CapabilityCatalog | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onSelect: (capability: Capability) => void;
}) {
  const [activeProductId, setActiveProductId] = useState("all");
  const [activeExpertType, setActiveExpertType] = useState<
    "all" | "expert" | "team"
  >("all");
  const [capabilityQuery, setCapabilityQuery] = useState("");
  const normalizedQuery = capabilityQuery.trim().toLocaleLowerCase();
  const allCapabilities = (catalog?.products || []).flatMap(
    (product) => product.items,
  );
  const expertCount = allCapabilities.filter(
    (capability) => capability.kind !== "expert-team",
  ).length;
  const teamCount = allCapabilities.filter(
    (capability) => capability.kind === "expert-team",
  ).length;
  const visibleProducts = (catalog?.products || [])
    .filter(
      (product) =>
        activeProductId === "all" || product.id === activeProductId,
    )
    .map((product) => ({
      ...product,
      items: product.items.filter((capability) => {
        const matchesType =
          activeExpertType === "all" ||
          (activeExpertType === "team"
            ? capability.kind === "expert-team"
            : capability.kind !== "expert-team");
        const matchesQuery = normalizedQuery
          ? [
              capability.displayName,
              capability.name,
              capability.description,
              capability.profession,
              capability.tags.join(" "),
              capability.members
                .map(
                  (member) =>
                    `${member.displayName} ${member.name} ${member.profession}`,
                )
                .join(" "),
            ]
              .join(" ")
              .toLocaleLowerCase()
              .includes(normalizedQuery)
          : true;
        return matchesType && matchesQuery;
      }),
    }))
    .filter(
      (product) =>
        product.items.length ||
        (!normalizedQuery && activeExpertType === "all"),
    );

  return (
    <div className="capabilities-view page-enter">
      <section className="capability-hero">
        <div>
          <p className="eyebrow">专家中心</p>
          <h1>
            专家与专家团，
            <br />
            分工一目了然<span>。</span>
          </h1>
          <p>
            自动识别本机产品中的单专家、专家团与兼容 Agent Profile，集中查看角色定位、成员分工、模型和委派方式。
          </p>
        </div>
        <div className="capability-hero-note">
          <span>只读扫描</span>
          <strong>敏感配置自动省略</strong>
          <small>不会展示 API Key、Token、认证与会话数据</small>
        </div>
      </section>

      <section className="capability-overview" aria-label="专家能力概览">
        <div>
          <span>已识别产品</span>
          <strong>{catalog?.totals.products || 0}</strong>
          <small>支持 WorkBuddy、Hermes Agent</small>
        </div>
        <div>
          <span>专家与专家团</span>
          <strong>{catalog?.totals.profiles || 0}</strong>
          <small>按本机实际配置展示</small>
        </div>
        <div>
          <span>专家团成员</span>
          <strong>{catalog?.totals.members || 0}</strong>
          <small>可查看每位成员的角色提示词</small>
        </div>
      </section>

      <section className="capability-inventory">
        <div className="capability-primary-tabs" aria-label="专家类型">
          {(
            [
              ["all", "全部", catalog?.totals.profiles || 0],
              ["expert", "专家", expertCount],
              ["team", "专家团", teamCount],
            ] as const
          ).map(([type, label, count]) => (
            <button
              key={type}
              className={activeExpertType === type ? "is-active" : ""}
              aria-pressed={activeExpertType === type}
              onClick={() => setActiveExpertType(type)}
            >
              <span>{label}</span>
              <b>{count}</b>
              <small>
                {type === "expert"
                  ? "单角色与 Agent Profile"
                  : type === "team"
                    ? "多角色协作配置"
                    : "全部本地专家配置"}
              </small>
            </button>
          ))}
        </div>
        <div className="capability-toolbar">
          <div
            className="capability-product-tabs"
            aria-label="按专家产品筛选"
          >
            <button
              className={activeProductId === "all" ? "is-active" : ""}
              aria-pressed={activeProductId === "all"}
              onClick={() => setActiveProductId("all")}
            >
              全部产品
              <span>{catalog?.totals.profiles || 0}</span>
            </button>
            {(catalog?.products || []).map((product) => (
              <button
                key={product.id}
                className={activeProductId === product.id ? "is-active" : ""}
                aria-pressed={activeProductId === product.id}
                onClick={() => setActiveProductId(product.id)}
              >
                <i style={{ background: product.color }} />
                {product.name}
                <span>{product.itemCount}</span>
              </button>
            ))}
          </div>
          <label className="capability-search">
            <span>⌕</span>
            <input
              value={capabilityQuery}
              onChange={(event) => setCapabilityQuery(event.target.value)}
              placeholder="搜索专家、成员或职责…"
              aria-label="搜索专家能力"
            />
          </label>
          <button
            className="capability-refresh"
            onClick={onRefresh}
            disabled={loading}
          >
            <span className={loading ? "is-spinning" : ""}>↻</span>
            {loading ? "识别中" : "重新识别"}
          </button>
        </div>

        {error ? (
          <div className="capability-message is-error">
            <strong>专家配置读取失败</strong>
            <p>{error}</p>
            <button onClick={onRefresh}>重试</button>
          </div>
        ) : loading && !catalog ? (
          <div className="capability-message" role="status">
            <strong>正在识别本机专家配置…</strong>
            <p>读取 WorkBuddy 专家插件与 Hermes Agent Profile。</p>
          </div>
        ) : !visibleProducts.length ? (
          <EmptyState
            title={
              normalizedQuery
                ? "没有匹配的专家"
                : activeExpertType === "team"
                  ? "没有识别到专家团"
                  : "没有识别到专家"
            }
            description={
              normalizedQuery
                ? "试试清空搜索词，或切换到其他产品。"
                : "安装或配置支持的 Agent 产品后，再重新识别。"
            }
          />
        ) : (
          visibleProducts.map((product) => (
            <div className="capability-product-section" key={product.id}>
              <header>
                <div>
                  <span
                    className="capability-product-logo"
                    style={{ background: product.color }}
                  >
                    {product.shortName}
                  </span>
                  <div>
                    <h2>{product.name}</h2>
                    <p>
                      {product.id === "workbuddy"
                        ? `${product.itemCount} 个本地专家配置 · 专家市场收录 ${product.catalogCount} 个`
                        : `${product.itemCount} 个本地 Agent Profile · 以 SOUL.md 定义身份`}
                    </p>
                  </div>
                </div>
                <code>{product.sourcePath}</code>
              </header>
              {product.items.length ? (
                <div className="capability-card-grid">
                  {product.items.map((capability) => (
                    <button
                      className="capability-card"
                      key={capability.id}
                      onClick={() => onSelect(capability)}
                    >
                      <div className="capability-card-top">
                        <CapabilityProductMark capability={capability} />
                        <span className="capability-kind">
                          {capability.kindLabel}
                        </span>
                        <span className="capability-open">查看配置 →</span>
                      </div>
                      <div className="capability-card-copy">
                        <h3>{capability.displayName || capability.name}</h3>
                        {capability.displayName !== capability.name && (
                          <code>{capability.name}</code>
                        )}
                        <p>{capability.description}</p>
                      </div>
                      <div className="capability-card-stats">
                        {capability.memberCount > 0 && (
                          <span>
                            <b>{capability.memberCount}</b> 位成员
                          </span>
                        )}
                        {capability.model && (
                          <span title={capability.model}>
                            <b>模型</b> {capability.model}
                          </span>
                        )}
                        {capability.skillCount > 0 && (
                          <span>
                            <b>{capability.skillCount}</b> 个技能
                          </span>
                        )}
                        <span>
                          <b>{capability.fileCount}</b> 个配置文件
                        </span>
                      </div>
                      {!!capability.tags.length && (
                        <div className="capability-tags">
                          {capability.tags.slice(0, 4).map((tag) => (
                            <span key={tag}>{tag}</span>
                          ))}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="capability-product-empty">没有匹配的配置。</p>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function CapabilityDetailPanel({
  capability,
  onClose,
}: {
  capability: Capability;
  onClose: () => void;
}) {
  const dialogRef = useModalFocus<HTMLElement>();
  const [listing, setListing] = useState<CapabilityFileListing | null>(null);
  const [selectedPath, setSelectedPath] = useState(
    capability.primaryFilePath,
  );
  const [fileContent, setFileContent] = useState<SkillFileContent | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [loadingContent, setLoadingContent] = useState(true);
  const [detailError, setDetailError] = useState("");
  const [previewMode, setPreviewMode] = useState<"rendered" | "source">(
    defaultPreviewMode(capability.primaryFilePath),
  );
  const fileRequestRef = useRef(0);

  const openFile = useCallback(
    async (filePath: string) => {
      const requestId = fileRequestRef.current + 1;
      fileRequestRef.current = requestId;
      setSelectedPath(filePath);
      setPreviewMode(defaultPreviewMode(filePath));
      setLoadingContent(true);
      setDetailError("");
      try {
        const content = await requestJson<SkillFileContent>(
          `/api/capability-file?capabilityId=${encodeURIComponent(
            capability.id,
          )}&path=${encodeURIComponent(filePath)}`,
        );
        if (fileRequestRef.current === requestId) setFileContent(content);
      } catch (error) {
        if (fileRequestRef.current === requestId) {
          setFileContent(null);
          setDetailError(
            error instanceof Error ? error.message : "无法读取配置文件。",
          );
        }
      } finally {
        if (fileRequestRef.current === requestId) setLoadingContent(false);
      }
    },
    [capability.id],
  );

  useEffect(() => {
    let cancelled = false;
    async function loadFiles() {
      setLoadingFiles(true);
      try {
        const nextListing = await requestJson<CapabilityFileListing>(
          `/api/capability-files?capabilityId=${encodeURIComponent(
            capability.id,
          )}`,
        );
        if (cancelled) return;
        setListing(nextListing);
        const firstPath =
          nextListing.entries.find(
            (entry) =>
              entry.type === "file" &&
              entry.path === capability.primaryFilePath,
          )?.path ||
          nextListing.entries.find((entry) => entry.type === "file")?.path ||
          "";
        if (firstPath) void openFile(firstPath);
        else setLoadingContent(false);
      } catch (error) {
        if (cancelled) return;
        setDetailError(
          error instanceof Error ? error.message : "无法读取专家配置。",
        );
        setLoadingContent(false);
      } finally {
        if (!cancelled) setLoadingFiles(false);
      }
    }
    void loadFiles();
    return () => {
      cancelled = true;
      fileRequestRef.current += 1;
    };
  }, [capability.id, capability.primaryFilePath, openFile]);

  const files = useMemo(
    () => listing?.entries.filter((entry) => entry.type === "file") || [],
    [listing],
  );
  const rootFiles = files.filter((entry) => !entry.path.includes("/"));
  const fileGroups = useMemo(() => {
    const groups = new Map<string, SkillFileEntry[]>();
    for (const entry of files) {
      if (!entry.path.includes("/")) continue;
      const folder = entry.path.split("/")[0];
      const existing = groups.get(folder) || [];
      existing.push(entry);
      groups.set(folder, existing);
    }
    return [...groups.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
  }, [files]);
  const selectedEntry = files.find((entry) => entry.path === selectedPath);

  function fileButton(entry: SkillFileEntry) {
    return (
      <button
        key={entry.path}
        className={selectedPath === entry.path ? "is-active" : ""}
        onClick={() => void openFile(entry.path)}
        title={entry.path}
      >
        <span>{isImagePath(entry.path) ? "▧" : isMarkdownPath(entry.path) ? "M↓" : "{}"}</span>
        <span>{entry.name}</span>
        <small>{formatBytes(entry.size)}</small>
      </button>
    );
  }

  return (
    <div
      className="capability-detail-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="capability-detail-panel"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="capability-detail-title"
        tabIndex={-1}
      >
        <header className="capability-detail-header">
          <div className="capability-detail-product">
            <CapabilityProductMark capability={capability} />
            <div>
              <span>
                {capability.productName} / {capability.kindLabel}
              </span>
              <code>{capability.sourcePath}</code>
            </div>
          </div>
          <button
            className="capability-detail-close"
            onClick={onClose}
            aria-label="关闭专家详情"
          >
            ×
          </button>
        </header>

        <section className="capability-detail-identity">
          <div>
            <p className="eyebrow">配置详情</p>
            <h2 id="capability-detail-title">
              {capability.displayName || capability.name}
            </h2>
            {capability.displayName !== capability.name && (
              <code>{capability.name}</code>
            )}
            <p>{capability.description}</p>
          </div>
          <div className="capability-facts">
            {capability.memberCount > 0 && (
              <span>
                <small>角色成员</small>
                <strong>{capability.memberCount} 位</strong>
              </span>
            )}
            {capability.model && (
              <span>
                <small>默认模型</small>
                <strong>{capability.model}</strong>
              </span>
            )}
            {capability.delegation && (
              <span>
                <small>任务委派</small>
                <strong>
                  {capability.delegation.enabled ? "已启用" : "未启用"}
                </strong>
              </span>
            )}
            <span>
              <small>可查看文件</small>
              <strong>{listing?.fileCount ?? capability.fileCount} 个</strong>
            </span>
          </div>
        </section>

        <div className="capability-detail-workspace">
          <aside className="capability-config-map">
            {!!capability.members.length && (
              <section>
                <header>
                  <strong>角色组成</strong>
                  <span>{capability.members.length}</span>
                </header>
                <div className="capability-member-list">
                  {capability.members.map((member, index) => (
                    <button
                      key={member.id}
                      className={
                        selectedPath === member.filePath ? "is-active" : ""
                      }
                      onClick={() => void openFile(member.filePath)}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <span>
                        <strong>{member.displayName || member.name}</strong>
                        <small>
                          {member.profession ||
                            member.description ||
                            "专家团成员"}
                        </small>
                      </span>
                      {member.maxTurns && <b>{member.maxTurns} 轮</b>}
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section className="capability-file-map">
              <header>
                <strong>配置文件</strong>
                <span>{files.length}</span>
              </header>
              {loadingFiles ? (
                <p>正在读取文件…</p>
              ) : (
                <div>
                  {rootFiles.map(fileButton)}
                  {fileGroups.map(([folder, entries]) => (
                    <details key={folder}>
                      <summary>
                        <span>›</span>
                        <strong>{folder}</strong>
                        <small>{entries.length}</small>
                      </summary>
                      <div>{entries.map(fileButton)}</div>
                    </details>
                  ))}
                </div>
              )}
            </section>
          </aside>

          <section className="capability-config-preview">
            <header>
              <div>
                <strong>{selectedEntry?.name || selectedPath || "配置预览"}</strong>
                {selectedEntry && (
                  <span>
                    {selectedEntry.path} · {formatBytes(selectedEntry.size)}
                  </span>
                )}
              </div>
              {fileContent && isMarkdownPath(fileContent.path) && (
                <div className="preview-mode-switch" aria-label="预览模式">
                  <button
                    className={previewMode === "rendered" ? "is-active" : ""}
                    onClick={() => setPreviewMode("rendered")}
                  >
                    阅读
                  </button>
                  <button
                    className={previewMode === "source" ? "is-active" : ""}
                    onClick={() => setPreviewMode("source")}
                  >
                    原文
                  </button>
                </div>
              )}
            </header>
            <div className="capability-config-content">
              {loadingContent ? (
                <div className="browser-loading browser-loading-content">
                  正在读取配置…
                </div>
              ) : detailError ? (
                <div className="browser-empty-state">
                  <strong>无法显示这个配置</strong>
                  <p>{detailError}</p>
                </div>
              ) : fileContent?.previewKind === "image" ? (
                <SkillImagePreview
                  name={fileContent.name}
                  source={`${API_BASE}/api/capability-asset?capabilityId=${encodeURIComponent(
                    capability.id,
                  )}&path=${encodeURIComponent(fileContent.path)}`}
                />
              ) : fileContent?.previewKind === "text" &&
                fileContent.content !== null ? (
                isMarkdownPath(fileContent.path) &&
                previewMode === "rendered" ? (
                  <article className="markdown-preview capability-markdown">
                    <MarkdownDocument content={fileContent.content} />
                  </article>
                ) : (
                  <pre className="capability-source">
                    <code>{fileContent.content}</code>
                  </pre>
                )
              ) : (
                <div className="browser-empty-state">
                  <strong>暂不支持预览</strong>
                  <p>
                    {fileContent?.reason || "请选择左侧的配置文件查看内容。"}
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>

        <footer className="capability-detail-footer">
          <p>
            <span>●</span>
            只读预览 · 敏感认证、Token 与会话配置已自动省略
          </p>
          {capability.delegation?.enabled && (
            <p>
              可并行委派 {capability.delegation.maxConcurrentChildren || "—"}{" "}
              个子 Agent · 最大深度{" "}
              {capability.delegation.maxSpawnDepth ?? "—"}
            </p>
          )}
          <button className="button" onClick={onClose}>
            关闭
          </button>
        </footer>
      </aside>
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
          <p className="eyebrow">产品与目录</p>
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
  const [capabilityData, setCapabilityData] =
    useState<CapabilityCatalog | null>(null);
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [capabilityError, setCapabilityError] = useState("");
  const [view, setView] = useState<ViewName>("skills");
  const [activeAgentId, setActiveAgentId] = useState("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SkillStatus | "all">("all");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<
    string | null
  >(null);
  const [syncSkillId, setSyncSkillId] = useState<string | null>(null);
  const [detailInitialInstanceId, setDetailInitialInstanceId] = useState<
    string | null
  >(null);
  const [resumeSyncSkillId, setResumeSyncSkillId] = useState<string | null>(
    null,
  );
  const [syncSourceId, setSyncSourceId] = useState<string | null>(null);
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
      selectedCapabilityId ||
      syncSkillId ||
      importedSkill ||
      importPickerOpen ||
      settingsOpen,
  );
  const blocksGlobalDrop = Boolean(
    selectedSkillId ||
      selectedCapabilityId ||
      syncSkillId ||
      importedSkill ||
      settingsOpen,
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

  const loadCapabilities = useCallback(async (force = false) => {
    setCapabilityLoading(true);
    try {
      const catalog =
        await requestJson<CapabilityCatalog>(
          `/api/capabilities${force ? "?force=1" : ""}`,
        );
      setCapabilityData(catalog);
      setCapabilityError("");
    } catch (loadError) {
      setCapabilityError(
        loadError instanceof Error
          ? loadError.message
          : "无法读取本机专家配置。",
      );
    } finally {
      setCapabilityLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setSelectedSkillId(null);
    setDetailInitialInstanceId(null);
    if (resumeSyncSkillId) {
      setSyncSkillId(resumeSyncSkillId);
      setResumeSyncSkillId(null);
    }
  }, [resumeSyncSkillId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  useEffect(() => {
    if (view !== "capabilities" || capabilityData || capabilityLoading) return;
    const timer = window.setTimeout(() => void loadCapabilities(), 0);
    return () => window.clearTimeout(timer);
  }, [capabilityData, capabilityLoading, loadCapabilities, view]);

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
        } else if (selectedSkillId) closeDetail();
        else if (selectedCapabilityId) setSelectedCapabilityId(null);
        else if (syncSkillId) {
          setSyncSkillId(null);
          setSyncSourceId(null);
        }
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
        !selectedCapabilityId &&
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
    closeDetail,
    selectedSkillId,
    selectedCapabilityId,
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
  const selectedCapability =
    capabilityData?.products
      .flatMap((product) => product.items)
      .find((capability) => capability.id === selectedCapabilityId) || null;

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

  async function exportSkill(
    instanceId: string,
    format: "skill" | "zip",
  ) {
    const instance = data?.skills
      .flatMap((skill) => skill.instances)
      .find((item) => item.id === instanceId);
    if (!instance) {
      setToast("找不到要导出的 Skill 实例");
      return;
    }
    try {
      const response = await fetch(
        `${API_BASE}/api/export-skill?instanceId=${encodeURIComponent(instanceId)}&format=${format}`,
      );
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || "打包失败。");
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${instance.directoryName}.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setToast(
        `${instance.displayName || instance.name} 已导出为 ${
          format === "zip" ? "ZIP 压缩包" : ".skill 技能包"
        }`,
      );
    } catch (exportError) {
      setToast(
        exportError instanceof Error ? exportError.message : "导出失败。",
      );
    }
  }

  const navSections: {
    id: string;
    label: string;
    items: {
      id: ViewName;
      label: string;
      code: string;
      badge?: number;
    }[];
  }[] = [
    {
      id: "core",
      label: "核心功能",
      items: [
        { id: "skills", label: "Skills", code: "01" },
        { id: "capabilities", label: "专家", code: "02" },
      ],
    },
    {
      id: "management",
      label: "管理",
      items: [
        {
          id: "sync",
          label: "同步与版本",
          code: "03",
          badge: data
            ? data.totals.conflicts + data.totals.incomplete
            : undefined,
        },
        { id: "sources", label: "产品与目录", code: "04" },
      ],
    },
    {
      id: "other",
      label: "其他",
      items: [{ id: "connectors", label: "连接器", code: "05" }],
    },
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
          {navSections.map((section) => (
            <div className="sidebar-nav-section" key={section.id}>
              <p>{section.label}</p>
              {section.items.map((item) => (
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
            </div>
          ))}
        </nav>

        <div className="sidebar-agents">
          <p>Skills 安装端 / 点击查看</p>
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
            <span
              className={[
                serviceError ? "is-error" : "",
                loading || refreshing ? "is-scanning" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            />
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
            ["capabilities", "专家", "02"],
            ["sync", "待处理", "03"],
            ["sources", "数据源", "04"],
            ["connectors", "连接器", "05"],
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
            {view === "skills" && (
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
            )}
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
                    onSelect={(skill) => {
                      setDetailInitialInstanceId(null);
                      setResumeSyncSkillId(null);
                      setSelectedSkillId(skill.id);
                    }}
                    onSync={(skill) => {
                      setSyncSourceId(null);
                      setSyncSkillId(skill.id);
                    }}
                  />
                </section>
              </div>
            )}

            {view === "sync" && (
              <SyncCenter
                data={data}
                onSync={(skill) => {
                  setSyncSourceId(null);
                  setSyncSkillId(skill.id);
                }}
                onSelect={(skill) => {
                  setDetailInitialInstanceId(null);
                  setResumeSyncSkillId(null);
                  setSelectedSkillId(skill.id);
                }}
              />
            )}

            {view === "capabilities" && (
              <CapabilitiesView
                catalog={capabilityData}
                loading={capabilityLoading}
                error={capabilityError}
                onRefresh={() => void loadCapabilities(true)}
                onSelect={(capability) =>
                  setSelectedCapabilityId(capability.id)
                }
              />
            )}

            {view === "sources" && (
              <SourcesView
                data={data}
                onSettings={() => setSettingsOpen(true)}
              />
            )}
            {view === "connectors" && <ConnectorsView onSettings={() => setSettingsOpen(true)} />}
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
          key={`${selectedSkill.id}:${detailInitialInstanceId || "default"}`}
          skill={selectedSkill}
          agents={availableAgents}
          initialInstanceId={detailInitialInstanceId || undefined}
          reviewMode={Boolean(resumeSyncSkillId)}
          onClose={closeDetail}
          onSync={(instanceId) => {
            const nextSyncSkillId = resumeSyncSkillId || selectedSkill.id;
            setSelectedSkillId(null);
            setDetailInitialInstanceId(null);
            setResumeSyncSkillId(null);
            setSyncSourceId(instanceId);
            setSyncSkillId(nextSyncSkillId);
          }}
          onReveal={(instanceId) => void reveal(instanceId)}
          onExport={(instanceId, format) => exportSkill(instanceId, format)}
        />
      )}

      {selectedCapability && (
        <CapabilityDetailPanel
          key={selectedCapability.id}
          capability={selectedCapability}
          onClose={() => setSelectedCapabilityId(null)}
        />
      )}

      {syncSkill && data && (
        <SyncDialog
          skill={syncSkill}
          agents={availableAgents}
          defaultMode={config?.syncMode || "copy"}
          initialSourceId={syncSourceId || undefined}
          onClose={() => {
            setSyncSkillId(null);
            setSyncSourceId(null);
          }}
          onReviewInstance={(instanceId, sourceInstanceId) => {
            setSyncSourceId(sourceInstanceId);
            setResumeSyncSkillId(syncSkill.id);
            setSyncSkillId(null);
            setDetailInitialInstanceId(instanceId);
            setSelectedSkillId(syncSkill.id);
          }}
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
