"use client";

import { joinNames } from "../../../lib/format";
import { STEP_LABELS, type ApplyResult, type UpdatePlan } from "../../../lib/updates";
import { CodeView } from "../../ui/CodeView";
import { useData } from "../../providers/DataProvider";

export function PlanView({ plan }: { plan: Extract<UpdatePlan, { kind: "plan" }> }) {
  const { agentName } = useData();
  return (
    <div className="plan-list">
      <ol className="steps">
        {plan.steps.map((step, index) => (
          <li key={`${step.type}-${index}`}>
            <span className="tag mute">{STEP_LABELS[step.type] || step.type}</span>
            <div>
              {step.description ? <p>{step.description}</p> : null}
              {step.command ? <code className="command">{step.command}</code> : null}
              {step.path ? (
                <p>
                  {step.agentId ? `${agentName(step.agentId)}：` : ""}
                  <code>{step.path}</code>
                </p>
              ) : null}
              {step.backup ? (
                <p className="muted">
                  备份到 <code>{step.backup}</code>
                </p>
              ) : null}
              {step.alsoVisibleTo.length ? (
                <p className="plan-shared">写入后 {joinNames(step.alsoVisibleTo.map(agentName))} 也会看到这次改动。</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {plan.changes ? (
        <div className="file-changes">
          {(["added", "modified", "removed"] as const).map((key) =>
            plan.changes && plan.changes[key].length ? (
              <details key={key} open={plan.changes[key].length <= 8}>
                <summary>
                  {key === "added" ? "新增" : key === "modified" ? "修改" : "删除"} {plan.changes[key].length} 个文件
                </summary>
                <div className="list-names">
                  {plan.changes[key].slice(0, 80).map((file) => (
                    <span key={file}>{file}</span>
                  ))}
                </div>
              </details>
            ) : null,
          )}
        </div>
      ) : null}
      {plan.notes.map((note) => (
        <p key={note} className="plan-warning">
          {note}
        </p>
      ))}
    </div>
  );
}

export function ResultView({ result }: { result: ApplyResult }) {
  const { agentName } = useData();
  return (
    <div className="plan-list">
      {result.changed.map((change) => (
        <div className="plan-action" key={`${change.agentId}-${change.path}`}>
          <div className="plan-line">
            <span className="tag">已更新</span>
            <code>{change.path}</code>
          </div>
          <p>
            {agentName(change.agentId)}
            {change.backup ? (
              <>
                {" · 旧版本备份在 "}
                <code>{change.backup}</code>
              </>
            ) : null}
          </p>
        </div>
      ))}
      {result.savedAs ? (
        <p>
          本地版本另存为 <code>{result.savedAs}</code>
        </p>
      ) : null}
      {result.lockBackup ? (
        <p className="muted">
          锁文件备份：<code>{result.lockBackup}</code>
        </p>
      ) : null}
      {result.commands.map((command, index) => (
        <div className="command-result" key={`${command.command}-${index}`}>
          <div className="plan-line">
            <span className={`tag ${command.exitCode === 0 ? "" : "danger"}`}>退出码 {command.exitCode ?? "未知"}</span>
            <code>{command.command}</code>
          </div>
          {command.stdout ? <CodeView text={command.stdout} language="text" wrap label="命令输出" /> : null}
          {command.stderr ? <CodeView text={command.stderr} language="text" wrap label="错误输出" /> : null}
        </div>
      ))}
    </div>
  );
}
