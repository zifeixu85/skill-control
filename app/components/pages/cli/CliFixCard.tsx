"use client";

import { useState } from "react";
import { invalidateResources } from "../../../hooks/useResource";
import { useUndoToast } from "../../../hooks/useUndoToast";
import { api, errorMessage } from "../../../lib/api";
import type { CliFix, CliPlan } from "../../../lib/cli-tools";
import { CopyPathButton } from "../../files/ConfigDetailView";
import { useData } from "../../providers/DataProvider";
import { DiffView } from "../library/StepList";

type Phase =
  | { name: "idle" }
  | { name: "planning" }
  | { name: "plan"; plan: Extract<CliPlan, { kind: "self" }> }
  | { name: "applying"; plan: Extract<CliPlan, { kind: "self" }> }
  | { name: "done"; changed: { path: string; backup: string | null }[] }
  | { name: "error"; message: string };

function Commands({ text }: { text: string }) {
  const lines = text.split("\n").filter((line) => line.trim());
  const commands = lines.filter((line) => /^[a-z][\w.-]*\s/i.test(line.trim()) && !/[。，]/.test(line));
  if (!commands.length) return <p>{text}</p>;
  return (
    <div className="command-copy">
      {lines.filter((line) => !commands.includes(line)).map((line) => (
        <p key={line}>{line}</p>
      ))}
      {commands.map((command) => (
        <div key={command} className="command-line">
          <code className="command">{command}</code>
          <CopyPathButton path={command} label="复制命令" />
        </div>
      ))}
    </div>
  );
}

/** One fix: guidance with copyable commands, or plan → per-file diff → confirm → result. */
export function CliFixCard({ toolId, fix }: { toolId: string; fix: CliFix }) {
  const { agentName } = useData();
  const undoToast = useUndoToast();
  const [phase, setPhase] = useState<Phase>({ name: "idle" });

  const plan = async () => {
    setPhase({ name: "planning" });
    try {
      const next = await api.cliPlan(toolId, fix.id);
      if (next.kind === "self") setPhase({ name: "plan", plan: next });
      else setPhase({ name: "error", message: next.message || next.instructions || "这项修复现在不需要做。" });
    } catch (error) {
      setPhase({ name: "error", message: errorMessage(error, "无法生成计划。") });
    }
  };
  const apply = async (current: Extract<CliPlan, { kind: "self" }>) => {
    setPhase({ name: "applying", plan: current });
    try {
      const result = await api.cliApply(current.planId);
      setPhase({ name: "done", changed: result.changed || [] });
      undoToast(`已完成：${fix.label}`, result);
      await invalidateResources("cli-tools", "health-report", "history");
    } catch (error) {
      setPhase({ name: "error", message: errorMessage(error, "执行失败，没有改动任何文件。") });
    }
  };

  return (
    <div className={`fix-card ${fix.applicable ? "" : "off"}`}>
      <b>{fix.label}</b>
      {fix.reason ? <p>{fix.reason}</p> : null}
      {fix.kind === "guide" ? (
        fix.instructions ? <Commands text={fix.instructions} /> : null
      ) : !fix.applicable ? null : phase.name === "idle" || phase.name === "planning" ? (
        <div>
          <button type="button" className="btn sm" disabled={phase.name === "planning"} onClick={() => void plan()}>
            {phase.name === "planning" ? "正在生成计划…" : "查看要改什么"}
          </button>
        </div>
      ) : phase.name === "error" ? (
        <>
          <p className="form-error">{phase.message}</p>
          <div>
            <button type="button" className="btn sm ghost" onClick={() => setPhase({ name: "idle" })}>
              返回
            </button>
          </div>
        </>
      ) : phase.name === "done" ? (
        <div className="plan-list">
          {phase.changed.map((change) => (
            <p key={change.path}>
              <span className="tag">已写入</span> <code>{change.path}</code>
              {change.backup ? (
                <span className="muted">
                  {" "}
                  · 备份 <code>{change.backup}</code>
                </span>
              ) : null}
            </p>
          ))}
        </div>
      ) : (
        <div className="plan-list">
          {phase.plan.steps.map((step) => (
            <div key={step.path} className="plan-action">
              <div className="plan-line">
                <span className="tag warn">改写</span>
                <code>{step.path}</code>
              </div>
              {step.diff ? <DiffView diff={step.diff} /> : null}
              {step.backup ? (
                <p className="muted">
                  先备份到 <code>{step.backup}</code>
                </p>
              ) : null}
            </div>
          ))}
          {phase.plan.notes.map((note) => (
            <p key={note} className="plan-warning">
              {note}
            </p>
          ))}
          {phase.plan.skipped.map((item) => (
            <p key={`${item.agentId}-${item.reason}`} className="muted">
              跳过{item.agentId ? ` ${agentName(item.agentId)}` : ""}：{item.reason}
            </p>
          ))}
          <div className="acts">
            <button type="button" className="btn sm ghost" disabled={phase.name === "applying"} onClick={() => setPhase({ name: "idle" })}>
              取消
            </button>
            <button type="button" className="btn sm primary" disabled={phase.name === "applying" || !phase.plan.steps.length} onClick={() => void apply(phase.plan)}>
              {phase.name === "applying" ? "正在写入…" : "确认修改"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
