import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "./fs-links.mjs";
import { frontmatterBlock, readNestedYamlScalar, readYamlScalar } from "./frontmatter.mjs";

/**
 * The companion skill `skill-control` (v0.3 §4.2), shipped with the app in
 * resources/skills/skill-control (unpacked from app.asar). It teaches Agents to install
 * skills through the library. Installing it uses the app's own install flow: into the
 * library, then connected to the primary Agents (undoable from history).
 */

export const COMPANION_NAME = "skill-control";
/** The bundled folder; in a packaged app the unpacked copy next to app.asar (plain files). */
export function companionSkillPath() {
  const packed = fileURLToPath(new URL("../resources/skills/skill-control", import.meta.url));
  const unpacked = packed.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  return unpacked !== packed && existsSync(unpacked) ? unpacked : packed;
}

/** The bundled copy: where it is, its content hash and declared version. */
export async function bundledCompanion(directory = companionSkillPath()) {
  if (!(await stat(directory).catch(() => null))?.isDirectory()) return null;
  const manifest = await readFile(path.join(directory, "SKILL.md"), "utf8").catch(() => "");
  const block = frontmatterBlock(manifest);
  return {
    path: directory,
    name: readYamlScalar(block, "name") || COMPANION_NAME,
    version: readNestedYamlScalar(block, "metadata", "version") || null,
    hash: await contentHash(directory),
  };
}

/** GET /api/library/companion-skill: bundled version vs the library's copy, and who sees it. */
export async function companionStatus({ view, bundled }) {
  const entry = view.entries.find((item) => item.name === COMPANION_NAME);
  return {
    name: COMPANION_NAME,
    available: Boolean(bundled),
    version: bundled?.version || null,
    inLibrary: Boolean(entry),
    // The library view shows the first 16 hex digits of the content hash.
    upToDate: Boolean(entry && bundled?.hash && entry.hash === bundled.hash.slice(0, 16)),
    fanout: entry ? Object.fromEntries(Object.entries(entry.fanout).map(([agentId, item]) => [agentId, { tier: item.tier, state: item.state }])) : {},
  };
}
