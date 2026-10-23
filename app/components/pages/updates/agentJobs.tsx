"use client";

import { useEffect, useSyncExternalStore } from "react";
import { invalidateResources } from "../../../hooks/useResource";
import { createJobStore, type TrackedJob } from "../../../lib/agent-jobs";
import { api } from "../../../lib/api";
import { useToast } from "../../providers/ToastProvider";

export const agentJobs = createJobStore((jobId) => api.agentUpdateJob(jobId));
const NONE: Record<string, TrackedJob> = {};

/** Background updates by version row id. */
export function useAgentJobs(): Record<string, TrackedJob> {
  return useSyncExternalStore(agentJobs.subscribe, agentJobs.get, () => NONE);
}

/** Mounted once: a toast when a background update finishes, then fresh version data. */
export function AgentJobToasts() {
  const toast = useToast();
  useEffect(
    () =>
      agentJobs.onFinished((tracked) => {
        const result = tracked.job?.result;
        if (tracked.job?.status === "done" && (result?.ok ?? true)) {
          toast.show(`已在后台更新 ${tracked.name}${result?.version.after ? ` 到 ${result.version.after}` : ""}`);
        } else {
          toast.show(tracked.job?.error || `${tracked.name} 没有更新成功，可以在“Agent 软件”里查看`, { tone: "error" });
        }
        void invalidateResources("agent-versions", "history");
      }),
    [toast],
  );
  return null;
}
