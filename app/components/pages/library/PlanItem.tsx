"use client";

import { CHOICE_LABELS, enabledChoice, ITEM_KIND_LABELS, type LibraryPlanItem } from "../../../lib/library";
import { isConflict } from "../../../lib/library-review";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { StepList } from "./StepList";

/**
 * One plan item. What it shows (ticked, chosen, steps) always comes from the service's
 * plan; a click only asks for a new plan with that choice.
 */
export function PlanItem({
  item,
  onChoose,
  disabled,
}: {
  item: LibraryPlanItem;
  onChoose: (item: LibraryPlanItem, choice: string) => void;
  disabled: boolean;
}) {
  const { agentName } = useData();
  const conflict = isConflict(item);
  const toggleable = !conflict && item.choices.length > 1;
  const on = item.choice !== "skip";
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
            <label key={choice} className={`choice ${item.choice === choice ? "on" : ""}`}>
              <input
                type="radio"
                name={item.id}
                checked={item.choice === choice}
                disabled={disabled}
                onChange={() => onChoose(item, choice)}
              />
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
