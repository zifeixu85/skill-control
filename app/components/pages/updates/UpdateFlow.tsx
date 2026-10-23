"use client";

import { useState } from "react";
import { refreshAfterWrite } from "../../../hooks/refresh";
import { useMarkBusy } from "../../../hooks/useBusy";
import { usePlanApply } from "../../../hooks/usePlanApply";
import { useUndoToast } from "../../../hooks/useUndoToast";
import { api } from "../../../lib/api";
import { CHOICE_TEXT, type ApplyResult, type ConflictChoice, type UpdatePlan, type UpdateUnit } from "../../../lib/updates";
import { CopyPathButton } from "../../files/ConfigDetailView";
import { PlanView, ResultView } from "./UpdateViews";
import { RunningProgress } from "../../ui/RunningProgress";

function Intro({ unit, onStart }: { unit: UpdateUnit; onStart: () => void }) {
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
          <button type="button" className="btn sm primary" onClick={onStart}>
            {unit.action.kind === "guide" ? "查看步骤" : "生成更新计划"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

const confirmable = (plan: UpdatePlan) => (plan.kind === "plan" && plan.action !== "none" ? plan.planId : null);

function UpdateReview({ unit, onCancel }: { unit: UpdateUnit; onCancel: () => void }) {
  const undoToast = useUndoToast();
  const [choice, setChoice] = useState<ConflictChoice | undefined>(undefined);
  const flow = usePlanApply<UpdatePlan, ApplyResult>({
    requestKey: JSON.stringify([unit.unitKey, choice || null]),
    makePlan: () => api.planUpdate(unit.unitKey, choice),
    planIdOf: confirmable,
    expiresAtOf: (plan) => (plan.kind === "plan" ? plan.expiresAt : null),
    apply: (planId) => api.applyUpdate(planId),
    // Only self-updates keep backups the service can put back.
    onApplied: (result) =>
      undoToast(
        result.ok ? `已更新 ${unit.title}` : `${unit.title} 没有全部完成，请查看输出`,
        result.kind === "self" ? result.historyId : null,
        result.ok ? "default" : "error",
      ),
    // Outside the apply: a failed refresh can never turn a finished update into an error.
    refresh: refreshAfterWrite,
    planFailure: "无法生成更新计划。",
    applyFailure: "更新失败，已写入的目录会从备份恢复。",
  });
  // The drawer can't be closed (button or Esc) while the update runs.
  useMarkBusy(flow.applying);

  if (flow.result) {
    return (
      <div className="confirm quiet" role="status" aria-live="polite">
        <b>{flow.result.ok ? "更新完成" : "部分步骤失败"}</b>
        <ResultView result={flow.result} />
      </div>
    );
  }
  const plan = flow.plan || (flow.planning ? flow.lastPlan : null);
  const failure = flow.planError || flow.error;
  const notice = flow.expired ? "计划已过期（10 分钟），请重新生成。" : flow.notice;
  const cancel = (
    <button type="button" className="btn sm ghost" disabled={flow.applying} onClick={onCancel}>
      取消
    </button>
  );
  return (
    <div className={`confirm ${plan?.kind === "guide" ? "quiet" : ""}`} aria-busy={flow.planning || flow.applying}>
      {notice ? <p className="inline-note" role="status">{notice}</p> : null}
      {flow.planning && !plan ? <p className="muted">正在生成计划…</p> : null}
      <div className={flow.planning ? "stale" : ""}>
        {plan?.kind === "choice" ? (
          <>
            <b>先决定怎么处理本地修改</b>
            <p>{plan.message || "你在本地改过这个技能。"}</p>
            <div className="choices">
              {plan.choices.map((item) => (
                <button key={item} type="button" className="choice" disabled={flow.planning} onClick={() => setChoice(item)}>
                  <b>{CHOICE_TEXT[item].title}</b>
                  <span>{CHOICE_TEXT[item].detail}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
        {plan?.kind === "guide" ? (
          <>
            <b>需要在来源产品里更新</b>
            <p>{plan.instructions || "请在安装它的产品里更新。"}</p>
            {plan.command ? (
              <div className="command-copy">
                <code className="command">{plan.command}</code>
                <CopyPathButton path={plan.command} label="复制命令" />
              </div>
            ) : null}
          </>
        ) : null}
        {plan?.kind === "incomplete" ? (
          <p className="form-error" role="alert">
            {plan.message}
          </p>
        ) : null}
        {plan?.kind === "plan" ? (
          <>
            <b>{plan.action === "delegate" ? "将运行这些命令" : plan.action === "self" ? "更新计划" : "无需改动"}</b>
            <PlanView plan={plan} />
          </>
        ) : null}
      </div>
      {flow.applying ? (
        <RunningProgress
          label={plan?.kind === "plan" && plan.action === "delegate" ? "正在运行更新命令…" : "正在下载并替换…"}
          total={plan?.kind === "plan" ? plan.steps.length : null}
          expectedMs={plan?.kind === "plan" && plan.action === "delegate" ? 60_000 : 15_000}
          detail="完成前请不要关闭这个面板。"
        />
      ) : null}
      {failure ? (
        <p className="form-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="acts">
        {cancel}
        {failure || flow.expired || plan?.kind === "incomplete" ? (
          <button type="button" className="btn sm" disabled={flow.applying} onClick={flow.retry}>
            重新生成
          </button>
        ) : null}
        {plan?.kind === "plan" && plan.action !== "none" ? (
          <button type="button" className="btn sm primary" disabled={!flow.canApply} onClick={() => void flow.confirm()}>
            {flow.applying ? "正在执行…" : plan.action === "delegate" ? "确认运行" : "确认更新"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Plan → explicit confirm → apply → result. Nothing runs without the confirm click. */
export function UpdateFlow({ unit }: { unit: UpdateUnit }) {
  const [open, setOpen] = useState(false);
  return open ? <UpdateReview unit={unit} onCancel={() => setOpen(false)} /> : <Intro unit={unit} onStart={() => setOpen(true)} />;
}
