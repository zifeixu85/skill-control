"use client";

import { useId, useState } from "react";
import { refreshAfterWrite } from "../../hooks/refresh";
import { useMarkBusy } from "../../hooks/useBusy";
import { usePlanApply } from "../../hooks/usePlanApply";
import { useResource } from "../../hooks/useResource";
import { useUndoToast } from "../../hooks/useUndoToast";
import { api } from "../../lib/api";
import { formatMonthDay } from "../../lib/format";
import { installDone, OUTCOME_TEXT, runningItems, type InstallPlan, type InstallResult } from "../../lib/install-plan";
import { initialOption, installBody, installMessage, installMethod, scopeOptionTexts, scopeRequest, shortNames, type ScopeOption } from "../../lib/install-scope";
import { TIER_HINTS, TIER_LABELS, type LibraryPlanItem } from "../../lib/library";
import { isConflict } from "../../lib/library-review";
import { isReadOnlyInstance, pickSourceInstance, type SkillView } from "../../lib/skill-model";
import type { ImportedSkill } from "../../lib/types";
import { PlanItem } from "../pages/library/PlanItem";
import { ActionDetail } from "../pages/skills/ActionDetail";
import { useData } from "../providers/DataProvider";
import { AgentAvatar } from "../ui/Avatar";
import { Modal } from "../ui/Modal";
import { RunningProgress } from "../ui/RunningProgress";

/** What is being installed: a copy that is already on this Mac, or an imported package. */
export type InstallSource = { kind: "instance"; view: SkillView } | { kind: "import"; skill: ImportedSkill };

const titleOf = (source: InstallSource | null) =>
  source?.kind === "import" ? source.skill.displayName || source.skill.name : source?.kind === "instance" ? source.view.title : "";

/**
 * One scope choice for every install entry point: 所有常用 Agent（推荐）/ 选择 Agent / 只装到某个
 * Agent → the service's plan for exactly that choice (POST /api/install/plan) → 确认安装.
 * Nothing is written before the confirm; the result toast offers 撤销.
 */
export function useInstallScope(source: InstallSource | null, agentId: string | null, onDone: () => void) {
  const { agents, primary, config, agentName } = useData();
  const library = useResource("library", () => api.library());
  const undoToast = useUndoToast();
  const method = installMethod(config.data);
  const [option, setOption] = useState<ScopeOption>(() => initialOption(agentId));
  const [chosen, setChosen] = useState<string[]>(() => (agentId ? [agentId] : []));
  const [single, setSingle] = useState<string | null>(agentId);
  const [choices, setChoices] = useState<Record<string, string>>({});

  const view = source?.kind === "instance" ? source.view : null;
  const candidates = view ? view.skill.instances.filter((instance) => instance.agentId !== agentId) : [];
  const initial = view ? pickSourceInstance(view, agentId || "", primary) : null;
  const [sourceId, setSourceId] = useState(initial?.id || "");
  const sourceAgent = candidates.find((instance) => instance.id === sourceId)?.agentId || null;

  const libraryAgent = (id: string) => library.data?.agents.find((agent) => agent.agentId === id) || null;
  const installable = agents.filter((agent) => agent.available && !agent.refuseInstall);
  const ordered = [...installable].sort((left, right) => Number(primary.includes(right.id)) - Number(primary.includes(left.id)));
  // Native readers see every library skill: nothing to choose for them.
  const natives = method === "library" ? installable.filter((agent) => libraryAgent(agent.id)?.tier === "native").map((agent) => agent.id) : [];
  const exclude = [
    ...agents.filter((agent) => agent.refuseInstall).map((agent) => agent.id),
    ...(sourceAgent ? [sourceAgent] : []),
    ...(option === "choose" ? natives : []),
  ];
  const texts = scopeOptionTexts(method, primary.map(agentName), natives.map(agentName));
  const request = scopeRequest({ option, primary, chosen, single, exclude });
  const sourceRef: Record<string, string> | null =
    source?.kind === "import" ? { importId: source.skill.importId } : sourceId ? { instanceId: sourceId } : null;
  const body = sourceRef ? installBody(sourceRef, request, choices) : null;
  const ready = Boolean(body && request.agentIds.length);
  const title = titleOf(source);

  const flow = usePlanApply<InstallPlan, InstallResult>({
    requestKey: JSON.stringify(body),
    enabled: ready,
    makePlan: () => (body ? api.planInstall(body) : Promise.reject(new Error("至少选一个 Agent。"))),
    planIdOf: (plan) => plan.planId,
    expiresAtOf: (plan) => plan.expiresAt,
    apply: (planId) => api.applyInstall(planId),
    onApplied: (result, plan) => {
      const done = installDone(plan, result);
      const message = result.failed
        ? `${title}：完成一部分，${result.failed} 项没有成功，已自动撤回`
        : installMessage(title, done, result.mode === "per-agent", agentName);
      undoToast(message, result.historyId, result.failed ? "error" : "default");
      onDone();
    },
    refresh: refreshAfterWrite,
    planFailure: "无法生成安装计划。",
    applyFailure: "安装失败，已完成的步骤会按相反顺序撤回。",
  });
  useMarkBusy(flow.applying);

  return {
    view,
    method,
    option,
    setOption,
    chosen,
    toggle: (id: string, on: boolean) => setChosen((list) => (on ? [...new Set([...list, id])] : list.filter((item) => item !== id))),
    single,
    setSingle,
    candidates,
    initial,
    sourceId,
    setSourceId,
    sourceAgent,
    ordered,
    natives,
    libraryAgent,
    texts,
    request,
    ready,
    flow,
    choose: (item: LibraryPlanItem, choice: string) => setChoices((current) => ({ ...current, [item.id]: choice })),
  };
}

