/**
 * Which sessions count in a window. A session is active on a day when it, or a subagent
 * transcript of it, started, used tokens or called a skill that day; a window's session
 * count is the number of distinct sessions active on at least one of its days (a long-running
 * session started before the window still counts). The start-day count is kept as
 * `sessionsStarted`.
 *
 * Session identity: a session file is its own session; a nested transcript (`s`, set by the
 * indexer) belongs to its parent session file. Entries indexed before the `sf` flag existed
 * count as sessions when a start was recorded for them. A database record is its own
 * session, active on its start day and on its end day when the product records one
 * (Hermes `ended_at`).
 */

export const isSessionFile = (entry) => entry.sf ?? Object.values(entry.d || {}).some((values) => values[0] > 0);

/** The session a transcript file belongs to, or null (OpenClaw transcripts: their sessions are DB records). */
export const sessionKeyOf = (key, entry) => entry.s || (isSessionFile(entry) ? key : null);

/** In-window days on which a transcript file shows activity. */
export function fileActiveDays(entry, inWindow) {
  const days = new Set();
  for (const [day, values] of Object.entries(entry.d || {})) {
    if (inWindow(day) && values.some((value) => value > 0)) days.add(day);
  }
  for (const byName of [entry.k, entry.ki]) {
    for (const byDay of Object.values(byName || {})) {
      for (const [day, count] of Object.entries(byDay)) if (count > 0 && inWindow(day)) days.add(day);
    }
  }
  return [...days];
}

/** In-window days on which a database session was active. */
export function recordActiveDays(record, inWindow) {
  const days = new Set();
  if (inWindow(record.d)) days.add(record.d);
  if (record.e && inWindow(record.e)) days.add(record.e);
  return [...days];
}

/** Distinct sessions per group key: add(group, sessionKey, days) then count(group) / perDay(group). */
export function sessionCounter() {
  const groups = new Map();
  return {
    add(group, sessionKey, days) {
      if (!sessionKey || !days.length) return;
      const target = groups.get(group) || { all: new Set(), byDay: new Map() };
      target.all.add(sessionKey);
      for (const day of days) {
        if (!target.byDay.has(day)) target.byDay.set(day, new Set());
        target.byDay.get(day).add(sessionKey);
      }
      groups.set(group, target);
    },
    count: (group) => groups.get(group)?.all.size || 0,
    onDay: (group, day) => groups.get(group)?.byDay.get(day)?.size || 0,
  };
}
