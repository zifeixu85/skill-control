"use client";

import type { ReactNode } from "react";
import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api } from "../../../lib/api";
import { joinNames } from "../../../lib/format";
import { CheckIcon, CopiesIcon, HealthIcon, KeyIcon } from "../../icons";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";

function Note({
  tone,
  icon,
  title,
  detail,
  action,
}: {
  tone: "ok" | "warn" | "danger";
  icon: ReactNode;
  title: ReactNode;
  detail: ReactNode;
  action?: { label: string; run: () => void };
}) {
  return (
    <div className="note">
      <span className={`ic ${tone}`}>{icon}</span>
      <div>
        <b>{title}</b>
        <span>{detail}</span>
      </div>
      {action ? (
        <button type="button" className="btn sm" onClick={action.run}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export function HealthNote() {
  const report = useResource("health-report", () => api.healthReport());
  const { go } = useNav();
  if (!report.data || isUnsupported(report.error)) return null;
  const high = report.data.findings.filter((finding) => finding.severity === "high").length;
  const medium = report.data.findings.filter((finding) => finding.severity === "medium").length;
  if (!high && !medium) return null;
  return (
    <Note
      tone={high ? "danger" : "warn"}
      icon={<HealthIcon />}
      title={`体检发现 ${high + medium} 个值得处理的问题`}
      detail={[high ? `${high} 个需要处理` : "", medium ? `${medium} 个建议处理` : ""].filter(Boolean).join("，")}
      action={{ label: "查看", run: () => go("health") }}
    />
  );
}

export function HomeNotes() {
  const { views, primary, agentName, integrations } = useData();
  const { go } = useNav();
  const names = joinNames(primary.map(agentName));
  const differs = views.filter((view) => view.differs && !view.multi);
  const multi = views.filter((view) => view.multi);
  const multiAgents = [
    ...new Set(
      multi.flatMap((view) =>
        (view.skill.duplicates || []).filter((item) => primary.includes(item.agentId) && item.count > 1).map((item) => item.agentId),
      ),
    ),
  ];
  const example = multi[0];
  const exampleCopies = example
    ? (example.skill.duplicates || []).find((item) => primary.includes(item.agentId) && item.count > 1)
    : null;
  const secrets = (integrations.data?.mcpServers || []).filter((server) => server.likelySecretFields.length > 0);
  const secretAgents = [...new Set(secrets.map((server) => server.agentId))];

  return (
    <div className="notes">
      {differs.length === 0 ? (
        <Note
          tone="ok"
          icon={<CheckIcon />}
          title={primary.length > 1 ? `${names}之间没有版本冲突` : "常用 Agent 里没有版本冲突"}
          detail="同名技能在常用 Agent 里的内容一致"
        />
      ) : (
        <Note
          tone="warn"
          icon={<CopiesIcon />}
          title={`${differs.length} 个技能在常用 Agent 之间版本不同`}
          detail={`例如 ${differs[0].title}。点开可以看到哪一份更新。`}
          action={{ label: "查看", run: () => go("skills", { filter: "differs" }) }}
        />
      )}
      {multi.length ? (
        <Note
          tone="warn"
          icon={<CopiesIcon />}
          title={`${joinNames(multiAgents.map(agentName))} 里有 ${multi.length} 个技能存了多份`}
          detail={
            example && exampleCopies
              ? `例如 ${example.title}：${agentName(exampleCopies.agentId)} 里有 ${exampleCopies.count} 份${exampleCopies.identical ? "，内容相同" : "，内容不一样"}。实际加载哪一份由 Agent 决定。`
              : "同一个 Agent 里有多份时，实际加载哪一份由 Agent 决定。"
          }
          action={{ label: "逐个查看", run: () => go("skills", { filter: "multi" }) }}
        />
      ) : null}
      {secrets.length ? (
        <Note
          tone="danger"
          icon={<KeyIcon />}
          title={`${secrets.length} 个 MCP 服务的密钥直接写在 ${joinNames(secretAgents.map(agentName))} 的配置里`}
          detail={`${joinNames(secrets.slice(0, 4).map((server) => server.name))}${secrets.length > 4 ? " 等" : ""}。改用环境变量引用会更安全。`}
          action={{ label: "查看", run: () => go("connectors") }}
        />
      ) : null}
      <HealthNote />
    </div>
  );
}
