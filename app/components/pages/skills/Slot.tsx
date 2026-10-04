"use client";

import type { SlotState } from "../../../lib/skill-model";
import { AgentAvatar } from "../../ui/Avatar";

/** One circle per primary Agent: filled = installed, dashed = read-only/plugin, empty = click to install. */
export function Slot({ slot, onClick }: { slot: SlotState; onClick: () => void }) {
  const filled = slot.kind === "installed";
  const via = slot.kind === "readonly" || slot.kind === "plugin";
  const className = ["slot", filled ? "on" : "", via ? "via" : "", slot.kind === "refused" ? "refused" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={className}
      title={slot.label}
      aria-label={slot.label}
      aria-disabled={slot.kind === "refused" || undefined}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {filled || via ? <AgentAvatar id={slot.agentId} size="xs" /> : null}
      {filled && slot.copies > 1 ? <span className="badge">{slot.copies}</span> : null}
    </button>
  );
}