export type InstallScopeController = ReturnType<typeof useInstallScope>;

function AgentChoice({ ctrl, agentId, name, copyOnly }: { ctrl: InstallScopeController; agentId: string; name: string; copyOnly: boolean }) {
  const { primary } = useData();
  const info = ctrl.libraryAgent(agentId);
  const library = ctrl.method === "library";
  const native = ctrl.natives.includes(agentId);
  const isSource = agentId === ctrl.sourceAgent;
  const note = isSource
    ? "来源，已经有了"
    : native
      ? "会自动读取技能库，进库就能看到"
      : library && info?.tier === "config" && info.configured === false
        ? "额外目录 · 会改一次它的配置"
        : library && info
          ? TIER_LABELS[info.tier]
          : copyOnly
            ? "只支持复制"
            : "";
  return (
    <label className={native || isSource ? "disabled" : ""} title={library && info ? TIER_HINTS[info.tier] : undefined}>
      <input
        type="checkbox"
        disabled={native || isSource || ctrl.flow.applying}
        checked={native || isSource || ctrl.chosen.includes(agentId)}
        onChange={(event) => ctrl.toggle(agentId, event.target.checked)}
      />
      <AgentAvatar id={agentId} size="sm" />
      <span className="scope-agent">
        {name}
        {primary.includes(agentId) ? <em>常用</em> : null}
      </span>
      <small>{note}</small>
    </label>
  );
}

