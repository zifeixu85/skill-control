"use client";

import type { KeyboardEvent, PointerEvent } from "react";

export const INSPECTOR_DEFAULT = 440;
export const INSPECTOR_MIN = 360;
export const INSPECTOR_MAX = 820;
/** The list keeps at least this much room so skill names stay readable. */
const LIST_MIN = 500;

export function clampInspector(value: number, available = Number.POSITIVE_INFINITY): number {
  const width = Number.isFinite(value) && value > 0 ? value : INSPECTOR_DEFAULT;
  const max = Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, available - LIST_MIN));
  return Math.round(Math.min(max, Math.max(INSPECTOR_MIN, width)));
}

/** Drag handle on the panel's left edge; arrow keys resize by 20 px. */
export function InspectorResizer({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const splitWidth = (element: Element) => element.closest(".split")?.getBoundingClientRect() || null;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const rect = splitWidth(handle);
    if (!rect) return;
    const move = (moveEvent: globalThis.PointerEvent) => onChange(clampInspector(rect.right - moveEvent.clientX, rect.width));
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const rect = splitWidth(event.currentTarget);
    onChange(clampInspector(width + (event.key === "ArrowLeft" ? 20 : -20), rect?.width));
  };

  return (
    <div
      className="inspector-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整详情面板宽度"
      aria-valuenow={width}
      aria-valuemin={INSPECTOR_MIN}
      aria-valuemax={INSPECTOR_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(INSPECTOR_DEFAULT)}
      title="拖动调整宽度，双击恢复默认"
    />
  );
}
