"use client";

import { refreshAfterWrite } from "../../hooks/refresh";
import { usePlanApply } from "../../hooks/usePlanApply";
import { useUndoToast } from "../../hooks/useUndoToast";
import { api } from "../../lib/api";
import { joinNames } from "../../lib/format";
import type { UninstallPlan } from "../../lib/history";
import { useData } from "../providers/DataProvider";
import { ConfirmSheet } from "./ConfirmSheet";

/** 从这个 Agent 移除: link vs real directory, who else is affected, then confirm. */
export function UninstallDialog({
  skillId,
  skillTitle,
  agentId,
  onClose,
}: {
  skillId: string;
  skillTitle: string;
  agentId: string;
  onClose: () => void;
}) {
  const { agentName } = useData();
  const undoToast = useUndoToast();
  const flow = usePlanApply<UninstallPlan, unknown>({
    requestKey: `${skillId}\n${agentId}`,
    makePlan: () => api.planUninstall(skillId, agentId),
    planIdOf: (plan) => plan.planId,
    expiresAtOf: (plan) => plan.expiresAt,
    apply: (planId) => api.applyUninstall(planId),
    onApplied: (result) => {
      undoToast(`已从 ${agentName(agentId)} 移除 ${skillTitle}`, result);
      onClose();
    },
    refresh: refreshAfterWrite,
    planFailure: "不能移除这份技能。",
    applyFailure: "移除失败，没有改动任何文件。",
  });
  const plan = flow.plan || (flow.planning ? flow.lastPlan : null);

  return (
    <ConfirmSheet
      title={`从 ${agentName(agentId)} 移除 ${skillTitle}`}
      error={flow.planError || flow.error}
      notice={flow.expired ? "计划已过期，请重新生成。" : flow.notice}
      busy={flow.applying}
      confirmLabel={plan?.kind === "link" ? "移除链接" : "移到回收站"}
      canConfirm={flow.canApply}
      onConfirm={() => void flow.confirm()}
      onClose={onClose}
      onRetry={flow.planError || flow.expired ? flow.retry : undefined}
      footnote="移除的目录放进回收站，可以随时恢复；也可以在历史里撤销"
    >
      {flow.planning && !plan ? <p className="muted">正在检查…</p> : null}
      {plan ? (
        <div className={`plan-list ${flow.planning ? "stale" : ""}`}>
          <p>
            {plan.kind === "link"
              ? "这是一个链接，只删除链接本身，原来的技能目录不受影响。"
              : "这是一个实体目录，会整体移到 ~/.agent-skill-manager/trash。"}
          </p>
          {plan.steps.map((step, index) => (
            <div className="plan-action" key={`${step.type}-${step.path}-${index}`}>
              <div className="plan-line">
                <span className="tag warn">{step.type === "unlink" ? "删除链接" : "移到回收站"}</span>
                <code>{step.path}</code>
              </div>
              {step.description ? <p>{step.description}</p> : null}
              {step.to ? (
                <p className="muted">
                  移到 <code>{step.to}</code>
                </p>
              ) : null}
            </div>
          ))}
          {plan.alsoAffects.length ? (
            <p className="plan-warning">
              {joinNames(plan.alsoAffects.map(agentName))} 也通过同一个位置使用这个技能，移除后它们也会看不到。
            </p>
          ) : null}
          {/* The line above already names the affected Agents; the service's text repeats them as ids. */}
          {plan.warning && !plan.alsoAffects.length ? <p className="plan-warning">{plan.warning}</p> : null}
        </div>
      ) : null}
    </ConfirmSheet>
  );
}
