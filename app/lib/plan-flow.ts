import type { ApiError } from "./api";

/**
 * Plan → confirm → apply as a pure state machine, shared by every write dialog.
 *
 * A plan only counts for the request it answers (`settledFor`). Changing a choice starts a
 * new request, so the old plan can be shown dimmed but can never be confirmed; a failed
 * re-plan clears it. Apply failures that mean "the plan is gone" (404, 409) or "we don't
 * know what happened" (connection lost, timeout) clear the plan and ask for a new one.
 */

export type ApplyFailure = "stale" | "unknown" | "failed";

export interface FlowState<P, R> {
  /** Request key the current plan or plan error answers. */
  settledFor: string | null;
  plan: P | null;
  planError: string;
  applying: boolean;
  result: R | null;
  /** Last apply failure, shown until the next confirm. */
  error: string;
  /** Why the plan was regenerated (expired, changed, unknown outcome). */
  notice: string;
  expiredPlanId: string | null;
}

export type FlowEvent<P, R> =
  | { type: "planned"; key: string; plan: P }
  | { type: "plan-failed"; key: string; message: string }
  | { type: "apply-started" }
  | { type: "applied"; result: R }
  | { type: "apply-failed"; failure: ApplyFailure; message: string }
  | { type: "expired"; planId: string };

export function initialFlow<P, R>(): FlowState<P, R> {
  return {
    settledFor: null,
    plan: null,
    planError: "",
    applying: false,
    result: null,
    error: "",
    notice: "",
    expiredPlanId: null,
  };
}

export function flowReducer<P, R>(state: FlowState<P, R>, event: FlowEvent<P, R>): FlowState<P, R> {
  switch (event.type) {
    case "planned":
      return { ...state, settledFor: event.key, plan: event.plan, planError: "" };
    case "plan-failed":
      return { ...state, settledFor: event.key, plan: null, planError: event.message };
    case "apply-started":
      return state.applying || state.result ? state : { ...state, applying: true, error: "", notice: "" };
    case "applied":
      return { ...state, applying: false, result: event.result };
    case "apply-failed": {
      // The service drops a plan once apply starts, so every failure needs a fresh plan.
      const cleared = { ...state, applying: false, plan: null, settledFor: null };
      return event.failure === "failed" ? { ...cleared, error: event.message } : { ...cleared, notice: event.message };
    }
    case "expired":
      return { ...state, expiredPlanId: event.planId };
    default:
      return state;
  }
}

export interface FlowView<P> {
  /** A plan request is in flight (or about to start) for the current key. */
  planning: boolean;
  /** The plan for the current request, or null. */
  plan: P | null;
  /** The last plan received, possibly for an older request; for dimmed display only. */
  lastPlan: P | null;
  planId: string | null;
  expired: boolean;
  planError: string;
  canApply: boolean;
}

export function flowView<P, R>(
  state: FlowState<P, R>,
  key: string,
  planIdOf: (plan: P) => string | null | undefined,
): FlowView<P> {
  const planning = state.settledFor !== key;
  const plan = planning ? null : state.plan;
  const planId = (plan && planIdOf(plan)) || null;
  const expired = Boolean(planId && state.expiredPlanId === planId);
  return {
    planning,
    plan,
    lastPlan: state.plan,
    planId,
    expired,
    planError: planning ? "" : state.planError,
    canApply: !planning && !state.applying && !state.result && Boolean(planId) && !expired,
  };
}

const STALE_HINT = /重新生成|有变化|已过期|已变化|changed|expired/iu;

/** Structural check, so errors from any copy of the client module are recognized. */
function asApiError(error: unknown): ApiError | null {
  return error instanceof Error && error.name === "ApiError" && typeof (error as ApiError).status === "number" ? (error as ApiError) : null;
}

export function classifyApplyError(error: unknown): ApplyFailure {
  const apiError = asApiError(error);
  if (apiError) {
    // No answer (connection lost or timed out): the write may or may not have happened.
    if (apiError.status === 0) return "unknown";
    if (apiError.status === 404 && !apiError.unsupported) return "stale";
    // 409 is either "changed since the plan" (re-plan) or a refusal such as offline mode,
    // which must stay an error instead of silently producing the same plan again.
    if (apiError.status === 409 && STALE_HINT.test(apiError.message)) return "stale";
  }
  return "failed";
}

export const UNKNOWN_OUTCOME = "连接中断，不知道这次有没有写入。正在刷新并重新生成计划，请先看看最新状态。";

export function applyFailureMessage(failure: ApplyFailure, error: unknown, fallback: string): string {
  if (failure === "unknown") return UNKNOWN_OUTCOME;
  const message = error instanceof Error && error.message ? error.message : fallback;
  if (failure !== "stale") return message;
  // The service says "…，请重新生成。"; we already did, so say that instead.
  const reason = message.replace(/[，,]?\s*请重新生成[^。]*。?$/u, "").replace(/[。.]?$/u, "。");
  return `${reason}已重新生成计划，请再看一遍。`;
}