/** Library mode: the library row, one line per target Agent, choices, then every step. */
function LibraryPlan({ plan, ctrl }: { plan: InstallPlan; ctrl: InstallScopeController }) {
  const { agentName } = useData();
  const busy = ctrl.flow.planning || ctrl.flow.applying;
  const add = plan.items.find((item) => item.kind === "add" || item.kind === "already" || item.id.startsWith("replace:"));
  const replace = plan.items.find((item) => item.id.startsWith("replace:") && isConflict(item));
  const conflicts = plan.items.filter((item) => isConflict(item) && item !== replace);
  const rest = plan.items.filter((item) => !isConflict(item) && item.steps.length);
  const libraryLine = !add
    ? "已经在技能库里，只接入下面的 Agent"
    : add.kind === "already"
      ? "技能库里已有内容相同的一份，直接用它"
      : add.kind === "add"
        ? `放进 ${plan.libraryRoot}/${plan.skillName}`
        : "技能库里已有不同内容的同名技能，选择用哪一份";
  return (
    <div className="install-plan">
      {replace ? <PlanItem item={replace} onChoose={ctrl.choose} disabled={busy} /> : null}
      <ul className="install-targets">
        <li>
          <span className="it-who">技能库</span>
          <span className="it-how">{libraryLine}</span>
        </li>
        {plan.targets.map((target) => (
          <li key={target.agentId}>
            <span className="it-who">
              <AgentAvatar id={target.agentId} size="xs" />
              {agentName(target.agentId)}
            </span>
            <span className="it-how" title={TIER_LABELS[target.tier]}>
              {OUTCOME_TEXT[target.outcome] || target.outcome}
            </span>
          </li>
        ))}
      </ul>
      {plan.alsoVisibleTo.length ? <p className="muted small">{shortNames(plan.alsoVisibleTo.map(agentName))} 会自动读取技能库，也能看到它。</p> : null}
      {conflicts.map((item) => (
        <PlanItem key={item.id} item={item} onChoose={ctrl.choose} disabled={busy} />
      ))}
      {rest.length ? (
        <details className="install-steps">
          <summary>查看全部 {rest.length} 项改动</summary>
          {rest.map((item) => (
            <PlanItem key={item.id} item={item} onChoose={ctrl.choose} disabled={busy} />
          ))}
        </details>
      ) : null}
    </div>
  );
}

/** Per-Agent mode (各装一份, or one Agent only): a copy per Agent, as before. */
function CopyPlan({ plan }: { plan: InstallPlan }) {
  const { agentName } = useData();
  return (
    <div className="plan-list">
      {plan.actions.map((action) => (
        <div key={`${action.agentId}-${action.destination}`} className="plan-agent">
          <b>
            <AgentAvatar id={action.agentId} size="sm" />
            {agentName(action.agentId)}
          </b>
          <ActionDetail action={action} agentName={agentName} />
        </div>
      ))}
      {plan.warnings.map((warning) => (
        <p key={warning} className="plan-warning">
          {warning}
        </p>
      ))}
    </div>
  );
}

