import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { isWithin } from "./fs-safe.mjs";

/**
 * Copies a skill directory without ever materializing content from outside it.
 * Symlinks are dereferenced only when their real target stays inside the source skill;
 * links that escape, dangle or loop are skipped and reported by relative path.
 */

const ENTRY_LIMIT = 20_000;
const SKIP_MESSAGES = {
  outside: "指向技能目录之外",
  dangling: "链接目标不存在",
  loop: "循环链接",
  special: "不是普通文件或目录",
};

export function describeSkippedLinks(skipped) {
  if (!skipped.length) return null;
  const sample = skipped
    .slice(0, 5)
    .map((item) => `${item.path}（${SKIP_MESSAGES[item.reason] || item.reason}）`)
    .join("、");
  return `已跳过 ${skipped.length} 个不安全或无效的条目，复制结果中不会包含它们：${sample}${skipped.length > 5 ? " 等" : ""}。`;
}

async function walkSkillTree(sourceRoot, destinationRoot, { dryRun }) {
  const realRoot = await realpath(sourceRoot);
  const skipped = [];
  let count = 0;

  async function copyDirectory(sourceDirectory, destinationDirectory, relativeRoot, ancestors) {
    const entries = (await readdir(sourceDirectory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    if (!dryRun) await mkdir(destinationDirectory, { recursive: true });
    for (const entry of entries) {
      count += 1;
      if (count > ENTRY_LIMIT) {
        throw new Error(`技能目录包含超过 ${ENTRY_LIMIT} 个条目，已停止复制。`);
      }
      const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      let info;
      try {
        info = await lstat(sourcePath);
      } catch {
        continue;
      }
      let targetPath = sourcePath;
      if (info.isSymbolicLink()) {
        try {
          targetPath = await realpath(sourcePath);
        } catch {
          skipped.push({ path: relativePath, reason: "dangling" });
          continue;
        }
        if (!isWithin(realRoot, targetPath)) {
          skipped.push({ path: relativePath, reason: "outside" });
          continue;
        }
        info = await stat(targetPath);
      }
      if (info.isDirectory()) {
        if (ancestors.has(targetPath)) {
          skipped.push({ path: relativePath, reason: "loop" });
          continue;
        }
        await copyDirectory(
          targetPath,
          destinationPath,
          relativePath,
          new Set([...ancestors, targetPath]),
        );
        if (!dryRun) await utimes(destinationPath, info.atime, info.mtime);
      } else if (info.isFile()) {
        if (dryRun) continue;
        await copyFile(targetPath, destinationPath, constants.COPYFILE_EXCL);
        await chmod(destinationPath, info.mode & 0o777);
        await utimes(destinationPath, info.atime, info.mtime);
      } else {
        skipped.push({ path: relativePath, reason: "special" });
      }
    }
  }

  // Every walked path is real: the root is resolved and links are replaced by targets.
  await copyDirectory(realRoot, destinationRoot, "", new Set([realRoot]));
  if (!dryRun) {
    const rootInfo = await stat(realRoot);
    await utimes(destinationRoot, rootInfo.atime, rootInfo.mtime);
  }
  return { skippedLinks: skipped };
}

/** File-system errors carry absolute paths; callers only ever see a generic message. */
async function withPublicErrors(task, message) {
  try {
    return await task();
  } catch (error) {
    if (error?.code) throw new Error(message);
    throw error;
  }
}

/** Lists entries a copy would skip, without writing anything. */
export async function findUnsafeLinks(sourceRoot) {
  return withPublicErrors(
    async () => (await walkSkillTree(sourceRoot, sourceRoot, { dryRun: true })).skippedLinks,
    "无法读取来源技能目录，请重新扫描后再试。",
  );
}

/** Copies `sourceRoot` into a new `destinationRoot` (which must not exist yet). */
export async function copySkillTree(sourceRoot, destinationRoot) {
  return withPublicErrors(
    () => walkSkillTree(sourceRoot, destinationRoot, { dryRun: false }),
    "复制技能目录失败，目标未被修改。",
  );
}
