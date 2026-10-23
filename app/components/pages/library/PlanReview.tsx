"use client";

import { RunningProgress } from "../../ui/RunningProgress";
import { useEffect, useRef, useState } from "react";
import { refreshAfterWrite } from "../../../hooks/refresh";
import { noop, useEscape } from "../../../hooks/useEscape";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import { Scrim } from "../../ui/Scrim";
import { usePlanApply } from "../../../hooks/usePlanApply";
import { useUndoToast } from "../../../hooks/useUndoToast";
import { api } from "../../../lib/api";
import { BATCH_SECTIONS, type LibraryApplyResult, type LibraryPlan, type LibraryPlanItem } from "../../../lib/library";
import { activeItems, inScope, libraryPlanBody, outOfScopeActive } from "../../../lib/library-review";
import { useNav, type LibraryRequest } from "../../providers/NavProvider";
import { ApplyOutcome } from "./ApplyOutcome";
import { PlanItem } from "./PlanItem";

export type PlanRequest = LibraryRequest;

function sectionsOf(request: PlanRequest, items: LibraryPlanItem[]) {
  if (request.action !== "batch") return [{ title: "", items }];
  const known = BATCH_SECTIONS.map((section) => ({ title: section.title, items: items.filter((item) => section.kinds.includes(item.kind)) }));
  const leftover = items.filter((item) => !BATCH_SECTIONS.some((section) => section.kinds.includes(item.kind)));
  return [...known, { title: "其他", items: leftover }].filter((section) => section.items.length);
}

