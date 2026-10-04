import type { LibraryAction, LibraryIssue, LibraryPlanItem } from "./library";

/** Review helpers for library plans: issue scopes, the request body, what will run. */

/** A batch review narrowed to one issue: only these items run, everything else is skipped. */
export interface PlanScope {
  label: string;
  kinds: string[];
  agentId?: string | null;
}

/** The part of 一键整理 that fixes one 需要注意 item, or null when it needs the full review. */
export function scopeForIssue(issue: LibraryIssue): PlanScope | null {
  if (issue.id === "library-external-link") return { label: issue.title, kinds: ["adopt"] };
  if (issue.id === "library-drift" && issue.agentId) return { label: issue.title, kinds: ["link", "dedupe"], agentId: issue.agentId };
  return null;
}

export const inScope = (item: LibraryPlanItem, scope: PlanScope) =>
  scope.kinds.includes(item.kind) && (!scope.agentId || item.agentId === scope.agentId);

/** Items that would run and are outside the scope; a scoped plan is safe only when none are left. */
export const outOfScopeActive = (items: LibraryPlanItem[], scope: PlanScope) =>
  items.filter((item) => !inScope(item, scope) && item.choice !== "skip" && item.steps.length > 0);

/** Items that will actually run, from the service's own plan (never from local choices). */
export const activeItems = (items: LibraryPlanItem[]) => items.filter((item) => item.choice !== "skip" && item.steps.length > 0);

export const isConflict = (item: LibraryPlanItem) => item.kind === "conflict" || item.choices.length > 2;

/**
 * Request body for a library plan. Single-skill actions also send `choice` when the plan has
 * exactly one conflict, since the service lets `choice` win over the map for those.
 */
export function libraryPlanBody(
  request: { action: LibraryAction; skill?: string; agents?: string[] },
  choices: Record<string, string>,
  lastItems: LibraryPlanItem[],
) {
  const conflicts = lastItems.filter(isConflict);
  const single = request.action !== "batch" && conflicts.length === 1 ? choices[conflicts[0].id] : undefined;
  return {
    action: request.action,
    ...(request.skill ? { skill: request.skill } : {}),
    ...(request.agents?.length ? { agents: request.agents } : {}),
    ...(Object.keys(choices).length ? { choices } : {}),
    ...(single ? { choice: single } : {}),
  };
}
