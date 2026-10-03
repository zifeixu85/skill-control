/**
 * Single-flight cache for expensive read-only scans.
 *
 * - Concurrent callers share one in-flight load.
 * - Results are reused for `ttlMs`; `force` bypasses the TTL but is ignored within
 *   `forceDebounceMs` of the last completed load, so a UI cannot trigger scan storms.
 * - Failed loads are not cached, so the next call retries.
 * - clear() discards the value; a load that started before it is not stored.
 */
export function createCachedLoader(load, { ttlMs, forceDebounceMs = 5_000, now = Date.now }) {
  let value = null;
  let loadedAt = 0;
  let inflight = null;
  let generation = 0;

  return {
    async get(force = false) {
      const age = now() - loadedAt;
      if (value !== null && (age < forceDebounceMs || (!force && age < ttlMs))) {
        return value;
      }
      if (inflight) return inflight;
      const startedGeneration = generation;
      let started;
      try {
        started = Promise.resolve(load());
      } catch (error) {
        started = Promise.reject(error);
      }
      const pending = started
        .then((result) => {
          if (startedGeneration === generation) {
            value = result;
            loadedAt = now();
          }
          return result;
        })
        .finally(() => {
          if (inflight === pending) inflight = null;
        });
      inflight = pending;
      return pending;
    },
    clear() {
      generation += 1;
      value = null;
      loadedAt = 0;
      inflight = null;
    },
    /** Last completed value (possibly stale), or the in-flight load, without starting one. */
    async peek() {
      if (value !== null) return value;
      return inflight ? inflight.catch(() => null) : null;
    },
  };
}
