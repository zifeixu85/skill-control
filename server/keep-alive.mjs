/**
 * AbortSignal.timeout() uses an unreferenced timer, so when a request never settles and
 * nothing else is pending, Node can exit before the timeout fires (seen on Linux CI).
 * Runs `task` while a referenced timer keeps the event loop alive until it settles.
 */
export async function withKeepAlive(timeoutMs, task) {
  const timer = setTimeout(() => {}, timeoutMs + 100);
  try {
    return await task();
  } finally {
    clearTimeout(timer);
  }
}
