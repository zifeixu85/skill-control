import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { classifyPath, relativeLinkTarget } from "./fs-links.mjs";
import { compactHomePath, homeVariants, object } from "./fs-safe.mjs";
import { tierOf } from "./library-agents.mjs";
import { isReversible, LibraryError, recordOp, runOps } from "./library-ops.mjs";
import { createPlanStore } from "./plan-store.mjs";
import { createHasher, readLibrary } from "./library.mjs";
import { writeLibraryLock } from "./library-lock.mjs";
import { disableOps } from "./library-switches.mjs";
import { withStateLock } from "./state-lock.mjs";
import { listTrash as listTrashEntries, restoreTrash } from "./trash.mjs";

/**
 * Library plans: adopt, link, unlink, disable, remove, the batch clean-up, the one-off
 * catch-up of baseline gaps and installs through the library. A plan is a list of items,
 * each a small transaction of reversible ops; nothing runs without a plan from this process
 * (10 minutes, single use) and an explicit confirmation — except auto-link runs
 * (server/auto-link.mjs), which execute link / copy items for "missing" pairs only. Every
 * execution holds the library lock (shared with the CLI), re-checks visibility, rolls back
 * failing items and writes one history record that history can undo.
 */

export const LIBRARY_PLAN_TTL_MS = 10 * 60_000;
const CHOICES = ["keep-library", "use-this", "save-as", "skip"];
const NAME = /^[\p{L}\p{N}_.@+ -]{1,128}$/u;

const timestamp = (now) => new Date(now).toISOString().replace(/[:.]/gu, "-");

