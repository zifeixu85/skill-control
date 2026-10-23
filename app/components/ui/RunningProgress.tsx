"use client";

import { useEffect, useState } from "react";
import { elapsedText, simulatedProgress } from "../../lib/progress";

/**
 * Motion while a write or update runs, so nobody wonders whether it hung: a spinner, a bar
 * (determinate when the step count is known, otherwise easing toward 90%) and the elapsed time.
 * Reduced motion: no spin, no bar easing — the numbers still update.
 */
export function RunningProgress({
  label,
  step,
  done,
  total,
  startedAt,
  expectedMs = 20_000,
  detail,
  compact,
}: {
  label: string;
  /** Inside a list row: no card around it. */
  compact?: boolean;
  /** The current step's text, e.g. "npm install -g …". */
  step?: string | null;
  /** Completed steps; with `total` the bar is exact. */
  done?: number | null;
  total?: number | null;
  /** Epoch ms when the work started; defaults to when this mounted. */
  startedAt?: number | null;
  /** How long it usually takes; shapes the simulated curve. */
  expectedMs?: number;
  detail?: string | null;
}) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(mountedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const start = startedAt || mountedAt;
  const elapsed = Math.max(0, now - start);
  const exact = total && total > 0 && typeof done === "number" ? Math.min(1, Math.max(0, done / total)) : null;
  // Known steps: finished steps are exact, the running one eases forward inside its share.
  const ratio =
    exact === null || !total ? simulatedProgress(elapsed, expectedMs) : exact >= 1 ? 1 : Math.min(1, exact + simulatedProgress(elapsed, expectedMs / total) / total);
  return (
    <div className={`running ${compact ? "inline" : ""}`} role="status" aria-live="polite">
      <div className="running-line">
        <span className="running-spinner" aria-hidden="true" />
        <b>{label}</b>
        <span className="running-meta">
          {exact !== null && total ? `第 ${Math.min(total, (done || 0) + 1)} / ${total} 步 · ` : ""}已用 {elapsedText(elapsed)}
        </span>
      </div>
      <span
        className={`running-bar ${exact === null ? "simulated" : ""}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={exact === null ? undefined : Math.round(ratio * 100)}
        aria-valuetext={exact === null ? `进行中，已用 ${elapsedText(elapsed)}` : undefined}
      >
        <i style={{ transform: `scaleX(${ratio})` }} />
      </span>
      {step ? <code className="running-step clamp-1" title={step}>{step}</code> : null}
      {detail ? <small className="muted">{detail}</small> : null}
    </div>
  );
}
