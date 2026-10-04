"use client";

import { useEffect, useState } from "react";
import { useEscape } from "../../../hooks/useEscape";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import { invalidateResources } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import {
  BATCH_SECTIONS,
  CHOICE_LABELS,
  enabledChoice,
  ITEM_KIND_LABELS,
  type LibraryApplyResult,
  type LibraryPlan,
  type LibraryPlanItem,
} from "../../../lib/library";
import { useData } from "../../providers/DataProvider";
import type { LibraryRequest } from "../../providers/NavProvider";
import { useToast } from "../../providers/ToastProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { ApplyOutcome } from "./ApplyOutcome";
import { StepList } from "./StepList";

export type PlanRequest = LibraryRequest;

function ItemRow({
  item,
  value,
  onChange,
  disabled,
}: {
  item: LibraryPlanItem;
  value: string;
  onChange: (choice: string) => void;
  disabled: boolean;
}) {
  const { agentName } = useData();
  const conflict = item.choices.length > 2 || item.kind === "conflict";
  const toggleable = !conflict && item.choices.length > 1;
  const on = value !== "skip";
  return (
    <div className={`plan-item ${on ? "" : "off"}`}>
      <div className="plan-item-head">
        {toggleable ? (
          <input
            type="checkbox"
            checked={on}
            disabled={disabled}
            aria-label={`执行：${item.title}`}
            onChange={(event) => onChange(event.target.checked ? enabledChoice(item) : "skip")}
          />
        ) : (
          <span className="plan-item-spacer" />
        )}
        <div>
          <b>{item.title}</b>
          <span className="muted small">
            {ITEM_KIND_LABELS[item.kind] || item.kind}
            {item.agentId ? ` · ${agentName(item.agentId)}` : ""}
          </span>
        </div>
        {item.agentId ? <AgentAvatar id={item.agentId} size="sm" /> : null}
      </div>
      {conflict ? (
        <div className="choices inline" role="radiogroup" aria-label={`${item.skill} 怎么处理`}>
          {item.choices.map((choice) => (
            <label key={choice} className={`choice ${value === choice ? "on" : ""}`}>
              <input type="radio" name={item.id} checked={value === choice} disabled={disabled} onChange={() => onChange(choice)} />
              <span>
                <b>{CHOICE_LABELS[choice]?.title || choice}</b>
                <span>{CHOICE_LABELS[choice]?.detail || ""}</span>
              </span>
            </label>
          ))}
        </div>
      ) : null}
      {item.steps.length && on ? (
        <details className="plan-steps" open={item.steps.some((step) => step.command || step.diff)}>
          <summary>{item.steps.length} 个步骤</summary>
          <StepList steps={item.steps} />
        </details>
      ) : null}
    </div>
  );
}

/** Library plan → review (checkboxes, conflict choices, exact steps) → confirm → result. */
export function PlanReview({ request, onClose }: { request: PlanRequest; onClose: () => void }) {
  const toast = useToast();
  const ref = useFocusTrap<HTMLDivElement>();
  const [plan, setPlan] = useState<LibraryPlan | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [planning, setPlanning] = useState(true);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<LibraryApplyResult | null>(null);
  const [error, setError] = useState("");
  useEscape(!applying, onClose);

  useEffect(() => {
    let cancelled = false;
    const body = { action: request.action, skill: request.skill, agents: request.agents, choices };
    api.libraryPlan(body).then(
      (next) => {
        if (cancelled) return;
        setPlan(next);
        setPlanning(false);
      },
      (planError: unknown) => {
        if (cancelled) return;
        setError(errorMessage(planError, "无法生成计划。"));
        setPlanning(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [request.action, request.skill, request.agents, choices]);

  const choose = (id: string, choice: string) => {
    setPlanning(true);
    setError("");
    setChoices((current) => ({ ...current, [id]: choice }));
  };

  const apply = async () => {
    if (!plan?.planId) return;
    setApplying(true);
    setError("");
    try {
      const outcome = await api.libraryApply(plan.planId);
      setResult(outcome);
      const failed = outcome.results.filter((item) => item.status !== "applied").length;
      toast.show(failed ? `完成，但有 ${failed} 项没有成功，已自动撤回` : "技能库已整理", { tone: failed ? "error" : "default" });
      await invalidateResources("library", "scan", "files:", "file:", "detail:", "health-report", "updates", "cli-tools");
    } catch (applyError) {
      setError(errorMessage(applyError, "执行失败，已完成的步骤会按相反顺序撤回。"));
    } finally {
      setApplying(false);
    }
  };

  const items = plan?.items || [];
  const valueOf = (item: LibraryPlanItem) => choices[item.id] ?? item.choice;
  const active = items.filter((item) => valueOf(item) !== "skip" && item.steps.length > 0).length;
  const sections = request.action === "batch"
    ? BATCH_SECTIONS.map((section) => ({ ...section, items: items.filter((item) => section.kinds.includes(item.kind)) })).filter((section) => section.items.length)
    : [{ title: "", kinds: [], items }];
  const leftover = request.action === "batch"
    ? items.filter((item) => !BATCH_SECTIONS.some((section) => section.kinds.includes(item.kind)))
    : [];

  return (
    <div className="scrim">
      <div className="sheet wide" role="dialog" aria-modal="true" aria-labelledby="plan-title" ref={ref} tabIndex={-1}>
        <h2 id="plan-title">{request.title}</h2>
        {result ? (
          <ApplyOutcome result={result} />
        ) : (
          <>
            <p>
              下面是将要执行的全部步骤。勾选要处理的项目，冲突默认“先不处理”。每一项都会先备份，失败时自动撤回；执行后会重新检查各 Agent 能否看到这些技能。
            </p>
            {plan?.message ? <p className="inline-note">{plan.message}</p> : null}
            {!plan && planning ? <p className="muted">正在生成计划…</p> : null}
            {plan && !items.length ? <p className="empty-line">没有需要整理的内容。</p> : null}
            {sections.map((section) => (
              <section key={section.title || "items"} className="plan-section">
                {section.title ? (
                  <h3>
                    {section.title} <em>{section.items.length}</em>
                  </h3>
                ) : null}
                {section.items.map((item) => (
                  <ItemRow key={item.id} item={item} value={valueOf(item)} onChange={(choice) => choose(item.id, choice)} disabled={planning || applying} />
                ))}
              </section>
            ))}
            {leftover.map((item) => (
              <ItemRow key={item.id} item={item} value={valueOf(item)} onChange={(choice) => choose(item.id, choice)} disabled={planning || applying} />
            ))}
          </>
        )}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="acts">
          <small>{result ? "备份都在 ~/.agent-skill-manager/backups" : planning ? "正在更新计划…" : `将执行 ${active} 项`}</small>
          <span className="acts-right">
            <button type="button" className="btn ghost" onClick={onClose} disabled={applying}>
              {result ? "完成" : "取消"}
            </button>
            {!result ? (
              <button type="button" className="btn primary" disabled={planning || applying || !active || !plan?.planId} onClick={() => void apply()}>
                {applying ? "正在执行…" : `确认执行 ${active} 项`}
              </button>
            ) : null}
          </span>
        </div>
      </div>
    </div>
  );
}
