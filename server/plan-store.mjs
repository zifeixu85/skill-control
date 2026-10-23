import { randomUUID } from "node:crypto";

/**
 * Plans live only in this process, for a limited time, and run once. Errors carry a
 * machine-readable `code` next to the Chinese message so the UI can tell "make a new plan"
 * (plan-not-found / plan-expired / stale-plan) from a refusal.
 */

export class CodedError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

/** Codes are lowercase words; system codes such as ENOENT are never passed through. */
export const PUBLIC_CODE = /^[a-z][a-z0-9-]{1,40}$/u;

const DEFAULT_CODES = { 403: "forbidden", 404: "not-found", 409: "conflict" };

/** The code to send with an error response (explicit code, else a default by status). */
export function errorCode(error, statusCode) {
  if (typeof error?.code === "string" && PUBLIC_CODE.test(error.code)) return error.code;
  return DEFAULT_CODES[statusCode] || null;
}

export function createPlanStore({ ttlMs, now = () => Date.now(), label = "计划" }) {
  const plans = new Map();
  const expired = new Set();
  const purge = () => {
    for (const [id, plan] of plans) {
      if (now() - plan.createdAt > ttlMs) {
        plans.delete(id);
        expired.add(id);
      }
    }
    // Remember a bounded number of expired ids, so a late confirm says "expired".
    while (expired.size > 500) expired.delete(expired.values().next().value);
  };
  return {
    remember(plan) {
      purge();
      const planId = randomUUID();
      plans.set(planId, { ...plan, planId, createdAt: now() });
      return planId;
    },
    /** The plan without using it up, or null. */
    peek(planId) {
      purge();
      return plans.get(String(planId || "")) || null;
    },
    /** Returns the plan and removes it (single use); throws a coded 404 otherwise. */
    take(planId, kind = null) {
      purge();
      const id = String(planId || "");
      const stored = plans.get(id);
      if (!stored || (kind && stored.kind !== kind)) {
        // The message stays the same for older clients; the code tells the two cases apart.
        throw new CodedError(404, `${label}不存在或已过期（10 分钟），请重新生成。`, expired.has(id) ? "plan-expired" : "plan-not-found");
      }
      plans.delete(id);
      return stored;
    },
  };
}
