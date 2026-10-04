"use client";

import { useCallback } from "react";
import { historyIdOf } from "../lib/history";
import { useNav } from "../components/providers/NavProvider";
import { useToast } from "../components/providers/ToastProvider";

/** Result toast for a write; offers 撤销 when the service recorded a restorable history entry. */
export function useUndoToast() {
  const toast = useToast();
  const { setRestoreHistoryId } = useNav();
  return useCallback(
    (message: string, result: unknown, tone: "default" | "error" = "default") => {
      const historyId = typeof result === "string" ? result : historyIdOf(result);
      toast.show(message, {
        tone,
        action: historyId ? { label: "撤销", run: () => setRestoreHistoryId(historyId) } : undefined,
      });
    },
    [toast, setRestoreHistoryId],
  );
}
