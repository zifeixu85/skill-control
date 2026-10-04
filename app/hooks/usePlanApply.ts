"use client";

import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { errorMessage } from "../lib/api";
import {
  applyFailureMessage,
  classifyApplyError,
  flowReducer,
  flowView,
  initialFlow,
  type FlowEvent,
  type FlowState,
} from "../lib/plan-flow";
import { useToast } from "../components/providers/ToastProvider";

export interface PlanApplyOptions<P, R> {
  /** Everything the plan depends on, serialized; a new key means a new plan. */
  requestKey: string;
  makePlan: () => Promise<P>;
  /** Runs for the plan of the current request only (never for a superseded one). */
  onPlanned?: (plan: P) => void;
  planIdOf: (plan: P) => string | null | undefined;
  expiresAtOf?: (plan: P) => string | null | undefined;
  apply: (planId: string, plan: P) => Promise<R>;
  /** Success side effects (toast, close). Runs before `refresh`. */
  onApplied?: (result: R, plan: P) => void;
  /** Refetches whatever the write may have changed; runs after every apply attempt. */
  refresh?: () => void;
  planFailure: string;
  applyFailure: string;
}

/** Plan on mount and whenever `requestKey` changes; confirm applies exactly that plan. */
export function usePlanApply<P, R>(options: PlanApplyOptions<P, R>) {
  const toast = useToast();
  const [attempt, setAttempt] = useState(0);
  const key = `${options.requestKey}#${attempt}`;
  const [state, dispatch] = useReducer(
    flowReducer as (state: FlowState<P, R>, event: FlowEvent<P, R>) => FlowState<P, R>,
    undefined,
    () => initialFlow<P, R>(),
  );
  const inFlight = useRef(false);
  const makePlan = useEffectEvent(options.makePlan);
  const onPlanned = useEffectEvent((plan: P) => options.onPlanned?.(plan));
  const planFailure = useEffectEvent(() => options.planFailure);

  useEffect(() => {
    let cancelled = false;
    makePlan().then(
      (plan) => {
        if (cancelled) return;
        dispatch({ type: "planned", key, plan });
        onPlanned(plan);
      },
      (error: unknown) => {
        if (!cancelled) dispatch({ type: "plan-failed", key, message: errorMessage(error, planFailure()) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);

  const view = flowView(state, key, options.planIdOf);
  const expiresAt = view.plan && options.expiresAtOf ? options.expiresAtOf(view.plan) || null : null;
  useEffect(() => {
    const planId = view.planId;
    if (!planId || !expiresAt) return undefined;
    const delay = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(delay)) return undefined;
    const timer = window.setTimeout(() => dispatch({ type: "expired", planId }), Math.max(0, delay));
    return () => window.clearTimeout(timer);
  }, [view.planId, expiresAt]);

  const confirm = async () => {
    const { plan, planId } = view;
    if (inFlight.current || !view.canApply || !plan || !planId) return;
    inFlight.current = true;
    dispatch({ type: "apply-started" });
    try {
      const result = await options.apply(planId, plan);
      dispatch({ type: "applied", result });
      options.onApplied?.(result, plan);
    } catch (error) {
      const failure = classifyApplyError(error);
      const message = applyFailureMessage(failure, error, options.applyFailure);
      dispatch({ type: "apply-failed", failure, message });
      if (failure !== "stale") toast.show(message, { tone: "error" });
      setAttempt((value) => value + 1);
    } finally {
      inFlight.current = false;
    }
    options.refresh?.();
  };

  return {
    ...view,
    applying: state.applying,
    result: state.result,
    error: state.error,
    notice: state.notice,
    confirm,
    /** New plan for the same inputs (after a plan error or expiry). */
    retry: () => setAttempt((value) => value + 1),
  };
}
