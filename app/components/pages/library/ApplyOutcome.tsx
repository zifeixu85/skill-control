"use client";

import { STATE_LABELS, type LibraryApplyResult } from "../../../lib/library";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";

const STATUS: Record<string, { label: string; tone: string }> = {
  applied: { label: "已完成", tone: "" },
  failed: { label: "失败", tone: "danger" },
  "rolled-back": { label: "已撤回", tone: "warn" },
};

/** What happened, item by item, plus the automatic visibility re-check. */
export function ApplyOutcome({ result }: { result: LibraryApplyResult }) {
  const { agentName } = useData();
  const skills = Object.entries(result.visibility);
  return (
    <div className="plan-list">
      <section className="plan-section">
        <h3>执行结果</h3>
        {result.results.map((item) => {
          const status = STATUS[item.status] || { label: item.status, tone: "mute" };
          return (
            <div className="plan-action" key={item.id}>
              <div className="plan-line">
                <span className={`tag ${status.tone}`}>{status.label}</span>
                <span>{item.title}</span>
              </div>
              {item.error ? <p className="danger-text">{item.error}</p> : null}
              {item.trashId ? <p className="muted">已移到回收站，可以在技能库页恢复。</p> : null}
            </div>
          );
        })}
      </section>
      {skills.length ? (
        <section className="plan-section">
          <h3>重新检查：各 Agent 能否看到</h3>
          <div className="recheck">
            {skills.map(([skill, fanout]) => (
              <div key={skill} className="recheck-row">
                <code>{skill}</code>
                <span className="recheck-agents">
                  {Object.entries(fanout).map(([agentId, item]) => (
                    <span key={agentId} className={`state-chip ${item.state}`} title={item.reason || undefined}>
                      <AgentAvatar id={agentId} size="xs" />
                      {agentName(agentId)}：{STATE_LABELS[item.state]}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {result.backups.length ? (
        <details>
          <summary>{result.backups.length} 份备份</summary>
          <div className="list-names">
            {result.backups.map((backup) => (
              <span key={backup}>{backup}</span>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
