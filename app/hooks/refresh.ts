import { invalidateResources } from "./useResource";

/** Refetch everything a skill write can change. Never rejects, so it is safe after any write. */
export const refreshAfterWrite = () =>
  void invalidateResources(
    "scan",
    "files:",
    "file:",
    "detail:",
    "usage:skill:",
    "library",
    "trash",
    "history",
    "health-report",
    "updates",
    "cli-tools",
    "integrations",
  );
