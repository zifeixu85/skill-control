import type { AgentUpdateJob } from "./agent-versions";

/**
 * Background one-click updates, keyed by version row id. The store polls the service while
 * anything runs, so rows can show a spinner, the step and the elapsed time while the user
 * keeps working; a listener (mounted once) turns finished jobs into toasts.
 */

export interface TrackedJob {
  rowId: string;
  name: string;
  jobId: string;
  startedAt: number;
  job: AgentUpdateJob | null;
  /** The last poll failed; it keeps trying. */
  stale: boolean;
}

type Listener = () => void;
type Finished = (tracked: TrackedJob) => void;

export function createJobStore(fetchJob: (jobId: string) => Promise<AgentUpdateJob>, { intervalMs = 1_500, maxErrors = 20 } = {}) {
  let jobs: Record<string, TrackedJob> = {};
  const listeners = new Set<Listener>();
  const finishedListeners = new Set<Finished>();
  const errors = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = () => listeners.forEach((listener) => listener());
  const update = (rowId: string, patch: Partial<TrackedJob>) => {
    const current = jobs[rowId];
    if (!current) return;
    jobs = { ...jobs, [rowId]: { ...current, ...patch } };
    emit();
  };
  const finish = (rowId: string) => {
    const tracked = jobs[rowId];
    if (!tracked) return;
    jobs = Object.fromEntries(Object.entries(jobs).filter(([key]) => key !== rowId));
    errors.delete(rowId);
    emit();
    finishedListeners.forEach((listener) => listener(tracked));
  };

  async function poll() {
    timer = null;
    const running = Object.values(jobs);
    await Promise.all(
      running.map(async (tracked) => {
        try {
          const job = await fetchJob(tracked.jobId);
          errors.delete(tracked.rowId);
          if (job.status === "running") update(tracked.rowId, { job, stale: false });
          else {
            update(tracked.rowId, { job, stale: false });
            finish(tracked.rowId);
          }
        } catch {
          const count = (errors.get(tracked.rowId) || 0) + 1;
          errors.set(tracked.rowId, count);
          update(tracked.rowId, { stale: true });
          if (count >= maxErrors) {
            update(tracked.rowId, {
              job: { id: tracked.jobId, status: "error", done: null, total: null, step: null, startedAt: tracked.startedAt, result: null, outputTail: null, error: "很久没拿到后台更新的进度，请在“Agent 软件”里重新检查。" },
            });
            finish(tracked.rowId);
          }
        }
      }),
    );
    schedule();
  }
  function schedule() {
    if (timer || !Object.keys(jobs).length) return;
    timer = setTimeout(() => void poll(), intervalMs);
  }

  return {
    get: () => jobs,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onFinished(listener: Finished) {
      finishedListeners.add(listener);
      return () => {
        finishedListeners.delete(listener);
      };
    },
    track(rowId: string, name: string, jobId: string, now = Date.now()) {
      jobs = { ...jobs, [rowId]: { rowId, name, jobId, startedAt: now, job: null, stale: false } };
      emit();
      schedule();
    },
    /** Test hook. */
    pollNow: () => poll(),
    reset() {
      if (timer) clearTimeout(timer);
      timer = null;
      jobs = {};
      errors.clear();
    },
  };
}
