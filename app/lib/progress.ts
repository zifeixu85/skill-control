/** Progress helpers for long writes: a gentle curve when the real progress is unknown. */

/**
 * Eases toward 90% while running and never reaches it: about 60% at `expectedMs`, 82% at
 * twice that. The caller shows 100% only when the work really finished.
 */
export function simulatedProgress(elapsedMs: number, expectedMs = 20_000): number {
  if (!(elapsedMs > 0)) return 0.03;
  const tau = Math.max(1_000, expectedMs) / 1.1;
  return Math.min(0.9, 0.03 + 0.87 * (1 - Math.exp(-elapsedMs / tau)));
}

/** "8 秒", "1 分 05 秒", "1 小时 2 分". */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
