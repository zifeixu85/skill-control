"use client";

import { useState } from "react";
import { useNow } from "../../hooks/useNow";
import { isUnsupported, primeResource, useResource } from "../../hooks/useResource";
import { useScrollMemory } from "../../hooks/useScrollMemory";
import { api, errorMessage } from "../../lib/api";
import { formatRelative } from "../../lib/format";
import { groupFindings, SEVERITY_LABELS, type HealthFinding, type SeverityLevel } from "../../lib/health";
import { InfoIcon, RefreshIcon, WarnIcon } from "../icons";
import { CopyPathButton } from "../files/ConfigDetailView";
import { useData } from "../providers/DataProvider";
import { useNav } from "../providers/NavProvider";
import { useToast } from "../providers/ToastProvider";
import { connectorsTabStore } from "./ConnectorsPage";
import { AgentAvatar } from "../ui/Avatar";
import { EmptyState, Loading, SectionHeading, TopBar } from "../ui/basics";

const TONE: Record<SeverityLevel, string> = { high: "danger", medium: "warn", low: "info", info: "mute" };

const MCP_NAME = /MCP「([^」]+)」/;
const UPDATE_CATEGORIES = new Set(["update-available", "locally-modified", "lock-drift"]);
const LIBRARY_CATEGORIES = new Set(["library-drift", "library-external-link"]);

function FindingRow({ finding }: { finding: HealthFinding }) {
  const { views, agentName } = useData();
  const { go, openDrawer } = useNav();
  const updates = useResource("updates", () => api.updates());
  const skillName = finding.skillName?.toLowerCase();
  const unit = UPDATE_CATEGORIES.has(finding.category)
    ? updates.data?.units.find(
        (item) =>
          (finding.path && item.instances.some((instance) => instance.path === finding.path)) ||
          (skillName && item.title.toLowerCase() === skillName),
      )
    : null;
  const view = skillName ? views.find((item) => item.techName.toLowerCase() === skillName) : null;
  const mcpName = finding.category.startsWith("mcp") || finding.category === "nvm-only" ? finding.title.match(MCP_NAME)?.[1] : null;
  const action = LIBRARY_CATEGORIES.has(finding.category)
    ? { label: "打开技能库", run: () => go("library") }
    : finding.category.startsWith("cli-")
      ? {
          label: "查看命令行工具",
          run: () => {
            connectorsTabStore.set("cli");
            go("connectors");
          },
        }
      : UPDATE_CATEGORIES.has(finding.category)
    ? unit
      ? { label: "查看更新", run: () => openDrawer({ kind: "update", id: unit.unitKey }) }
      : { label: "打开更新", run: () => go("updates") }
    : mcpName
    ? { label: "查看配置", run: () => openDrawer({ kind: "mcp", id: mcpName }) }
    : view
      ? { label: "查看技能", run: () => go("skills", { skillId: view.id }) }
      : finding.category === "plugin-state"
        ? { label: "查看插件", run: () => go("plugins") }
        : null;
  return (
    <li className="finding">
      <span className={`sev ${TONE[finding.severity]}`} role="img" aria-label={SEVERITY_LABELS[finding.severity]}>
        {finding.severity === "info" ? <InfoIcon /> : <WarnIcon />}
      </span>
      <div className="finding-main">
        <b>{finding.title}</b>
        {finding.detail ? <p>{finding.detail}</p> : null}
        <div className="finding-meta">
          {finding.agentId ? (
            <span className="meta-agent">
              <AgentAvatar id={finding.agentId} size="xs" />
              {agentName(finding.agentId)}
            </span>
          ) : null}
          {finding.path ? <code title={finding.path}>{finding.path}</code> : null}
          {finding.fix ? <span className="fix-label">建议：{finding.fix.label}</span> : null}
        </div>
      </div>
      <div className="finding-acts">
        {action ? (
          <button type="button" className="btn sm" onClick={action.run}>
            {action.label}
          </button>
        ) : null}
        {finding.path ? <CopyPathButton path={finding.path} /> : null}
      </div>
    </li>
  );
}

const PREVIEW = 6;

function FindingList({ findings }: { findings: HealthFinding[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? findings : findings.slice(0, PREVIEW);
  return (
    <>
      <ul className="findings">
        {shown.map((finding) => (
          <FindingRow key={finding.id} finding={finding} />
        ))}
      </ul>
      {findings.length > PREVIEW ? (
        <button type="button" className="btn sm ghost more-findings" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : `显示全部 ${findings.length} 项`}
        </button>
      ) : null}
    </>
  );
}

export function HealthPage() {
  const report = useResource("health-report", () => api.healthReport());
  const [checking, setChecking] = useState(false);
  const toast = useToast();
  const recheck = async () => {
    setChecking(true);
    try {
      primeResource("health-report", await api.healthReport(true));
      toast.show("检查完成");
    } catch (error) {
      toast.show(errorMessage(error, "检查失败。"), { tone: "error" });
    } finally {
      setChecking(false);
    }
  };
  const scrollRef = useScrollMemory<HTMLDivElement>("health");
  const now = useNow();
  const groups = report.data ? groupFindings(report.data.findings) : [];
  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar
        title={<span id="page-title">体检</span>}
        sub={
          report.data?.generatedAt && now
            ? `${formatRelative(report.data.generatedAt, now)}检查 · 只读，不会自动修改任何文件`
            : "检查重复副本、版本差异、明文密钥等问题 · 只读"
        }
      >
        <button type="button" className="btn ghost" disabled={checking} onClick={() => void recheck()}>
          <RefreshIcon className={checking ? "spin" : ""} />
          {checking ? "正在检查…" : "重新检查"}
        </button>
      </TopBar>
      <div className="scroll" ref={scrollRef}>
        {isUnsupported(report.error) ? (
          <EmptyState title="本地服务还没有提供体检">
            更新 Skill Control 后，这里会列出重复副本、版本差异、明文密钥、失效链接等问题，并给出处理建议。
          </EmptyState>
        ) : report.status === "error" && !report.data ? (
          <EmptyState tone="error" title="体检失败">
            {errorMessage(report.error)}
          </EmptyState>
        ) : !report.data ? (
          <Loading label="正在检查…" rows={6} />
        ) : !groups.length ? (
          <EmptyState title="没有发现问题">技能、插件和 MCP 配置看起来都正常。</EmptyState>
        ) : (
          <>
            <div className="health-summary">
              {groups.map((group) => (
                <div key={group.severity} className={`hs ${TONE[group.severity]}`}>
                  <b>{group.total}</b>
                  <span>{group.label}</span>
                </div>
              ))}
            </div>
            {groups.map((group) => (
              <section key={group.severity} aria-label={group.label}>
                <SectionHeading title={group.label} note={`${group.total} 项`} />
                {group.categories.map((category) => (
                  <div key={category.category} className="finding-group">
                    <h3>
                      {category.label} <em>{category.findings.length}</em>
                    </h3>
                    <FindingList findings={category.findings} />
                  </div>
                ))}
              </section>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
