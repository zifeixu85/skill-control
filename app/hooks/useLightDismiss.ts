"use client";

import { useEffect, useEffectEvent, type RefObject } from "react";
import { onOwnScrollbar, shouldLightDismiss } from "../lib/light-dismiss";

/**
 * Closes a detail panel on a primary press outside it (see lib/light-dismiss for what
 * doesn't count). Listens in the capture phase so a row that stops propagation still
 * counts; a text selection that starts inside the panel never closes it.
 */
export function useLightDismiss(ref: RefObject<HTMLElement | null>, onDismiss: () => void, busy: boolean) {
  const dismiss = useEffectEvent(onDismiss);
  const isBusy = useEffectEvent(() => busy);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const close = shouldLightDismiss({
        target: event.target,
        panel: ref.current,
        button: event.button,
        onScrollbar: onOwnScrollbar(event.target, event.offsetX, event.offsetY),
        busy: isBusy(),
      });
      if (close) dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [ref]);
}
