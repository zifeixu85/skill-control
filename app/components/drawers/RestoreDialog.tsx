"use client";

import { useEffect, useState } from "react";
import { invalidateResources } from "../../hooks/useResource";
import { useUndoToast } from "../../hooks/useUndoToast";
import { api, ApiError, errorMessage } from "../../lib/api";
import { RESTORE_STEP_LABELS, type RestorePlan } from "../../lib/history";
import { useData } from "../providers/DataProvider";
import { ConfirmSheet } from "./ConfirmSheet";

/** Undo of one history entry: plan-restore → show what goes back where → confirm → apply. */
export function RestoreDialog({ historyId, onClose }: { historyId: string; onClose: () => void }) {
  const { agentName } = useData();
  const undoToast = useUndoToast();
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.planRestore(historyId).then(
      (next) => !cancelled && setPlan(next),
      (planError: unknown) => !cancelled && setError(errorMessage(planError, "这条记录不能撤销。")),
    );
    return () => {
      cancelled = true;
    };
  }, [historyId, attempt]);

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.applyRestore(plan.planId);
      undoToast("已撤销", result);
      onClose();
      await invalidateResources("scan", "files:", "file:", "detail:", "library", "trash", "history", "health-report", "updates");
    } catch (applyError) {
      if (applyError instanceof ApiError && applyError.status === 409) {
        setPlan(null);
        setError("目标在生成计划之后又被改过。已重新生成计划，请再看一遍。");
        setAttempt((value) => value + 1);
      } else {
        setError(errorMessage(applyError, "撤销失败，没有改动任何文件。"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmSheet
      title="撤销这次改动"
      error={error}
      busy={busy}
      confirmLabel="确认撤销"
      canConfirm={Boolean(plan?.steps.length)}
      onConfirm={() => void apply()}
      onClose={onClose}
      footnote="撤销前会先备份当前内容，撤销本身也可以再撤销"
    >
      {!plan && !error ? <p className="muted">正在生成撤销计划…</p> : null}
      {plan ? (
        <div className="plan-list">
          {plan.steps.map((step, index) => (
            <div className="plan-action" key={`${step.type}-${index}`}>
              <div className="plan-line">
                <span className={`tag ${step.type === "trash-created" ? "warn" : ""}`}>{RESTORE_STEP_LABELS[step.type] || step.type}</span>
                <code>{step.target}</code>
              </div>
              <p>
                {step.agentId ? `${agentName(step.agentId)} · ` : ""}
                {step.type === "restore-backup" && step.from ? (
                  <>
                    用备份 <code>{step.from}</code> 替换现在的内容
                  </>
                ) : step.type === "trash-created" ? (
                  "这次创建的目录会移到回收站（可以再恢复）"
                ) : (
                  "从回收站放回原位"
                )}
              </p>
            </div>
          ))}
          {plan.warnings.map((warning) => (
            <p key={warning} className="plan-warning">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
    </ConfirmSheet>
  );
}
