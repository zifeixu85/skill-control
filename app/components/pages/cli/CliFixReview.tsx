"use client";

import { RunningProgress } from "../../ui/RunningProgress";
import { refreshAfterWrite } from "../../../hooks/refresh";
import { usePlanApply } from "../../../hooks/usePlanApply";
import { useUndoToast } from "../../../hooks/useUndoToast";
import { api } from "../../../lib/api";
import type { CliApplyResult, CliFix, CliPlan } from "../../../lib/cli-tools";
import { useData } from "../../providers/DataProvider";
import { DiffView } from "../library/StepList";

/** Plan → per-file diff → confirm for one self-applied CLI fix. */
export function CliFixReview({
  toolId,
  fix,
  onCancel,
  onDone,
}: {
  toolId: string;
  fix: CliFix;
  onCancel: () => void;
  onDone: (result: CliApplyResult) => void;
}) {
  const { agentName } = useData();
  const undoToast = useUndoToast();
  const flow = usePlanApply<CliPlan, CliApplyResult>({
    requestKey: `${toolId}\n${fix.id}`,
    makePlan: () => api.cliPlan(toolId, fix.id),
    planIdOf: (plan) => (plan.kind === "self" && plan.steps.length ? plan.planId : null),
    expiresAtOf: (plan) => (plan.kind === "self" ? plan.expiresAt : null),
    apply: (planId) => api.cliApply(planId),
    onApplied: (result) => {
      undoToast(`已完成：${fix.label}`, result.historyId);
      onDone(result);
    },
    refresh: refreshAfterWrite,
    planFailure: "无法生成计划。",
    applyFailure: "执行失败，没有改动任何文件。",
  });
  const plan = flow.plan || (flow.planning ? flow.lastPlan : null);
  const failure = flow.planError || flow.error;
  const name = (id: string | null, serverName: string | null) => {
    if (!id) return serverName || "";
    const known = agentName(id);
    return known === id && serverName ? serverName : known;
  };

  return (
    <div className="plan-list" aria-busy={flow.planning || flow.applying}>
      {flow.expired || flow.notice ? (
        <p className="inline-note" role="status">
          {flow.expired ? "计划已过期（10 分钟），请重新生成。" : flow.notice}
        </p>
      ) : null}
      {flow.planning && !plan ? <p className="muted">正在生成计划…</p> : null}
      {plan && plan.kind !== "self" ? <p>{plan.message || plan.instructions || "这项修复现在不需要做。"}</p> : null}
      {plan?.kind === "self" ? (
        <div className={flow.planning ? "stale" : ""}>
          {plan.steps.map((step, index) => (
            <div key={`${step.path}-${index}`} className="plan-action">
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
          {plan.notes.map((note, index) => (
            <p key={`note-${index}`} className="plan-warning">
              {note}
            </p>
          ))}
          {plan.skipped.map((item, index) => (
            <p key={`skip-${item.agentId || ""}-${index}`} className="muted">
              跳过{item.agentId || item.agentName ? ` ${name(item.agentId, item.agentName)}` : ""}：{item.reason}
            </p>
          ))}
        </div>
      ) : null}
      {flow.applying ? <RunningProgress label="正在写入…" expectedMs={5_000} /> : null}
      {failure ? (
        <p className="form-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="acts">
        <button type="button" className="btn sm ghost" disabled={flow.applying} onClick={onCancel}>
          取消
        </button>
        {failure || flow.expired ? (
          <button type="button" className="btn sm" disabled={flow.applying} onClick={flow.retry}>
            重新生成
          </button>
        ) : null}
        {plan?.kind === "self" ? (
          <button type="button" className="btn sm primary" disabled={!flow.canApply} onClick={() => void flow.confirm()}>
            {flow.applying ? "正在写入…" : "确认修改"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