/** The scope cards, the Agent list for the chosen option, and the plan. */
export function InstallScopeBody({ ctrl }: { ctrl: InstallScopeController }) {
  const groupId = useId();
  const { view, initial, candidates, flow } = ctrl;
  if (view && !initial) {
    return <p className="inline-note">没有可以安装的来源：这个技能只在一个 Agent 里有，而且就是要安装的位置。</p>;
  }
  const hashes = new Set(candidates.map((instance) => instance.hash));
  const plan = flow.plan || (flow.planning ? flow.lastPlan : null);
  const notice = flow.expired ? "计划已过期（10 分钟），请重新生成。" : flow.notice || (flow.plan && !flow.planId ? flow.plan.message || "" : "");
  return (
    <div className="install-scope">
      {view && candidates.length > 1 && hashes.size > 1 ? (
        <label className="field">
          <span>用哪一份</span>
          <select value={ctrl.sourceId} disabled={flow.applying} onChange={(event) => ctrl.setSourceId(event.target.value)}>
            {candidates.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.agentName} · {instance.path}
                {instance.modifiedAt ? ` · ${formatMonthDay(instance.modifiedAt)}更新` : ""}
                {isReadOnlyInstance(instance) ? " · 只读来源" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : view && initial ? (
        <p className="scope-source">
          来源：{initial.agentName} 的 <code title={initial.path}>{initial.path}</code>
        </p>
      ) : null}
      <fieldset className="scope-options" disabled={flow.applying}>
        <legend>装到哪里</legend>
        {ctrl.texts.map((text) => (
          <label key={text.id} className="opt card scope-opt">
            <input type="radio" name={groupId} checked={ctrl.option === text.id} onChange={() => ctrl.setOption(text.id)} />
            <span>
              {text.title}
              <small>{text.detail}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {ctrl.option === "choose" ? (
        <fieldset className="targets scope-agents" disabled={flow.applying}>
          <legend>{ctrl.method === "library" ? "接入哪些 Agent" : "装到哪些 Agent"}</legend>
          {ctrl.ordered.map((agent) => (
            <AgentChoice key={agent.id} ctrl={ctrl} agentId={agent.id} name={agent.name} copyOnly={Boolean(agent.copyOnly)} />
          ))}
        </fieldset>
      ) : null}
      {ctrl.option === "single" ? (
        <fieldset className="targets scope-agents" disabled={flow.applying}>
          <legend>装到哪个 Agent</legend>
          {ctrl.ordered.map((agent) => {
            const isSource = agent.id === ctrl.sourceAgent;
            return (
              <label key={agent.id} className={isSource ? "disabled" : ""}>
                <input type="radio" name={`${groupId}-single`} disabled={isSource} checked={ctrl.single === agent.id} onChange={() => ctrl.setSingle(agent.id)} />
                <AgentAvatar id={agent.id} size="sm" />
                <span className="scope-agent">{agent.name}</span>
                <small>{isSource ? "来源，已经有了" : ""}</small>
              </label>
            );
          })}
        </fieldset>
      ) : null}
      <section className="scope-plan" aria-live="polite" aria-busy={ctrl.ready && flow.planning}>
        <h3 className="mini-h">会做什么</h3>
        {!ctrl.ready ? (
          <p className="muted small">{ctrl.option === "single" ? "选一个 Agent。" : "至少选一个 Agent。"}</p>
        ) : !plan ? (
          flow.planError ? null : <p className="muted small">正在生成安装计划…</p>
        ) : (
          <div className={flow.planning ? "stale" : ""}>{plan.mode === "library" ? <LibraryPlan plan={plan} ctrl={ctrl} /> : <CopyPlan plan={plan} />}</div>
        )}
        {ctrl.ready && notice ? (
          <p className="inline-note" role="status">
            {notice}
          </p>
        ) : null}
        {ctrl.ready && (flow.planError || flow.error) ? (
          <div className="form-error" role="alert">
            {flow.planError || flow.error}{" "}
            <button type="button" className="link-btn" onClick={flow.retry}>
              重新生成
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** Footer: progress while writing, a one-line note, 取消 and 确认安装. */
export function InstallScopeFooter({ ctrl, onCancel }: { ctrl: InstallScopeController; onCancel: () => void }) {
  const { flow } = ctrl;
  const plan = flow.plan;
  const running = plan ? runningItems(plan) : 0;
  // The service holds the plan back until a conflict has an answer.
  const waiting = Boolean(plan && !plan.planId && plan.needsChoice > 0);
  const note =
    ctrl.option === "single"
      ? "只复制到这一个 Agent，其他 Agent 看不到"
      : ctrl.method === "library"
        ? "放进技能库的技能，以后在库里更新一次就行"
        : "每个 Agent 一份独立副本";
  return (
    <>
      {flow.applying ? (
        <div className="foot-progress">
          <RunningProgress label="正在安装…" expectedMs={Math.max(4_000, running * 800)} detail="替换前都会先备份；完成前不能关闭。" />
        </div>
      ) : null}
      <small>{note}</small>
      <span className="acts-right">
        <button type="button" className="btn ghost" onClick={onCancel} disabled={flow.applying}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={!ctrl.ready || !flow.canApply || !running} onClick={() => void flow.confirm()}>
          {flow.applying ? "正在安装…" : waiting ? "先选择上面的处理方式" : plan && !running && !flow.planning ? "没有需要改动的" : "确认安装"}
        </button>
      </span>
    </>
  );
}

/** The install scope in its own dialog: the switches in a skill's detail and the skill table's cells. */
export function InstallScopeDialog({ view, agentId, onClose }: { view: SkillView; agentId: string | null; onClose: () => void }) {
  const { agentName } = useData();
  const ctrl = useInstallScope({ kind: "instance", view }, agentId, onClose);
  return (
    <Modal
      wide
      title={
        <>
          安装「{view.title}」{agentId ? <span className="modal-sub">从 {agentName(agentId)} 的开关打开</span> : null}
        </>
      }
      onClose={onClose}
      busy={ctrl.flow.applying}
      footer={<InstallScopeFooter ctrl={ctrl} onCancel={onClose} />}
    >
      <InstallScopeBody ctrl={ctrl} />
    </Modal>
  );
}
