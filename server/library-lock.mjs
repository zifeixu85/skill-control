import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeWrite } from "./home-guard.mjs";
import { readSkillsLock } from "./update-sources.mjs";

/**
 * ~/.agent-skill-manager/library-lock.json (docs §1.6): one record per library skill with
 * provenance imported read-only from ~/.agents/.skill-lock.json, the local content hash,
 * where it was adopted from and how each Agent sees it. Keys are sorted for stable diffs.
 */

export function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJson(value[key])]));
  }
  return value;
}

const MODES = { native: "native", config: "config", link: "link", copy: "copy" };

/**
 * `added`: [{ name, from }] skills copied into the library by this run (from: "app", "cli",
 * "auto" …); they are recorded as local skills with `addedFrom`. Copy-tier fanouts record the
 * library content hash they were copied from (`sourceHash`), so a later library update shows.
 */
export async function writeLibraryLock({ stateDirectory, homeDirectory, library, adopted = [], added = [], removed = [], now = Date.now() }) {
  const file = path.join(stateDirectory, "library-lock.json");
  let current = { version: 1, skills: {} };
  try {
    current = JSON.parse(await readFile(file, "utf8"));
  } catch {
    current = { version: 1, skills: {} };
  }
  const skills = { ...(current.skills || {}) };
  const upstream = await readSkillsLock(homeDirectory);
  const stamp = new Date(now).toISOString();
  const adoptedFrom = new Map(adopted.map((item) => [item.name, item.from]));
  const addedFrom = new Map(added.map((item) => [item.name, item.from]));
  for (const name of removed) delete skills[name];
  for (const entry of library.internal.entries) {
    if (entry.kind !== "real") continue;
    const previous = skills[entry.name] || {};
    const lock = upstream.entries.get(entry.name);
    const fanout = {};
    for (const [agentId, view] of Object.entries(entry.fanout || {})) {
      if (view.state === "visible" && MODES[view.tier]) fanout[agentId] = { mode: MODES[view.tier], path: view.path || null, ...(view.tier === "copy" ? { sourceHash: entry.hash || null } : {}), verifiedAt: stamp };
    }
    skills[entry.name] = {
      source: lock?.source || previous.source || null,
      sourceType: lock ? lock.sourceType : previous.sourceType || (adoptedFrom.has(entry.name) ? "adopted" : "local"),
      sourceUrl: lock?.sourceUrl || previous.sourceUrl || null,
      skillPath: lock?.skillPath || previous.skillPath || null,
      ref: previous.ref || null,
      commit: previous.commit || null,
      upstreamHash: lock?.skillFolderHash || previous.upstreamHash || null,
      contentHash: entry.hash || null,
      adoptedFrom: adoptedFrom.get(entry.name) || previous.adoptedFrom || null,
      ...(addedFrom.has(entry.name) || previous.addedFrom ? { addedFrom: addedFrom.get(entry.name) || previous.addedFrom } : {}),
      fanout,
      installedAt: previous.installedAt || stamp,
      updatedAt: adoptedFrom.has(entry.name) || addedFrom.has(entry.name) || !previous.updatedAt ? stamp : previous.updatedAt,
    };
  }
  await assertSafeWrite(file, homeDirectory);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(sortedJson({ version: 1, skills }), null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
