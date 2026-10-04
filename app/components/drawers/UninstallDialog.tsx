"use client";

import { useEffect, useState } from "react";
import { invalidateResources } from "../../hooks/useResource";
import { useUndoToast } from "../../hooks/useUndoToast";
import { api, errorMessage } from "../../lib/api";
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
  const [plan, setPlan] = useState<UninstallPlan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.planUninstall(skillId, agentId).then(
      (next) => !cancelled && setPlan(next),
      (planError: unknown) => !cancelled && setError(errorMessage(planError, "不能移除这份技能。")),
    );
    return () => {
      cancelled = true;
    };
  }, [skillId, agentId]);

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.applyUninstall(plan.planId);
      undoToast(`已从 ${agentName(agentId)} 移除 ${skillTitle}`, result);
      onClose();
      await invalidateResources("scan", "files:", "file:", "detail:", "library", "trash", "history", "health-report", "updates");
    } catch (applyError) {
      setError(errorMessage(applyError, "移除失败，没有改动任何文件。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmSheet
      title={`从 ${agentName(agentId)} 移除 ${skillTitle}`}
      error={error}
      busy={busy}
      confirmLabel={plan?.kind === "link" ? "移除链接" : "移到回收站"}
      canConfirm={Boolean(plan)}
      onConfirm={() => void apply()}
      onClose={onClose}
      footnote="移除的目录放进回收站，可以随时恢复；也可以在历史里撤销"
    >
      {!plan && !error ? <p className="muted">正在检查…</p> : null}
      {plan ? (
        <div className="plan-list">
          <p>
            {plan.kind === "link"
              ? "这是一个链接，只删除链接本身，原来的技能目录不受影响。"
              : "这是一个实体目录，会整体移到 ~/.agent-skill-manager/trash。"}
          </p>
          {plan.steps.map((step, index) => (
            <div className="plan-action" key={`${step.type}-${index}`}>
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
          {plan.warning ? <p className="plan-warning">{plan.warning}</p> : null}
        </div>
      ) : null}
    </ConfirmSheet>
  );
}
