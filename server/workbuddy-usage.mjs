import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Best-effort, read-only expert usage from WorkBuddy's local database. Only
 * `expert_id`, a count and MAX(updated_at) are queried — never titles or contents.
 * Cloud expert ids (`ex_…`) are ignored. Any failure (no node:sqlite, locked or
 * unexpected schema) is skipped with a generic warning.
 */

const ROW_LIMIT = 1_000;

/** "OpcTeam", "opc-team" and "opc_team" all normalize to "opcteam". */
export function normalizeExpertKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "")
    .slice(0, 128);
}

export async function readWorkBuddyExpertUsage(homeDirectory = homedir()) {
  const result = { available: false, usage: new Map(), warnings: [] };
  const databasePath = path.join(homeDirectory, ".workbuddy", "workbuddy.db");
  try {
    if (!(await lstat(databasePath)).isFile()) return result;
  } catch {
    return result;
  }
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    result.warnings.push("当前运行环境不支持读取 WorkBuddy 使用记录，已跳过。");
    return result;
  }
  let database;
  try {
    database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    // Defense in depth: the connection refuses any statement that would write.
    database.exec("PRAGMA query_only = 1");
    const columns = new Set(
      database.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name),
    );
    if (!columns.has("expert_id") || !columns.has("updated_at")) {
      result.warnings.push("WorkBuddy 使用记录的格式无法识别，已跳过。");
      return result;
    }
    const rows = database
      .prepare(
        `SELECT expert_id AS expertId, COUNT(*) AS count, MAX(updated_at) AS lastUsed
         FROM sessions
         WHERE expert_id IS NOT NULL AND expert_id <> '' AND expert_id NOT LIKE 'ex\\_%' ESCAPE '\\'
         GROUP BY expert_id
         LIMIT ${ROW_LIMIT}`,
      )
      .all();
    for (const row of rows) {
      const key = normalizeExpertKey(row.expertId);
      if (!key) continue;
      const lastUsed = Number(row.lastUsed);
      const previous = result.usage.get(key);
      const count = (previous?.count || 0) + (Number(row.count) || 0);
      const lastMs = Math.max(previous?.lastMs || 0, Number.isFinite(lastUsed) ? lastUsed : 0);
      result.usage.set(key, {
        count,
        lastMs,
        lastUsedAt: lastMs ? new Date(lastMs).toISOString() : null,
      });
    }
    result.available = true;
  } catch {
    result.warnings.push("WorkBuddy 使用记录暂时无法读取（数据库可能正被占用），已跳过。");
  } finally {
    try {
      database?.close();
    } catch {
      // Closing a failed handle is best effort.
    }
  }
  return result;
}

/** Public usage entry for an expert, matched by plugin name or agent name. */
export function usageFor(usage, ...names) {
  for (const name of names) {
    const entry = usage?.get(normalizeExpertKey(name));
    if (entry) return { count: entry.count, lastUsedAt: entry.lastUsedAt };
  }
  return null;
}