export function createLibraryManager(context) {
  const now = context.now || (() => Date.now());
  const plans = createPlanStore({ ttlMs: LIBRARY_PLAN_TTL_MS, now });
  let homes = context.homes;
  const homesReady = homeVariants(context.homeDirectory).then((variants) => {
    homes = [...new Set([...context.homes, ...variants])];
  });
  const display = (value) => compactHomePath(value, homes);

  async function snapshot() {
    const config = await context.getConfig();
    const library = await readLibrary({ config, homeDirectory: context.homeDirectory, homes: context.homes, stateDirectory: context.stateDirectory, hasher: createHasher() });
    return { config, library, ...library.internal };
  }

  // -------------------------------------------------------------------------
  // Item builders. Each returns { id, title, kind, skill, agentId?, choices?, choice, ops, expect }.

  function linkOps(agent, linkPath, libraryEntryPath) {
    return [{ op: "link", path: linkPath, relativeTarget: relativeLinkTarget(linkPath, libraryEntryPath), absoluteTarget: libraryEntryPath }];
  }

  /** A new relative link from an Agent's link folder to a library entry. */
  function linkItem(agent, entry, linkPath) {
    return { id: `link:${agent.agentId}:${entry.name}`, title: `${agent.name}：链接 ${entry.name} 到库`, kind: "link", skill: entry.name, agentId: agent.agentId, choices: ["link", "skip"], choice: "link", ops: linkOps(agent, linkPath, entry.path), expect: [agent.agentId] };
  }

  /** Agents that skip links (copy tier) get a copy of the library entry, or keep their own version. */
  async function copyTierItem(agent, entry, state, group, choices = {}) {
    if (!agent.linkDir) return null;
    const location = path.join(agent.linkDir, entry.name);
    const classified = await classifyPath(location, entry.path);
    const base = { skill: entry.name, agentId: agent.agentId };
    const copyOp = { op: "copy", from: entry.real || entry.path, to: location };
    if (classified.kind === "absent") {
      return { ...base, id: `copy:${agent.agentId}:${entry.name}`, title: `${agent.name}：复制 ${entry.name}（该 Agent 不跟随软链接）`, kind: "copy", choices: ["copy", "skip"], choice: "copy", ops: [copyOp], expect: [agent.agentId] };
    }
    if (["link-to-library", "foreign-link", "broken-link"].includes(classified.kind)) {
      return { ...base, id: `copy:${agent.agentId}:${entry.name}`, title: `${agent.name}：把 ${entry.name} 的链接换成复制（该 Agent 不跟随软链接）`, kind: "copy", choices: ["copy", "skip"], choice: "copy", ops: [{ op: "unlink", path: location }, copyOp], expect: [agent.agentId] };
    }
    if (classified.kind !== "real-dir") return null;
    if (entry.hash && (await state.hasher(location)) === entry.hash) return null;
    const requested = choices[`conflict:${agent.agentId}:${entry.name}`];
    const choice = ["use-library", "skip"].includes(requested) ? requested : "skip";
    return {
      ...base,
      id: `conflict:${agent.agentId}:${entry.name}`,
      title: `${agent.name}：${entry.name} 与库内容不同`,
      kind: "conflict",
      choices: ["use-library", "skip"],
      choice,
      requiresChoice: !["use-library", "skip"].includes(requested),
      ops: choice === "use-library" ? [{ op: "stash", path: location, to: backupPath(group, agent.agentId, entry.name) }, copyOp] : [],
      expect: choice === "skip" ? [] : [agent.agentId],
    };
  }

  /**
   * What connecting one library entry to one Agent takes, by the Agent's tier: nothing for
   * native readers, the Hermes config change (opt-in) plus its own copies for Hermes, a
   * link for link-tier Agents (own copies go through the copy / conflict items), a copy for
   * copy-tier Agents. `configChoice` is the default choice of the Hermes config item.
   */
  async function connectItems(agent, entry, state, group, { choices = {}, requestedChoice, configChoice = "skip" } = {}) {
    const tier = tierOf(agent.agentId);
    const items = [];
    if (tier === "config") {
      const item = await hermesConfigItem(agent, state);
      if (item) items.push({ ...item, choice: configChoice });
    }
    if (tier === "copy") {
      const item = await copyTierItem(agent, entry, state, group, choices);
      return item ? [...items, item] : items;
    }
    if (!["link", "config"].includes(tier)) return items;
    let handled = false;
    for (const location of agent.ownDirs.map((directory) => path.join(directory, entry.name))) {
      const item = await copyItem(agent, location, entry, state, group, requestedChoice, choices);
      if (item) {
        items.push(item);
        handled = true;
      }
    }
    const linkPath = agent.linkDir ? path.join(agent.linkDir, entry.name) : null;
    if (!handled && tier === "link" && linkPath && (await classifyPath(linkPath, entry.path)).kind === "absent") items.push(linkItem(agent, entry, linkPath));
    return items;
  }

  /** What to leave at an agent's own location once the library holds the skill. */
  function fanBackOps(agent, location, libraryEntryPath, state) {
    const tier = tierOf(agent.agentId);
    if (tier === "link") return linkOps(agent, location, libraryEntryPath);
    if (tier === "config" && !(agent.switches.externalDirs || []).includes(state.realRoot)) return linkOps(agent, location, libraryEntryPath);
    return [];
  }

  const backupPath = (group, agentId, name) => path.join(context.backupDirectory, group, agentId, name);

  /** A library link pointing into an agent's own folder: move the real folder into the library. */
  function adoptReverseLink(entry, state, group) {
    const owner = state.agents.find((agent) => agent.realOwnDirs.some((directory) => path.dirname(entry.real) === directory));
    if (!owner || entry.gitCheckout) {
      return { id: `external:${entry.name}`, title: `${entry.name}：链接指向 ${display(entry.real)}，由外部管理，不搬动`, kind: "external", skill: entry.name, choice: "skip", ops: [], expect: [] };
    }
    const ops = [
      { op: "backup", from: entry.real, to: backupPath(group, owner.agentId, entry.name) },
      { op: "unlink", path: entry.path },
      { op: "move", from: entry.real, to: entry.path },
    ];
    // Links elsewhere that pointed at the old real folder now point at the library.
    for (const agent of state.agents) {
      for (const directory of agent.ownDirs) {
        const candidate = path.join(directory, entry.name);
        if (candidate === entry.real) continue;
        if (state.linkTargets.get(candidate) === entry.real) ops.push({ op: "unlink", path: candidate }, ...linkOps(agent, candidate, entry.path));
      }
    }
    ops.push(...fanBackOps(owner, entry.real, entry.path, state));
    return {
      id: `adopt-link:${entry.name}`,
      title: `收编 ${entry.name}（从 ${display(entry.real)} 移入库）`,
      kind: "adopt",
      skill: entry.name,
      choices: ["adopt", "skip"],
      choice: "adopt",
      ops,
      expect: state.agents.filter((agent) => entry.fanout?.[agent.agentId]?.state === "visible" && tierOf(agent.agentId) !== "none").map((agent) => agent.agentId),
    };
  }

  /** An agent's own copy next to a library entry with the same name. */
  async function copyItem(agent, location, entry, state, group, requestedChoice, choices = {}) {
    // The UI sends `choices: { "conflict:<agent>:<name>": choice }`; a single action may send `choice`.
    const requested = requestedChoice ?? choices[`conflict:${agent.agentId}:${entry.name}`];
    const classified = await classifyPath(location, entry.path);
    const tier = tierOf(agent.agentId);
    const base = { skill: entry.name, agentId: agent.agentId };
    if (classified.kind === "absent" || classified.kind === "link-to-library") return null;
    if (classified.kind === "foreign-link" && (await state.isExternal(classified.real))) return null;
    if (classified.kind === "broken-link") {
      return { ...base, id: `relink:${agent.agentId}:${entry.name}`, title: `${agent.name}：替换失效链接 ${entry.name}`, kind: "link", choice: "link", choices: ["link", "skip"], ops: [{ op: "unlink", path: location }, ...fanBackOps(agent, location, entry.path, state)], expect: [agent.agentId] };
    }
    const identical =
      (classified.kind === "real-dir" || classified.kind === "foreign-link") && entry.hash && (await state.hasher(location)) === entry.hash;
    const removeCopy = classified.kind === "foreign-link" ? [{ op: "unlink", path: location }] : [{ op: "stash", path: location, to: backupPath(group, agent.agentId, entry.name) }];
    const backAgain = fanBackOps(agent, location, entry.path, state);
    if (identical) {
      return {
        ...base,
        id: `dedupe:${agent.agentId}:${entry.name}`,
        title: tier === "native" ? `${agent.name}：删除与库相同的副本 ${entry.name}（先备份）` : `${agent.name}：${entry.name} 改为链接到库`,
        kind: tier === "native" ? "dedupe" : "link",
        choices: ["link", "skip"],
        choice: "link",
        ops: [...removeCopy, ...backAgain],
        expect: [agent.agentId],
      };
    }
    const choice = CHOICES.includes(requested) ? requested : "skip";
    const ops = {
      "keep-library": [...removeCopy, ...backAgain],
      "use-this": classified.kind === "real-dir" ? [{ op: "stash", path: entry.path, to: backupPath(group, "library", entry.name) }, { op: "move", from: location, to: entry.path }, ...backAgain] : [],
      "save-as": classified.kind === "real-dir" ? [{ op: "move", from: location, to: `${entry.path}@${agent.agentId}` }, ...backAgain] : [],
      skip: [],
    }[choice];
    return {
      ...base,
      id: `conflict:${agent.agentId}:${entry.name}`,
      title: `${agent.name}：${entry.name} 与库内容不同`,
      kind: "conflict",
      choices: classified.kind === "real-dir" ? CHOICES : ["keep-library", "skip"],
      choice,
      requiresChoice: !CHOICES.includes(requested),
      ops,
      expect: choice === "skip" ? [] : [agent.agentId],
    };
  }

  /** A real folder in an agent's own folder that the library does not have yet. */
  function adoptCandidate(agent, location, name, state, group) {
    const target = path.join(state.libraryPath, name);
    return {
      id: `adopt:${agent.agentId}:${name}`,
      title: `收编 ${agent.name} 的 ${name} 到库`,
      kind: "adopt",
      skill: name,
      agentId: agent.agentId,
      choices: ["adopt", "skip"],
      choice: "adopt",
      ops: [{ op: "backup", from: location, to: backupPath(group, agent.agentId, name) }, { op: "move", from: location, to: target }, ...fanBackOps(agent, location, target, state)],
      expect: [agent.agentId],
    };
  }

  async function hermesConfigItem(agent, state) {
    if ((agent.switches.externalDirs || []).includes(state.realRoot)) return null;
    const hermes = await context.findCommand("hermes");
    const current = (state.hermesConfiguredDirs || []).filter((value) => typeof value === "string");
    const next = [...new Set([...current, "~/.agents/skills"])];
    return {
      id: "hermes-external-dirs",
      title: "让 Hermes 读取技能库（skills.external_dirs）",
      kind: "config",
      skill: null,
      agentId: "hermes",
      choices: ["configure", "skip"],
      choice: "skip",
      ops: hermes ? context.hermesCommandOps(hermes, ["config", "set", "skills.external_dirs", JSON.stringify(next)]) : await context.hermesYamlOps(next),
      expect: [],
    };
  }

  async function prepareState(raw) {
    const state = { ...raw, hasher: createHasher(), linkTargets: new Map() };
    for (const agent of state.agents) {
      for (const directory of agent.ownDirs) {
        for (const name of await readdir(directory).catch(() => [])) {
          const location = path.join(directory, name);
          const classified = await classifyPath(location, null);
          if (classified.real) state.linkTargets.set(location, classified.real);
        }
      }
    }
    state.isExternal = async (real) => Boolean(real) && (await context.isExternalPath(real));
    state.hermesConfiguredDirs = await context.hermesConfiguredDirs();
    return state;
  }

  async function buildItems(input, raw, group) {
    const state = await prepareState(raw);
    const entries = new Map(state.entries.map((entry) => [entry.name, entry]));
    const agents = new Map(state.agents.map((agent) => [agent.agentId, agent]));
    const choices = object(input.choices);
    const items = [];
    const skill = typeof input.skill === "string" && NAME.test(input.skill) ? input.skill : null;
    const targetAgents = (Array.isArray(input.agents) ? input.agents : state.agents.filter((agent) => agent.primary).map((agent) => agent.agentId))
      .map((id) => agents.get(id))
      .filter(Boolean);
    const own = (agent, name) => agent.ownDirs.map((directory) => path.join(directory, name));

    switch (input.action) {
      case "adopt": {
        if (!skill) throw new LibraryError(400, "缺少技能名称。", "invalid-request");
        const entry = entries.get(skill);
        if (entry?.kind === "link-external") items.push(adoptReverseLink(entry, state, group));
        else if (entry?.kind === "real") {
          for (const agent of targetAgents) for (const location of own(agent, skill)) {
            const item = await copyItem(agent, location, entry, state, group, input.choice, choices);
            if (item) items.push(item);
          }
        } else if (!entry) {
          let found = null;
          for (const agent of input.from ? [agents.get(input.from)].filter(Boolean) : state.agents) {
            for (const location of own(agent, skill)) {
              if (!found && (await classifyPath(location, null)).kind === "real-dir") found = { agent, location };
            }
          }
          if (!found) throw new LibraryError(404, "没有找到可收编的技能目录。", "not-found");
          items.push(adoptCandidate(found.agent, found.location, skill, state, group));
        }
        break;
      }
      case "link": {
        const entry = entries.get(skill);
        if (!entry || entry.kind === "broken") throw new LibraryError(404, "库中没有这个技能。", "not-found");
        // Linking on request includes the Hermes config change (the user asked for this Agent).
        for (const agent of targetAgents) items.push(...(await connectItems(agent, entry, state, group, { choices, requestedChoice: input.choice, configChoice: "configure" })));
        break;
      }
      case "catch-up": {
        // The baseline gaps (server/auto-link.mjs computes the pairs): links / copies for
        // "missing" pairs only, plus the Hermes config change as an opt-in item.
        const pairs = Array.isArray(input.pairs) ? input.pairs : [];
        const configAgents = new Set();
        for (const pair of pairs) {
          const agent = agents.get(pair.agentId);
          const entry = entries.get(pair.skill);
          if (!agent || !entry || entry.kind === "broken" || entry.fanout?.[agent.agentId]?.state !== "missing") continue;
          if (tierOf(agent.agentId) === "config") {
            configAgents.add(agent);
            continue;
          }
          items.push(...(await connectItems(agent, entry, state, group, { choices })).filter((item) => ["link", "copy"].includes(item.kind)));
        }
        for (const agent of configAgents) {
          const item = await hermesConfigItem(agent, state);
          if (item) items.push(item);
        }
        break;
      }
      case "install": {
        items.push(...(await installItems(input.install, state, group, choices)));
        break;
      }
      case "unlink": {
        for (const agent of targetAgents) for (const location of own(agent, skill || "")) {
          if (skill && (await classifyPath(location, entries.get(skill)?.path)).kind === "link-to-library") {
            items.push({ id: `unlink:${agent.agentId}:${skill}`, title: `${agent.name}：移除 ${skill} 的链接`, kind: "unlink", skill, agentId: agent.agentId, choices: ["unlink", "skip"], choice: "unlink", ops: [{ op: "unlink", path: location }], expect: [] });
          }
        }
        break;
      }
      case "disable": {
        if (!skill) throw new LibraryError(400, "缺少技能名称。", "invalid-request");
        for (const agent of targetAgents) {
          const item = await disableOps(agent, skill, { ...context, group, libraryEntry: entries.get(skill) });
          if (item) items.push(item);
        }
        break;
      }
      case "remove": {
        const entry = entries.get(skill);
        if (!entry) throw new LibraryError(404, "库中没有这个技能。", "not-found");
        const trashId = `${group}-${skill}`.replace(/[^\w.@-]/gu, "_");
        const trashRoot = path.join(context.stateDirectory, "trash", trashId);
        const links = [];
        const ops = [];
        for (const agent of state.agents) for (const location of own(agent, skill)) {
          if ((await classifyPath(location, entry.path)).kind === "link-to-library") {
            links.push({ path: location, target: relativeLinkTarget(location, entry.path) });
            ops.push({ op: "unlink", path: location });
          }
        }
        ops.push(entry.kind === "real" ? { op: "stash", path: entry.path, to: path.join(trashRoot, skill) } : { op: "unlink", path: entry.path });
        ops.push({
          op: "write",
          path: path.join(trashRoot, "manifest.json"),
          content: `${JSON.stringify({ trashId, name: skill, source: "library", originalPath: entry.path, kind: entry.kind === "real" ? "real" : "link", linkTarget: entry.kind === "real" ? null : entry.real, links, removedAt: new Date(now()).toISOString() }, null, 2)}\n`,
          backup: path.join(trashRoot, "manifest.previous.json"),
        });
        items.push({ id: `remove:${skill}`, title: `从库中移除 ${skill}（移到回收站，可恢复）`, kind: "remove", skill, choices: ["remove", "skip"], choice: "remove", ops, expect: [], trashId });
        break;
      }
      case "batch": {
        for (const entry of state.entries) {
          if (entry.kind === "link-external") items.push(adoptReverseLink(entry, state, group));
          if (entry.gitCheckout) items.push({ id: `external:${entry.name}`, title: `${entry.name} 是 git 检出，标为外部托管，不搬动（用它自己的升级方式更新）`, kind: "external", skill: entry.name, choice: "skip", ops: [], expect: [] });
        }
        for (const agent of state.agents.filter((item) => item.primary && ["link", "native"].includes(item.tier))) {
          for (const entry of state.entries.filter((item) => item.kind === "real" && !item.gitCheckout)) {
            for (const location of own(agent, entry.name)) {
              if (entry.gitCheckout || (await state.isExternal(location))) continue;
              const item = await copyItem(agent, location, entry, state, group, undefined, choices);
              if (item) items.push(item);
            }
          }
        }
        const hermes = state.agents.find((agent) => agent.agentId === "hermes" && agent.primary);
        if (hermes) {
          const item = await hermesConfigItem(hermes, state);
          if (item) items.push(item);
        }
        break;
      }
      default:
        throw new LibraryError(400, "未知的操作。", "invalid-request");
    }
    // Per-item choices from the request: "skip" drops an item; an opt-in item (default
    // "skip", e.g. the Hermes config change) runs when its action is chosen. Conflicts take
    // their choice in copyItem.
    for (const item of items) {
      const requested = choices[item.id];
      if (!requested || item.kind === "conflict" || !item.choices?.includes(requested)) continue;
      if (requested === "skip") Object.assign(item, { choice: "skip", ops: [], expect: [] });
      else item.choice = requested;
    }
    return { items, state };
  }

  /**
   * Installing a skill through the library (§3): copy it in unless the library already has
   * the same content, then connect it to each target Agent by tier. `install`: { sourcePath,
   * name, sourceHash, agentIds, skipAgentIds? } (skipAgentIds: Agents left unticked, tombstoned
   * for auto-link when the plan is applied). A library entry with the same name and other content
   * blocks the plan until the user picks "use-new" (old version backed up) or "keep-library".
   */
  async function installItems(install, state, group, choices) {
    const name = install?.name;
    if (typeof name !== "string" || !NAME.test(name) || name.startsWith(".")) throw new LibraryError(400, "技能名称无效。", "invalid-request");
    if (typeof install.sourcePath !== "string") throw new LibraryError(400, "缺少技能来源。", "invalid-request");
    const libraryEntryPath = path.join(state.libraryPath, name);
    const existing = state.entries.find((entry) => entry.name === name);
    const sourceReal = await realpath(install.sourcePath).catch(() => install.sourcePath);
    const items = [];
    let entry;
    let addId = null;
    const fresh = { name, path: libraryEntryPath, real: libraryEntryPath, hash: install.sourceHash || null, kind: "real", fanout: {} };
    if (!existing) {
      addId = `add:${name}`;
      items.push({ id: addId, title: `把 ${name} 放进技能库`, kind: "add", skill: name, choices: ["add"], choice: "add", ops: [{ op: "copy", from: install.sourcePath, to: libraryEntryPath }], expect: [] });
      entry = fresh;
    } else if (existing.real && existing.real === sourceReal) {
      // The source is the library entry itself: only connect it to more Agents.
      entry = existing;
    } else if (existing.kind !== "broken" && existing.hash && existing.hash === install.sourceHash) {
      items.push({ id: `add:${name}`, title: `技能库里已有相同的 ${name}，直接使用`, kind: "already", skill: name, choice: "skip", ops: [], expect: [] });
      entry = existing;
    } else {
      const requested = choices[`replace:${name}`];
      const choice = ["use-new", "keep-library"].includes(requested) ? requested : null;
      const replace = existing.kind === "real" ? { op: "stash", path: existing.path, to: backupPath(group, "library", name) } : { op: "unlink", path: existing.path };
      if (choice === "use-new") addId = `replace:${name}`;
      items.push({
        id: `replace:${name}`,
        title: existing.kind === "broken" ? `技能库里的 ${name} 是失效链接，换成新内容` : `技能库里已有不同内容的 ${name}`,
        kind: "conflict",
        skill: name,
        choices: ["use-new", "keep-library"],
        choice: choice || "keep-library",
        requiresChoice: !choice,
        blocking: !choice,
        ops: choice === "use-new" ? [replace, { op: "copy", from: install.sourcePath, to: libraryEntryPath }] : [],
        expect: [],
      });
      entry = choice === "use-new" || existing.kind === "broken" ? fresh : existing;
    }
    for (const agentId of install.agentIds || []) {
      const agent = state.agents.find((item) => item.agentId === agentId);
      if (!agent) continue;
      for (const item of await connectItems(agent, entry, state, group, { choices, configChoice: "configure" })) items.push(addId && item.kind !== "config" ? { ...item, dependsOn: addId } : item);
    }
    return items;
  }

  /** Auto-link items: one link or copy per "missing" pair (never conflicts, never config changes). */
  function autoLinkItems(pairs, state) {
    const items = [];
    for (const { agentId, skill } of pairs) {
      const agent = state.agents.find((item) => item.agentId === agentId);
      const entry = state.entries.find((item) => item.name === skill);
      if (!agent?.linkDir || !entry || entry.kind === "broken") continue;
      const location = path.join(agent.linkDir, entry.name);
      const tier = tierOf(agentId);
      if (tier === "link") items.push({ ...linkItem(agent, entry, location), id: `auto-link:${agentId}:${skill}`, title: `${agent.name}：自动接入 ${skill}` });
      else if (tier === "copy") items.push({ id: `auto-link:${agentId}:${skill}`, title: `${agent.name}：自动复制 ${skill}`, kind: "copy", skill, agentId, choice: "copy", ops: [{ op: "copy", from: entry.real || entry.path, to: location }], expect: [agentId] });
    }
    return items;
  }

  function publicStep(op) {
    const step = { type: op.op };
    if (op.path) step.path = display(op.path);
    if (op.from) step.from = display(op.from);
    if (op.to) step.to = display(op.to);
    if (op.relativeTarget) step.target = op.relativeTarget;
    if (op.op === "command") step.command = [display(op.file), ...op.args].join(" ");
    if (op.op === "write" && op.diff) step.diff = op.diff;
    return step;
  }

  function publicItem(item) {
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      skill: item.skill,
      ...(item.agentId ? { agentId: item.agentId } : {}),
      ...(item.choices ? { choices: item.choices } : {}),
      choice: item.choice,
      ...(item.requiresChoice ? { requiresChoice: true } : {}),
      ...(item.dependsOn ? { dependsOn: item.dependsOn } : {}),
      steps: item.choice === "skip" ? [] : item.ops.map(publicStep),
    };
  }

  /** Per Agent: how many items of each kind the plan has (for "WorkBuddy 将接入 132 个"). */
  function byAgent(items) {
    const counts = {};
    for (const item of items.filter((entry) => entry.agentId && entry.choice !== "skip" && entry.ops.length)) {
      counts[item.agentId] ||= {};
      counts[item.agentId][item.kind] = (counts[item.agentId][item.kind] || 0) + 1;
    }
    return counts;
  }

  async function plan(input = {}) {
    await homesReady;
    const raw = await snapshot();
    const group = timestamp(now());
    const { items } = await buildItems(input, raw, group);
    const active = items.filter((item) => item.choice !== "skip" && item.ops.length);
    const publicItems = items.map(publicItem);
    const summary = {};
    for (const item of items) summary[item.kind] = (summary[item.kind] || 0) + 1;
    const needsChoice = items.filter((item) => item.requiresChoice).length;
    const blocked = items.some((item) => item.blocking);
    // Agents an install leaves unticked: auto-link must not connect them to this skill later.
    // Their tombstones are written with the apply, under the same lock as the links.
    const known = new Set(raw.agents.map((agent) => agent.agentId));
    const skip = input.action === "install" && Array.isArray(input.install?.skipAgentIds)
      ? [...new Set(input.install.skipAgentIds)].filter((agentId) => typeof agentId === "string" && known.has(agentId)).map((agentId) => ({ agentId, skill: input.install.name }))
      : [];
    const extra = { byAgent: byAgent(items), ...(input.action === "install" ? { autoLinkSkip: skip.map((pair) => pair.agentId) } : {}) };
    if (!active.length || blocked) {
      return { planId: null, action: input.action, items: publicItems, summary, needsChoice, ...extra, message: blocked || needsChoice ? "需要先为冲突项选择处理方式。" : "没有需要执行的改动。" };
    }
    const planId = plans.remember({ action: input.action, items: active, group, skip });
    return { planId, action: input.action, items: publicItems, summary, needsChoice, ...extra, expiresAt: new Date(now() + LIBRARY_PLAN_TTL_MS).toISOString() };
  }

  /**
   * Executes items under the library lock: each item is all-or-nothing, items whose
   * dependency failed are skipped, visibility is re-checked once (items whose Agents still
   * cannot see the skill are rolled back), the library lock file is updated and one history
   * record is written. `context.onApplied` gets the applied items (auto-link bookkeeping) and,
   * when anything was applied, the pairs auto-link must skip from now on (`skip`).
   */
  async function runItems({ action, items, group, origin = "app", skip = [] }) {
    if (context.readOnly) throw new LibraryError(409, "只读模式下不修改技能库。", "read-only");
    return withStateLock(context.stateDirectory, async () => {
      const opContext = {
        homeDirectory: context.homeDirectory,
        display,
        backupGroup: path.join(context.backupDirectory, group),
        platform: context.platform,
        fsImpl: context.fsImpl,
        run: context.run,
        commandEnv: context.commandEnv,
      };
      const results = [];
      const failed = new Set();
      for (const item of items) {
        if (item.dependsOn && failed.has(item.dependsOn)) {
          failed.add(item.id);
          results.push({ item, status: "skipped", error: "它依赖的上一步没有完成，已跳过。" });
          continue;
        }
        try {
          const undo = await runOps(item.ops, opContext);
          results.push({ item, undo, status: "applied" });
        } catch (error) {
          failed.add(item.id);
          results.push({ item, status: "failed", error: String(error?.message || error).slice(0, 300) });
        }
      }
      // Re-verify visibility once, then roll back items whose Agents lost the skill.
      const after = await snapshot();
      const byName = new Map(after.library.entries.map((entry) => [entry.name, entry]));
      for (const result of [...results].reverse()) {
        if (result.status !== "applied") continue;
        const entry = byName.get(result.item.skill);
        const lost = result.item.expect.filter((agentId) => entry?.fanout?.[agentId]?.state !== "visible");
        if (lost.length) {
          await result.undo();
          Object.assign(result, { status: "rolled-back", error: `复验未通过（${lost.join("、")} 看不到该技能），已回滚。` });
        }
      }
      const final = await snapshot();
      await writeLibraryLock({
        stateDirectory: context.stateDirectory,
        homeDirectory: context.homeDirectory,
        library: final.library,
        adopted: results.filter((result) => result.status === "applied" && result.item.kind === "adopt").map((result) => ({ name: result.item.skill, from: result.item.agentId || "library-link" })),
        added: results.filter((result) => result.status === "applied" && result.item.ops.some((op) => op.op === "copy" && op.to === path.join(final.libraryPath, result.item.skill))).map((result) => ({ name: result.item.skill, from: origin })),
        removed: results.filter((result) => result.status === "applied" && result.item.kind === "remove").map((result) => result.item.skill),
        now: now(),
      });
      // Applied items keep a record of every op so the whole run can be undone from history.
      const recordedItems = [];
      for (const result of results.filter((item) => item.status === "applied")) {
        const ops = (await Promise.all(result.item.ops.map((op) => recordOp(op, display)))).filter(Boolean);
        recordedItems.push({ id: result.item.id, title: result.item.title, kind: result.item.kind, skill: result.item.skill, ...(result.item.agentId ? { agents: [result.item.agentId] } : {}), ...(result.item.trashId ? { trashId: result.item.trashId } : {}), ops });
      }
      const record = recordedItems.length
        ? {
            id: randomUUID().replace(/-/gu, "").slice(0, 12),
            type: "library",
            action,
            origin,
            skillName: new Set(recordedItems.map((item) => item.skill)).size === 1 ? recordedItems[0].skill : null,
            applied: recordedItems.length,
            failed: results.filter((r) => r.status !== "applied").length,
            items: recordedItems,
            // Whether history can undo this run (same rule as the history list).
            restorable: recordedItems.some((item) => Boolean(item.trashId) || item.ops.some(isReversible)),
            createdAt: new Date(now()).toISOString(),
          }
        : null;
      if (record) {
        await mkdir(path.dirname(context.historyFile), { recursive: true });
        await appendFile(context.historyFile, `${JSON.stringify(record)}\n`, "utf8");
      }
      await context.onApplied?.({ action, origin, items: recordedItems, historyId: record?.id || null, skip: recordedItems.length ? skip : [] });
      return {
        results: results.map((result) => ({
          id: result.item.id,
          title: result.item.title,
          kind: result.item.kind,
          skill: result.item.skill,
          ...(result.item.agentId ? { agentId: result.item.agentId } : {}),
          status: result.status,
          ...(result.error ? { error: result.error } : {}),
          ...(result.item.trashId && result.status === "applied" ? { trashId: result.item.trashId } : {}),
        })),
        backups: display(path.join(context.backupDirectory, group)),
        visibility: Object.fromEntries(
          [...new Set(results.map((result) => result.item.skill).filter(Boolean))].map((name) => [name, final.library.entries.find((entry) => entry.name === name)?.fanout || null]),
        ),
        historyEntry: record,
      };
    }, { label: origin === "cli" ? "skill-control CLI" : "Skill Control" });
  }

  async function apply({ planId, confirm, origin = "app" }) {
    await homesReady;
    if (confirm !== true) throw new LibraryError(400, "需要明确确认后才能执行。", "confirm-required");
    const stored = plans.take(planId);
    const result = await runItems({ action: stored.action, items: stored.items, group: stored.group, origin, skip: stored.skip || [] });
    return { planId: stored.planId, ...result };
  }

  /** Auto-link: link / copy items for "missing" pairs, executed at once (no plan, no confirmation). */
  async function autoLink(pairs, { origin = "auto" } = {}) {
    await homesReady;
    const raw = await snapshot();
    const state = await prepareState(raw);
    const items = autoLinkItems(pairs, state);
    if (!items.length) return { results: [], historyEntry: null };
    return runItems({ action: "auto-link", items, group: `${timestamp(now())}-auto-link`, origin });
  }

  /** Puts a removed library entry back and recreates its links (see server/trash.mjs). */
  async function restore({ trashId }) {
    await homesReady;
    const state = await snapshot();
    const allowedRoots = [state.libraryPath, ...state.agents.flatMap((agent) => agent.ownDirs)];
    return restoreTrash({ trashId, stateDirectory: context.stateDirectory, homeDirectory: context.homeDirectory, allowedRoots, display, stamp: timestamp(now()) });
  }

  const listTrash = async () => {
    await homesReady;
    return listTrashEntries(context.stateDirectory, display);
  };

  return { plan, apply, autoLink, restore, listTrash, snapshot: async () => { await homesReady; return snapshot(); } };
}
