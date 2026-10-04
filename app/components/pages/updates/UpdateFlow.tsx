"use client";

import { useState } from "react";
import { invalidateResources, primeResource } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import { joinNames } from "../../../lib/format";
import {
  CHOICE_TEXT,
  STEP_LABELS,
  type ApplyResult,
  type ConflictChoice,
  type UpdatePlan,
  type UpdateUnit,
} from "../../../lib/updates";
import { CopyPathButton } from "../../files/ConfigDetailView";
import { CodeView } from "../../ui/CodeView";
import { useData } from "../../providers/DataProvider";
import { useUndoToast } from "../../../hooks/useUndoToast";
import { UPDATES_KEY } from "./UpdatesPage";

type Phase =
  | { name: "idle" }
  | { name: "planning" }
  | { name: "plan"; plan: UpdatePlan }
  | { name: "applying"; plan: Extract<UpdatePlan, { kind: "plan" }> }
  | { name: "done"; result: ApplyResult }
  | { name: "error"; message: string };

function PlanView({ plan }: { plan: Extract<UpdatePlan, { kind: "plan" }> }) {
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

function ResultView({ result }: { result: ApplyResult }) {
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

/** Plan → explicit confirm → apply → result. Nothing runs without the confirm click. */
export function UpdateFlow({ unit }: { unit: UpdateUnit }) {
  const undoToast = useUndoToast();
  const [phase, setPhase] = useState<Phase>({ name: "idle" });

  const plan = async (choice?: ConflictChoice) => {
    setPhase({ name: "planning" });
    try {
      setPhase({ name: "plan", plan: await api.planUpdate(unit.unitKey, choice) });
    } catch (error) {
      setPhase({ name: "error", message: errorMessage(error, "无法生成更新计划。") });
    }
  };

  const apply = async (current: Extract<UpdatePlan, { kind: "plan" }>) => {
    setPhase({ name: "applying", plan: current });
    try {
      const result = await api.applyUpdate(current.planId);
      setPhase({ name: "done", result });
      // Only self-updates keep backups the service can put back.
      undoToast(
        result.ok ? `已更新 ${unit.title}` : `${unit.title} 没有全部完成，请查看输出`,
        result.kind === "self" ? result.historyId : null,
        result.ok ? "default" : "error",
      );
      primeResource(UPDATES_KEY, await api.updates());
      void invalidateResources("scan", "files:", "file:", "detail:", "health-report", "usage:skill:", "integrations");
    } catch (error) {
      setPhase({ name: "error", message: errorMessage(error, "更新失败，已写入的目录会从备份恢复。") });
    }
  };

  if (phase.name === "idle" || phase.name === "planning") {
    const canPlan = unit.action.kind !== "none";
    return (
      <div className="confirm quiet">
        <b>{unit.action.kind === "guide" ? "在来源产品里更新" : unit.action.label || "更新"}</b>
        {unit.action.kind === "guide" && unit.action.label ? <p>{unit.action.label}</p> : null}
        <p>
          {unit.action.kind === "delegate"
            ? "会调用这个来源自己的命令完成更新，先给你看要运行的命令。"
            : unit.action.kind === "guide"
              ? "这个来源需要在它自己的产品里更新，可以查看具体步骤。"
              : unit.action.kind === "self"
                ? "Skill Control 会下载上游内容并校验，替换前自动备份。先看计划再决定。"
                : "这个来源不需要也不能在这里更新。"}
        </p>
        {unit.action.command ? <code className="command">{unit.action.command}</code> : null}
        {canPlan ? (
          <div className="acts">
            <button type="button" className="btn sm primary" disabled={phase.name === "planning"} onClick={() => void plan()}>
              {phase.name === "planning" ? "正在生成计划…" : unit.action.kind === "guide" ? "查看步骤" : "生成更新计划"}
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  if (phase.name === "error") {
    return (
      <div className="confirm">
        <p className="form-error" role="alert">
          {phase.message}
        </p>
        <div className="acts">
          <button type="button" className="btn sm" onClick={() => setPhase({ name: "idle" })}>
            返回
          </button>
        </div>
      </div>
    );
  }
  if (phase.name === "done") {
    return (
      <div className="confirm quiet">
        <b>{phase.result.ok ? "更新完成" : "部分步骤失败"}</b>
        <ResultView result={phase.result} />
      </div>
    );
  }
  const current = phase.plan;
  if (current.kind === "choice") {
    return (
      <div className="confirm">
        <b>先决定怎么处理本地修改</b>
        <p>{current.message || "你在本地改过这个技能。"}</p>
        <div className="choices">
          {current.choices.map((choice) => (
            <button key={choice} type="button" className="choice" onClick={() => void plan(choice)}>
              <b>{CHOICE_TEXT[choice].title}</b>
              <span>{CHOICE_TEXT[choice].detail}</span>
            </button>
          ))}
        </div>
        <div className="acts">
          <button type="button" className="btn sm ghost" onClick={() => setPhase({ name: "idle" })}>
            取消
          </button>
        </div>
      </div>
    );
  }
  if (current.kind === "guide") {
    return (
      <div className="confirm quiet">
        <b>需要在来源产品里更新</b>
        <p>{current.instructions || "请在安装它的产品里更新。"}</p>
        {current.command ? (
          <div className="command-copy">
            <code className="command">{current.command}</code>
            <CopyPathButton path={current.command} label="复制命令" />
          </div>
        ) : null}
      </div>
    );
  }
  const applying = phase.name === "applying";
  return (
    <div className="confirm">
      <b>{current.action === "delegate" ? "将运行这些命令" : current.action === "self" ? "更新计划" : "无需改动"}</b>
      <PlanView plan={current} />
      <div className="acts">
        <button type="button" className="btn sm ghost" disabled={applying} onClick={() => setPhase({ name: "idle" })}>
          取消
        </button>
        {current.action !== "none" ? (
          <button type="button" className="btn sm primary" disabled={applying} onClick={() => void apply(current)}>
            {applying ? "正在执行…" : current.action === "delegate" ? "确认运行" : "确认更新"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