/** Library plan → review (checkboxes, conflict choices, exact steps) → confirm → result. */
export function PlanReview({ request, onClose, onWiden }: { request: PlanRequest; onClose: () => void; onWiden: () => void }) {
  const undoToast = useUndoToast();
  const { setRestoreHistoryId } = useNav();
  const ref = useFocusTrap<HTMLDivElement>();
  const resultRef = useRef<HTMLHeadingElement>(null);
  // Only what is sent to the planner; every row renders from the returned plan.
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [lastItems, setLastItems] = useState<LibraryPlanItem[]>([]);
  const body = libraryPlanBody(request, choices, lastItems);
  const scope = request.scope;

  const flow = usePlanApply<LibraryPlan, LibraryApplyResult>({
    requestKey: JSON.stringify(body),
    makePlan: () => api.libraryPlan(body),
    onPlanned: (plan) => {
      setLastItems(plan.items);
      // A scoped review asks again with every other active item skipped.
      const extra = scope ? outOfScopeActive(plan.items, scope).filter((item) => item.choices.includes("skip")) : [];
      if (extra.length) setChoices((current) => ({ ...current, ...Object.fromEntries(extra.map((item) => [item.id, "skip"])) }));
    },
    planIdOf: (plan) => (scope && outOfScopeActive(plan.items, scope).length ? null : plan.planId),
    expiresAtOf: (plan) => plan.expiresAt,
    apply: (planId) => api.libraryApply(planId),
    onApplied: (outcome) => {
      const applied = outcome.results.filter((item) => item.status === "applied").length;
      const failed = outcome.results.length - applied;
      const message = failed ? `完成 ${applied} 项，${failed} 项没有成功，已自动撤回` : "技能库已整理";
      undoToast(message, applied ? outcome.historyId : null, failed ? "error" : "default");
    },
    refresh: refreshAfterWrite,
    planFailure: "无法生成计划。",
    applyFailure: "执行失败，已完成的步骤会按相反顺序撤回。",
  });
  useEscape(true, flow.applying ? noop : onClose);
  useEffect(() => {
    if (flow.result) resultRef.current?.focus();
  }, [flow.result]);

  const choose = (item: LibraryPlanItem, choice: string) =>
    setChoices((current) => {
      const rest = Object.fromEntries(Object.entries(current).filter(([id]) => id !== item.id));
      return { ...rest, [item.id]: choice };
    });

  const plan = flow.plan || (flow.planning ? flow.lastPlan : null);
  const allItems = plan?.items || [];
  const items = scope ? allItems.filter((item) => inScope(item, scope)) : allItems;
  const active = flow.plan ? activeItems(flow.plan.items).length : 0;
  const hidden = allItems.length - items.length;
  const notice = flow.expired ? "计划已过期（10 分钟），请重新生成。" : flow.notice || (flow.plan && !flow.planId ? flow.plan.message || "" : "");

  return (
    <Scrim onDismiss={onClose} busy={flow.applying}>
      <div className="sheet wide" role="dialog" aria-modal="true" aria-labelledby="plan-title" aria-busy={flow.planning || flow.applying} ref={ref} tabIndex={-1}>
        <h2 id="plan-title">{request.title}</h2>
        {flow.result ? (
          <div role="status" aria-live="polite">
            <h3 className="sr-focus" ref={resultRef} tabIndex={-1}>
              已执行：{flow.result.results.filter((item) => item.status === "applied").length} 项完成
            </h3>
            <ApplyOutcome result={flow.result} />
          </div>
        ) : (
          <>
            <p>下面是将要执行的全部步骤。勾选要处理的项目，冲突默认“先不处理”。每一项都会先备份，失败时自动撤回；执行后会重新检查各 Agent 能否看到这些技能。</p>
            {scope ? (
              <p className="inline-note">
                只处理「{scope.label}」{hidden ? `；其他 ${hidden} 项这次不处理` : ""}。
                <button type="button" className="link-btn" onClick={onWiden} disabled={flow.applying}>
                  查看全部整理项
                </button>
              </p>
            ) : null}
            {notice ? <p className="inline-note" role="status">{notice}</p> : null}
            {flow.planning && !plan ? <p className="muted">正在生成计划…</p> : null}
            {plan && !items.length ? <p className="empty-line">没有需要整理的内容。</p> : null}
            <div className={flow.planning ? "stale" : ""}>
              {sectionsOf(request, items).map((section) => (
                <section key={section.title || "items"} className="plan-section">
                  {section.title ? (
                    <h3>
                      {section.title} <em>{section.items.length}</em>
                    </h3>
                  ) : null}
                  {section.items.map((item) => (
                    <PlanItem key={item.id} item={item} onChoose={choose} disabled={flow.planning || flow.applying} />
                  ))}
                </section>
              ))}
            </div>
          </>
        )}
        {flow.applying ? <RunningProgress label={`正在整理 ${active} 项…`} expectedMs={Math.max(6_000, active * 1_500)} detail="替换前都会先备份；完成前不能关闭。" /> : null}
        {flow.planError || flow.error ? (
          <p className="form-error" role="alert">
            {flow.planError || flow.error}
          </p>
        ) : null}
        <div className="acts">
          <small>{flow.result ? "备份都在 ~/.agent-skill-manager/backups" : flow.planning ? "正在更新计划…" : `将执行 ${active} 项`}</small>
          <span className="acts-right">
            <button type="button" className="btn ghost" onClick={onClose} disabled={flow.applying}>
              {flow.result ? "完成" : "取消"}
            </button>
            {flow.result?.historyId ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const historyId = flow.result?.historyId;
                  onClose();
                  if (historyId) setRestoreHistoryId(historyId);
                }}
              >
                撤销这次整理
              </button>
            ) : null}
            {!flow.result && (flow.planError || flow.expired) ? (
              <button type="button" className="btn" onClick={flow.retry}>
                重新生成
              </button>
            ) : null}
            {!flow.result ? (
              <button type="button" className="btn primary" disabled={!flow.canApply || !active} onClick={() => void flow.confirm()}>
                {flow.applying ? "正在执行…" : `确认执行 ${active} 项`}
              </button>
            ) : null}
          </span>
        </div>
      </div>
    </Scrim>
  );
}
