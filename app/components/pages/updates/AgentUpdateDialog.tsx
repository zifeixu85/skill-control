"use client";

import { useState } from "react";
import { invalidateResources, primeResource } from "../../../hooks/useResource";
import { usePlanApply } from "../../../hooks/usePlanApply";
import { useUndoToast } from "../../../hooks/useUndoToast";
import type { AgentUpdatePlan, AgentUpdateResult, AgentVersion } from "../../../lib/agent-versions";
import { api, errorMessage } from "../../../lib/api";
import { useToast } from "../../providers/ToastProvider";
import { Segmented } from "../../ui/basics";
import { RunningProgress } from "../../ui/RunningProgress";
import { agentJobs } from "./agentJobs";
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
type Mode = "terminal" | "background" | "here";

const MODES: { id: Mode; label: string; note: string }[] = [
  { id: "terminal", label: "在终端中更新", note: "打开你的终端运行上面的命令，可以看到全部输出；Skill Control 不等它，完成后点“重新检查”。" },
  { id: "background", label: "在后台更新", note: "在后台运行，可以继续用 Skill Control；完成后会提醒你，并显示新版本。" },
  { id: "here", label: "在这里更新", note: "在这个窗口里运行并等到结束，期间不能关闭这个对话框。" },
];

/** On macOS the terminal is the natural place for a slow CLI update. */
const defaultMode = (): Mode => (typeof navigator !== "undefined" && /Mac/iu.test(navigator.userAgent) ? "terminal" : "here");

/** 一键更新: plan (commands + effects) → choose where it runs → explicit confirm → result or hand-off. */
export function AgentUpdateDialog({ agent, updateId, onClose }: { agent: AgentVersion; updateId: string; onClose: () => void }) {
  const undoToast = useUndoToast();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [handoff, setHandoff] = useState<"terminal" | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [rechecking, setRechecking] = useState(false);
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
  const busy = flow.applying || starting;

  const start = async () => {
    if (mode === "here") return void flow.confirm();
    const planId = flow.planId;
    if (!planId || !flow.canApply) return;
    setStarting(true);
    setStartError("");
    try {
      if (mode === "terminal") {
        await api.applyAgentUpdateInTerminal(planId);
        setHandoff("terminal");
      } else {
        const jobId = await api.applyAgentUpdateInBackground(planId);
        if (!jobId) throw new Error("服务没有返回后台任务，可能还不支持后台更新。请改用“在这里更新”。");
        agentJobs.track(agent.id, agent.name, jobId);
        toast.show(`已在后台开始更新 ${agent.name}，可以继续使用 Skill Control`);
        onClose();
      }
    } catch (error) {
      setStartError(errorMessage(error, mode === "terminal" ? "没能打开终端。" : "没能开始后台更新。"));
      flow.retry();
    } finally {
      setStarting(false);
    }
  };
  const recheck = async () => {
    setRechecking(true);
    try {
      const fresh = await api.checkAgentVersions();
      if (fresh) primeResource(AGENT_VERSIONS_KEY, fresh);
      else await invalidateResources(AGENT_VERSIONS_KEY);
      const row = fresh?.agents.find((item) => item.id === agent.id);
      toast.show(row ? (row.status === "update-available" ? `${agent.name} 还是 ${row.installed?.version || "旧版本"}，终端里可能还没完成` : `${agent.name} 现在是 ${row.installed?.version || "最新版本"}`) : "已重新检查");
      if (row && row.status !== "update-available") onClose();
    } catch (error) {
      toast.show(errorMessage(error, "重新检查失败。"), { tone: "error" });
    } finally {
      setRechecking(false);
    }
  };

  const chosen = MODES.find((item) => item.id === mode) || MODES[0];
  const footer = flow.result ? (
    <button type="button" className="btn primary" onClick={onClose}>
      完成
    </button>
  ) : handoff === "terminal" ? (
    <>
      <span className="muted small">终端里的命令跑完后再检查一次版本。</span>
      <div className="acts-right">
        <button type="button" className="btn ghost" onClick={onClose}>
          关闭
        </button>
        <button type="button" className="btn primary" disabled={rechecking} onClick={() => void recheck()}>
          {rechecking ? "正在检查…" : "重新检查"}
        </button>
      </div>
    </>
  ) : (
    <>
      <span className="muted small">{flow.applying ? "正在运行，请不要关闭…" : starting ? "正在开始…" : "点下面的按钮才会运行上面的命令"}</span>
      <div className="acts-right">
        <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
          取消
        </button>
        {flow.planError || flow.expired ? (
          <button type="button" className="btn" disabled={busy} onClick={flow.retry}>
            重新生成
          </button>
        ) : null}
        <button type="button" className="btn primary" disabled={!flow.canApply || busy} onClick={() => void start()}>
          {flow.applying ? "正在更新…" : starting ? "正在开始…" : mode === "terminal" ? "在终端中打开" : mode === "background" ? "开始后台更新" : "确认更新"}
        </button>
      </div>
    </>
  );
  return (
    <Modal title={plan?.title || `一键更新 ${agent.name}`} onClose={onClose} busy={busy} wide footer={footer}>
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
      {handoff === "terminal" ? (
        <div className="au-handoff" role="status">
          <b>已在终端中打开，完成后点「重新检查」</b>
          <p className="muted small">命令在你的终端里运行，输出也在那里。关掉这个对话框不影响它。</p>
        </div>
      ) : flow.result ? (
        <ResultBody result={flow.result} />
      ) : plan ? (
        <div className={flow.planning ? "stale" : ""}>
          <PlanBody plan={plan} />
          {flow.applying ? (
            <RunningProgress label={`正在更新 ${agent.name}…`} total={plan.steps.length} expectedMs={60_000} detail="CLI 更新可能要几分钟；完成前不能关闭这个对话框。" />
          ) : (
            <fieldset className="au-modes" disabled={busy}>
              <legend>在哪里运行</legend>
              <Segmented label="在哪里运行" value={mode} onChange={setMode} items={MODES.map((item) => ({ id: item.id, label: item.label }))} />
              <p className="muted small">{chosen.note}</p>
            </fieldset>
          )}
        </div>
      ) : flow.planError ? null : flow.planning ? (
        <p className="muted">正在生成更新计划…</p>
      ) : (
        <p className="form-error" role="alert">
          服务没有给出可以执行的更新计划，请在 {agent.name} 里检查更新，或用“复制 AI 指令”。
        </p>
      )}
      {flow.planError || flow.error || startError ? (
        <p className="form-error" role="alert">
          {flow.planError || flow.error || startError}
        </p>
      ) : null}
    </Modal>
  );
}
