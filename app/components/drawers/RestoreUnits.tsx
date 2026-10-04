"use client";

import { RESTORE_STEP_LABELS, type RestoreUnit } from "../../lib/history";

/** Per-unit undo choices: conflicts start unchecked with the reason; gone units can't be picked. */
export function RestoreUnits({
  units,
  disabled,
  onToggle,
}: {
  units: RestoreUnit[];
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <div className="plan-list restore-units">
      {units.map((unit) => (
        <div key={unit.id} className={`plan-item ${unit.selected ? "" : "off"}`}>
          <div className="plan-item-head">
            <input
              type="checkbox"
              checked={unit.selected}
              disabled={disabled || Boolean(unit.unrestorable)}
              aria-label={`撤销：${unit.title}`}
              onChange={(event) => onToggle(unit.id, event.target.checked)}
            />
            <div>
              <b>{unit.title}</b>
              {unit.unrestorable ? <span className="muted small">不能撤销：{unit.unrestorable}</span> : null}
              {!unit.unrestorable && unit.conflict ? (
                <span className="warn-text small">
                  {unit.conflict}
                  {unit.selected ? "仍会恢复，当前内容先备份。" : "默认不撤销，勾选后会覆盖（先备份当前内容）。"}
                </span>
              ) : null}
            </div>
          </div>
          {unit.selected && unit.steps.length ? (
            <ol className="steps compact">
              {unit.steps.map((step, index) => (
                <li key={`${step.type}-${step.path}-${index}`}>
                  <span className="tag mute">{RESTORE_STEP_LABELS[step.type] || step.type}</span>
                  <code>{step.path}</code>
                  {step.from ? <small className="muted">← {step.from}</small> : null}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ))}
    </div>
  );
}
