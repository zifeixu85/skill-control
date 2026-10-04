"use client";

import { STEP_TYPE_LABELS, type PlanStepItem } from "../../../lib/library";

/** Unified-diff text with added/removed lines tinted; rendered as text only. */
export function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="code wrap diff" aria-label="改动">
      <code>
        {diff.split("\n").map((line, index) => (
          <span key={index} className={`ln ${line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}`}>
            {line}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

function StepText({ step }: { step: PlanStepItem }) {
  if (step.command) return <code className="command">{step.command}</code>;
  if (step.type === "link") {
    return (
      <span>
        <code>{step.path}</code> → <code>{step.target}</code>
      </span>
    );
  }
  if (step.from && step.to) {
    return (
      <span>
        <code>{step.from}</code> → <code>{step.to}</code>
      </span>
    );
  }
  if (step.path && step.to) {
    return (
      <span>
        <code>{step.path}</code> → <code>{step.to}</code>
      </span>
    );
  }
  return <code>{step.path || step.target || ""}</code>;
}

/** The exact steps a plan item will perform, in order. */
export function StepList({ steps }: { steps: PlanStepItem[] }) {
  if (!steps.length) return <p className="muted small">不需要改动任何文件。</p>;
  return (
    <ol className="steps compact">
      {steps.map((step, index) => (
        <li key={`${step.type}-${index}`}>
          <span className={`tag ${step.type === "command" ? "info" : step.type === "backup" || step.type === "stash" ? "mute" : "warn"}`}>
            {STEP_TYPE_LABELS[step.type] || step.type}
          </span>
          <div>
            <StepText step={step} />
            {step.diff ? <DiffView diff={step.diff} /> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
