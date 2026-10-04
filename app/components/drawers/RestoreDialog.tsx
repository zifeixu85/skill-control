"use client";

import { useState } from "react";
import { refreshAfterWrite } from "../../hooks/refresh";
import { usePlanApply } from "../../hooks/usePlanApply";
import { useUndoToast } from "../../hooks/useUndoToast";
import { api } from "../../lib/api";
import { RESTORE_STEP_LABELS, toggleUnit, type RestorePlan, type RestoreStep } from "../../lib/history";
import { useData } from "../providers/DataProvider";
import { ConfirmSheet } from "./ConfirmSheet";
import { RestoreUnits } from "./RestoreUnits";

function StepText({ step }: { step: RestoreStep }) {
  if (step.type === "restore-backup" && step.from) {
    return (
      <>
        用备份 <code>{step.from}</code> 替换现在的内容
      </>
    );
  }
  if (step.type === "trash-created") return <>这次创建的目录会移到回收站（可以再恢复）</>;
  if (step.type === "restore-trash") return <>从回收站放回原位</>;
  return step.from ? (
    <>
      从 <code>{step.from}</code> 放回
    </>
  ) : (
    <>恢复到这次改动之前</>
  );
}

function InstallSteps({ steps }: { steps: RestoreStep[] }) {
  const { agentName } = useData();
  return (
    <>
      {steps.map((step, index) => (
        <div className="plan-action" key={`${step.type}-${step.target}-${index}`}>
          <div className="plan-line">
            <span className={`tag ${step.type === "trash-created" ? "warn" : ""}`}>{RESTORE_STEP_LABELS[step.type] || step.type}</span>
            <code>{step.target}</code>
          </div>
          <p>
            {step.agentId ? `${agentName(step.agentId)} · ` : ""}
            <StepText step={step} />
          </p>
        </div>
      ))}
    </>
  );
}

/**
 * Undo of one history entry: plan-restore → show what goes back where → confirm → apply.
 * Library applies and CLI fixes undo per unit; the user picks units and the plan follows.
 */
export function RestoreDialog({ historyId, onClose }: { historyId: string; onClose: () => void }) {
  const undoToast = useUndoToast();
  const [select, setSelect] = useState<string[] | null>(null);
  const flow = usePlanApply<RestorePlan, unknown>({
    requestKey: JSON.stringify([historyId, select]),
    makePlan: () => api.planRestore(historyId, select),
    planIdOf: (plan) => (plan.steps.length || plan.units.some((unit) => unit.selected) ? plan.planId : null),
    expiresAtOf: (plan) => plan.expiresAt,
    apply: (planId) => api.applyRestore(planId),
    onApplied: (result) => {
      undoToast("已撤销", result);
      onClose();
    },
    refresh: refreshAfterWrite,
    planFailure: "这条记录不能撤销。",
    applyFailure: "撤销失败，没有改动任何文件。",
  });
  const plan = flow.plan || (flow.planning ? flow.lastPlan : null);
  const unitMode = Boolean(plan?.units.length);
  const notice = flow.expired ? "计划已过期，请重新生成。" : flow.notice || (flow.plan && !flow.planId ? flow.plan.message || "" : "");

  return (
    <ConfirmSheet
      title="撤销这次改动"
      error={flow.planError || flow.error}
      notice={notice}
      busy={flow.applying}
      confirmLabel={unitMode ? `撤销选中的 ${plan?.units.filter((unit) => unit.selected).length || 0} 项` : "确认撤销"}
      canConfirm={flow.canApply}
      onConfirm={() => void flow.confirm()}
      onClose={onClose}
      onRetry={flow.planError || flow.expired ? flow.retry : undefined}
      footnote="撤销前会先备份当前内容，撤销本身也可以再撤销"
    >
      {flow.planning && !plan ? <p className="muted">正在生成撤销计划…</p> : null}
      {plan ? (
        <div className={`plan-list ${flow.planning ? "stale" : ""}`} aria-busy={flow.planning}>
          {unitMode ? (
            <RestoreUnits
              units={plan.units}
              disabled={flow.planning || flow.applying}
              onToggle={(id, on) => setSelect(toggleUnit(plan.units, id, on))}
            />
          ) : (
            <InstallSteps steps={plan.steps} />
          )}
          {plan.warnings
            // Unit rows already show their own conflict or reason.
            .filter(
              (warning) =>
                !unitMode ||
                !plan.units.some((unit) => warning.startsWith(`${unit.title}：`) || warning === unit.conflict || warning === unit.unrestorable),
            )
            .map((warning) => (
              <p key={warning} className="plan-warning">
                {warning}
              </p>
            ))}
        </div>
      ) : null}
    </ConfirmSheet>
  );
}
