"use client";

import { invalidateResources } from "../../../hooks/useResource";
import { usePlanApply } from "../../../hooks/usePlanApply";
import { useUndoToast } from "../../../hooks/useUndoToast";
import type { AgentUpdatePlan, AgentUpdateResult, AgentVersion } from "../../../lib/agent-versions";
import { api } from "../../../lib/api";
import { Modal } from "../../ui/Modal";
import { AGENT_VERSIONS_KEY } from "./AgentVersions";

function PlanBody({ plan }: { plan: AgentUpdatePlan }) {
  return (
    <div className="au-plan">
      <section>
        <h3 className="mini-h">将按顺序运行</h3>
        <ol className="au-steps">
          {plan.steps.map((step, index) => (
            <li key={`${index}-${step.display}`}>
              <code className="command">{step.display}</code>
            </li>
          ))}
        </ol>
      </section>
      {plan.effects.length ? (
        <section>
          <h3 className="mini-h">会带来的变化</h3>
          <ul className="plain-list">
            {plan.effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {plan.afterCheck ? <p className="muted small">完成后：{plan.afterCheck}</p> : null}
      <p className="muted small">每一步最多运行 5 分钟。这类更新不能从历史撤销，但会留下操作记录。</p>
    </div>
  );
}

function ResultBody({ result }: { result: AgentUpdateResult }) {
  return (
    <div className="au-result" role="status" aria-live="polite">
      <p className={result.ok ? "au-ok" : "form-error"}>
        {result.ok ? "更新完成" : "有步骤没有成功，当前版本可能没有变化"}
        {result.version.before || result.version.after ? (
          <span className="versions">
            {" "}
            <code>{result.version.before || "未知"}</code>
            {" → "}
            <code className="latest">{result.version.after || "未知"}</code>
          </span>
        ) : null}
      </p>
      {result.steps.map((step, index) => (
        <details key={`${index}-${step.display}`} className="au-output" open={step.exitCode !== 0}>
          <summary>
            <code>{step.display}</code>
            <span className={`tag ${step.exitCode === 0 ? "" : "danger"}`}>{step.exitCode === 0 ? "成功" : `退出码 ${step.exitCode ?? "未知"}`}</span>
          </summary>
          {step.output ? <pre className="code wrap">{step.output}</pre> : <p className="muted small">没有输出。</p>}
        </details>
      ))}
    </div>
  );
}

/** 一键更新: plan (commands + effects) → explicit confirm → run → result and the new version. */
export function AgentUpdateDialog({ agent, updateId, onClose }: { agent: AgentVersion; updateId: string; onClose: () => void }) {
  const undoToast = useUndoToast();
  const flow = usePlanApply<AgentUpdatePlan | null, AgentUpdateResult>({
    requestKey: updateId,
    makePlan: () => api.planAgentUpdate(updateId),
    planIdOf: (plan) => plan?.planId,
    expiresAtOf: (plan) => plan?.expiresAt,
    apply: (planId) => api.applyAgentUpdate(planId),
    onApplied: (result) =>
      undoToast(result.ok ? `已更新 ${agent.name}${result.version.after ? ` 到 ${result.version.after}` : ""}` : `${agent.name} 没有更新成功，请查看输出`, null, result.ok ? "default" : "error"),
    refresh: () => void invalidateResources(AGENT_VERSIONS_KEY, "history"),
    planFailure: "无法生成更新计划。",
    applyFailure: "更新失败。",
  });
  const plan = flow.plan;
  const notice = flow.expired ? "计划已过期，请重新生成。" : flow.notice;
  const footer = flow.result ? (
    <button type="button" className="btn primary" onClick={onClose}>
      完成
    </button>
  ) : (
    <>
      <span className="muted small">{flow.applying ? "正在运行，请不要关闭…" : "点“确认更新”才会运行上面的命令"}</span>
      <div className="acts-right">
        <button type="button" className="btn ghost" disabled={flow.applying} onClick={onClose}>
          取消
        </button>
        {flow.planError || flow.expired ? (
          <button type="button" className="btn" disabled={flow.applying} onClick={flow.retry}>
            重新生成
          </button>
        ) : null}
        <button type="button" className="btn primary" disabled={!flow.canApply} onClick={() => void flow.confirm()}>
          {flow.applying ? "正在更新…" : "确认更新"}
        </button>
      </div>
    </>
  );
  return (
    <Modal title={plan?.title || `一键更新 ${agent.name}`} onClose={onClose} busy={flow.applying} wide footer={footer}>
      <p className="au-versions">
        {agent.name}
        <span className="versions">
          {" "}
          <code>{agent.installed?.version || "未知"}</code>
          {agent.latest ? (
            <>
              {" → "}
              <code className="latest">{agent.latest.version}</code>
            </>
          ) : null}
        </span>
      </p>
      {notice ? <p className="inline-note" role="status">{notice}</p> : null}
      {flow.result ? (
        <ResultBody result={flow.result} />
      ) : plan ? (
        <div className={flow.planning ? "stale" : ""}>
          <PlanBody plan={plan} />
        </div>
      ) : flow.planError ? null : flow.planning ? (
        <p className="muted">正在生成更新计划…</p>
      ) : (
        <p className="form-error" role="alert">
          服务没有给出可以执行的更新计划，请在 {agent.name} 里检查更新，或用“复制 AI 指令”。
        </p>
      )}
      {flow.planError || flow.error ? (
        <p className="form-error" role="alert">
          {flow.planError || flow.error}
        </p>
      ) : null}
    </Modal>
  );
}
