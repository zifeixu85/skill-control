"use client";

import { useEffect, useState } from "react";
import { invalidateResources } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import { formatMonthDay, joinNames } from "../../../lib/format";
import { isReadOnlyInstance, pickSourceInstance, type SkillView } from "../../../lib/skill-model";
import type { SyncAction, SyncMode, SyncPlan } from "../../../lib/types";
import { useData } from "../../providers/DataProvider";
import { useToast } from "../../providers/ToastProvider";

type PlanState =
  | { status: "loading" }
  | { status: "ready"; plan: SyncPlan; sourceId: string; mode: SyncMode }
  | { status: "error"; message: string };

const ACTION_LABELS: Record<SyncAction["action"], string> = {
  create: "新建",
  replace: "替换（先备份旧版本）",
  noop: "不需要改动",
};

export function ActionDetail({ action, agentName }: { action: SyncAction; agentName: (id: string) => string }) {
  const others = (action.alsoVisibleTo || []).filter((id) => id !== action.agentId);
  return (
    <div className="plan-action">
      <div className="plan-line">
        <span className={`tag ${action.action === "noop" ? "mute" : action.action === "replace" ? "warn" : ""}`}>
          {ACTION_LABELS[action.action]}
        </span>
        <code title={action.destination}>{action.destination}</code>
      </div>
      {action.realDestination && action.realDestination !== action.destination ? (
        <p>这是一个软链接，实际写入 <code>{action.realDestination}</code>，链接本身保持不变。</p>
      ) : null}
      {action.reason === "same-directory" ? <p>目标和来源是同一个文件夹，已经是这一份了。</p> : null}
      {action.reason === "shared-with-target" ? (
        <p>和 {agentName(action.sharedWithAgentId || "")} 共用同一个文件夹，只写一次。</p>
      ) : null}
      {action.action === "noop" && !action.reason && action.identical ? <p>{agentName(action.agentId)} 里已经有内容相同的一份。</p> : null}
      {others.length ? (
        <p className="plan-shared">
          写入后 <b>{joinNames(others.map(agentName))}</b> 也会看到这次改动——它们读的是同一个文件夹。
        </p>
      ) : null}
      {action.backup ? (
        <p>
          旧版本备份到 <code>{action.backup}</code>
        </p>
      ) : null}
      {action.skippedLinks?.length ? <p>有 {action.skippedLinks.length} 个指向技能外部的链接不会被复制。</p> : null}
    </div>
  );
}

/** Dry-run plan shown inline; nothing is written until the user presses 安装. */
export function InstallPlan({ view, agentId, onDone }: { view: SkillView; agentId: string; onDone: () => void }) {
  const { config, agentName, agentsById, primary } = useData();
  const toast = useToast();
  const candidates = view.skill.instances.filter((instance) => instance.agentId !== agentId);
  const initial = pickSourceInstance(view, agentId, primary);
  const [sourceId, setSourceId] = useState(initial?.id || "");
  const [state, setState] = useState<PlanState>({ status: "loading" });
  const [running, setRunning] = useState(false);
  const agent = agentsById.get(agentId);
  const mode: SyncMode = agent?.copyOnly ? "copy" : config.data?.syncMode || "copy";

  useEffect(() => {
    if (!sourceId) return undefined;
    let cancelled = false;
    api.planSync({ sourceInstanceId: sourceId, targetAgentIds: [agentId], mode }).then(
      (plan) => !cancelled && setState({ status: "ready", plan, sourceId, mode }),
      (error: unknown) => !cancelled && setState({ status: "error", message: errorMessage(error, "无法生成安装计划。") }),
    );
    return () => {
      cancelled = true;
    };
  }, [sourceId, agentId, mode]);

  const install = async () => {
    if (state.status !== "ready" || state.sourceId !== sourceId || state.mode !== mode) return;
    setRunning(true);
    try {
      // Execute exactly what the shown plan was generated for.
      const result = await api.executeSync({ sourceInstanceId: state.sourceId, targetAgentIds: [agentId], mode: state.mode });
      const done = result.actions.filter((action) => action.result === "completed");
      toast.show(done.length ? `已装到 ${agentName(agentId)}：${view.title}` : `${agentName(agentId)} 里已经是这一份，没有改动`);
      onDone();
      await invalidateResources("scan", "files:skill:", "file:skill:", "detail:skill", "usage:skill:", "health-report", "updates");
    } catch (error) {
      setState({ status: "error", message: errorMessage(error, "安装失败，没有写入任何文件。") });
    } finally {
      setRunning(false);
    }
  };

  const hashes = new Set(candidates.map((instance) => instance.hash));
  const current = state.status === "ready" && state.sourceId === sourceId && state.mode === mode;
  const plan = current ? state.plan : null;
  const writes = plan ? plan.actions.filter((action) => action.action !== "noop").length : 0;

  if (!initial) {
    return (
      <div className="confirm" role="group" aria-label={`装到 ${agentName(agentId)}`}>
        <b>没有可以复制的来源</b>
        <p>这个技能只在 {agentName(agentId)} 里有。</p>
        <div className="acts">
          <button type="button" className="btn sm ghost" onClick={onDone}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="confirm" role="group" aria-label={`装到 ${agentName(agentId)}`} aria-busy={state.status === "loading"}>
      <b>装到 {agentName(agentId)}</b>
      {hashes.size > 1 ? (
        <label className="field">
          <span>用哪一份</span>
          <select
            value={sourceId}
            onChange={(event) => {
              setState({ status: "loading" });
              setSourceId(event.target.value);
            }}
          >
            {candidates.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.agentName} · {instance.path}
                {instance.modifiedAt ? ` · ${formatMonthDay(instance.modifiedAt)}更新` : ""}
                {isReadOnlyInstance(instance) ? " · 只读来源" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p>
          从 {initial.agentName} 的副本复制：<code>{initial.path}</code>
        </p>
      )}
      {state.status === "loading" ? <p className="muted">正在生成安装计划…</p> : null}
      {state.status === "error" ? (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      ) : null}
      {plan ? (
        <>
          {plan.actions.map((action) => (
            <ActionDetail key={`${action.agentId}-${action.destination}`} action={action} agentName={agentName} />
          ))}
          {(plan.warnings || []).map((warning) => (
            <p key={warning} className="plan-warning">
              {warning}
            </p>
          ))}
          <p className="muted">
            {mode === "copy" ? "复制一份独立的副本。" : "建立软链接，两边共用一份。"}
            Skill Control 不会删除任何技能。
          </p>
        </>
      ) : null}
      <div className="acts">
        <button type="button" className="btn sm ghost" onClick={onDone} disabled={running}>
          取消
        </button>
        <button type="button" className="btn sm primary" disabled={!plan || !writes || running} onClick={install}>
          {running ? "正在安装…" : "安装"}
        </button>
      </div>
    </div>
  );
}
