"use client";

import { choiceLabel, enabledChoice, ITEM_KIND_LABELS, type LibraryPlanItem } from "../../../lib/library";
import { isConflict } from "../../../lib/library-review";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { StepList, StepText } from "./StepList";

/**
 * One plan item. What it shows (ticked, chosen, steps) always comes from the service's
 * plan; a click only asks for a new plan with that choice.
 */
export function PlanItem({
  item,
  onChoose,
  disabled,
  compact = false,
}: {
  item: LibraryPlanItem;
  onChoose: (item: LibraryPlanItem, choice: string) => void;
  disabled: boolean;
  /** One line (skill · first step) for long lists of links / copies under an Agent heading. */
  compact?: boolean;
}) {
  const { agentName } = useData();
  const conflict = isConflict(item);
  const toggleable = !conflict && item.choices.length > 1;
  const on = item.choice !== "skip";
  // "先不处理" is a real default; any other default the service still waits on isn't an answer yet
  // (e.g. installing over a library skill with other content: the plan stays blocked until picked).
  const picked = item.requiresChoice && item.choice !== "skip" ? null : item.choice;
  // Only plain links and copies fold into one line; config changes keep their diff in view.
  if (compact && !conflict && (item.kind === "link" || item.kind === "copy")) {
    const [first, ...more] = item.steps;
    return (
      <label className={`plan-row ${on ? "" : "off"}`} title={item.title}>
        {toggleable ? (
          <input
            type="checkbox"
            checked={on}
            disabled={disabled}
            aria-label={`执行：${item.title}`}
            onChange={(event) => onChoose(item, event.target.checked ? enabledChoice(item) : "skip")}
          />
        ) : (
          <span className="plan-item-spacer" />
        )}
        <b>{item.skill || item.title}</b>
        <span className="plan-row-step">
          {!on ? "这次不处理" : first ? <StepText step={first} /> : "不需要改动"}
          {more.length ? ` 等 ${item.steps.length} 步` : ""}
        </span>
      </label>
    );
  }
  return (
    <div className={`plan-item ${on ? "" : "off"}`}>
      <div className="plan-item-head">
        {toggleable ? (
          <input
            type="checkbox"
            checked={on}
            disabled={disabled}
            aria-label={`执行：${item.title}`}
            onChange={(event) => onChoose(item, event.target.checked ? enabledChoice(item) : "skip")}
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
            <label key={choice} className={`choice ${picked === choice ? "on" : ""}`}>
              <input
                type="radio"
                name={item.id}
                checked={picked === choice}
                disabled={disabled}
                onChange={() => onChoose(item, choice)}
              />
              <span>
                <b>{choiceLabel(item, choice).title}</b>
                <span>{choiceLabel(item, choice).detail}</span>
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
