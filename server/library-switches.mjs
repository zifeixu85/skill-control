import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { classifyPath } from "./fs-links.mjs";
import { object } from "./fs-safe.mjs";
import { resolveRaccoonInstall } from "./office-raccoon.mjs";
import { resolveOpenClawInstall } from "./openclaw.mjs";

/**
 * Per-Agent "disable this skill" switches (docs §1.5). Config edits are reversible write
 * ops with a backup and a diff; files that cannot be edited without losing comments get
 * instructions instead; Hermes goes through its own CLI.
 */

const readText = (file) => readFile(file, "utf8").catch(() => null);
const tomlString = (value) => JSON.stringify(String(value));
/** What a write op checks before it runs (null: the file must still be missing). */
const textHash = (text) => (text === null ? null : createHash("sha256").update(text).digest("hex"));

function jsonEdit(file, text, mutate, group, label) {
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
  const before = JSON.stringify(value);
  const added = mutate(value);
  if (!added || JSON.stringify(value) === before) return { noop: true };
  return {
    op: "write",
    path: file,
    content: `${JSON.stringify(value, null, 2)}\n`,
    ifUnchanged: textHash(text),
    backup: path.join(group, "config", label),
    diff: `+ ${added}`,
  };
}

const instructions = (agent, skill, text) => ({
  id: `disable:${agent.agentId}:${skill}`,
  title: `${agent.name}：${text}`,
  kind: "instructions",
  skill,
  agentId: agent.agentId,
  choice: "skip",
  ops: [],
  expect: [],
});

export async function disableOps(agent, skill, context) {
  const id = `disable:${agent.agentId}:${skill}`;
  const group = path.join(context.backupDirectory, context.group);
  const item = (ops, title) => ({ id, title: `${agent.name}：${title}`, kind: "disable", skill, agentId: agent.agentId, choices: ["disable", "skip"], choice: "disable", ops, expect: [] });
  switch (agent.agentId) {
    case "codex": {
      const file = path.join(context.homeDirectory, ".codex", "config.toml");
      const raw = await readText(file);
      const text = raw || "";
      let parsed = {};
      try {
        parsed = parseToml(text);
      } catch {
        return instructions(agent, skill, "config.toml 无法解析，请手动添加 [[skills.config]] name / enabled = false。");
      }
      const entries = Array.isArray(object(parsed.skills).config) ? parsed.skills.config : [];
      if (entries.some((entry) => entry?.name === skill && entry.enabled === false)) return null;
      const block = `\n[[skills.config]]\nname = ${tomlString(skill)}\nenabled = false\n`;
      return item([{ op: "write", path: file, content: `${text.replace(/\n*$/u, "\n")}${block}`, ifUnchanged: textHash(raw), backup: path.join(group, "config", "codex-config.toml"), diff: block.trim().split("\n").map((line) => `+ ${line}`).join("\n") }], `在 config.toml 中停用 ${skill}`);
    }
    case "gemini": {
      const file = path.join(context.homeDirectory, ".gemini", "settings.json");
      const op = jsonEdit(file, await readText(file), (value) => {
        value.skills = object(value.skills);
        const list = Array.isArray(value.skills.disabled) ? value.skills.disabled : [];
        if (list.includes(skill)) return null;
        value.skills.disabled = [...list, skill];
        return `skills.disabled: "${skill}"`;
      }, group, "gemini-settings.json");
      if (!op) return instructions(agent, skill, "settings.json 无法解析，请在 skills.disabled 中手动添加。");
      return op.noop ? null : item([op], `在 settings.json 中停用 ${skill}`);
    }
    case "openclaw":
    case "qclaw": {
      const install = await resolveOpenClawInstall(agent.agentId, context.homeDirectory);
      if (!install.configPath) return null;
      const op = jsonEdit(install.configPath, await readText(install.configPath), (value) => {
        value.skills = object(value.skills);
        value.skills.entries = object(value.skills.entries);
        if (object(value.skills.entries[skill]).enabled === false) return null;
        value.skills.entries[skill] = { ...object(value.skills.entries[skill]), enabled: false };
        return `skills.entries.${skill}.enabled = false`;
      }, group, `${agent.agentId}-openclaw.json`);
      // JSON5 with comments cannot be rewritten without losing them.
      if (!op) return instructions(agent, skill, `配置文件含注释，未自动修改；请把 skills.entries.${skill}.enabled 设为 false。`);
      return op.noop ? null : item([op], `在 openclaw.json 中停用 ${skill}`);
    }
    case "office-raccoon": {
      // The app keeps its switches in config/skill-settings.json { disabledSkillNames }.
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(skill)) return instructions(agent, skill, "技能名称不符合办公小浣熊的命名规则，请在应用里停用。");
      const install = await resolveRaccoonInstall(context.homeDirectory);
      const file = path.join(install.configDir, "skill-settings.json");
      const op = jsonEdit(file, await readText(file), (value) => {
        const list = Array.isArray(value.disabledSkillNames) ? value.disabledSkillNames : [];
        if (list.includes(skill)) return null;
        value.disabledSkillNames = [...list, skill].sort((left, right) => left.localeCompare(right));
        return `disabledSkillNames: "${skill}"`;
      }, group, "office-raccoon-skill-settings.json");
      if (!op) return instructions(agent, skill, "skill-settings.json 无法解析，请在应用的技能设置里停用。");
      return op.noop ? null : item([op], `在 skill-settings.json 中停用 ${skill}`);
    }
    case "hermes": {
      const hermes = await context.findCommand("hermes");
      const current = [...(await context.hermesDisabled())];
      if (current.includes(skill)) return null;
      const next = JSON.stringify([...current, skill]);
      return hermes
        ? item(context.hermesCommandOps(hermes, ["config", "set", "skills.disabled", next]), `用 hermes config set 停用 ${skill}`)
        : instructions(agent, skill, `请运行 hermes config set skills.disabled '${next}'。`);
    }
    default: {
      const location = agent.ownDirs[0] ? path.join(agent.ownDirs[0], skill) : null;
      if (location && context.libraryEntry && (await classifyPath(location, context.libraryEntry.path)).kind === "link-to-library") {
        return item([{ op: "unlink", path: location }], `移除 ${skill} 的链接`);
      }
      return agent.tier === "native" ? instructions(agent, skill, "这个 Agent 原生读取库，没有已核实的停用开关；可从库中移除，或在 Agent 内停用。") : null;
    }
  }
}

/** Agents with a verified per-skill switch (pause uses it instead of touching files). */
export const SWITCH_AGENTS = new Set(["codex", "gemini", "openclaw", "qclaw", "office-raccoon", "hermes"]);

const isTableHeader = (line) => /^\s*\[/u.test(line);
const isSkillsConfigHeader = (line) => /^\s*\[\[\s*skills\s*\.\s*config\s*\]\]\s*(#.*)?$/u.test(line);
const isTrivia = (line) => /^\s*(#.*)?$/u.test(line);
/** JSON with sorted keys, so two parses compare equal whatever order their tables come in. */
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" && !(value instanceof Date)
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
      : JSON.stringify(value);

/**
 * config.toml without the `[[skills.config]]` tables that switch `skill` off by name. Only
 * those lines go; comments and blank lines before the next table stay with it. Returns null
 * when nothing matches or the result does not parse to the same config minus those tables.
 */
export function removeCodexSwitch(text, skill) {
  const lines = text.split("\n");
  const ranges = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (!isSkillsConfigHeader(lines[start])) continue;
    let end = start + 1;
    while (end < lines.length && !isTableHeader(lines[end])) end += 1;
    while (end > start + 1 && isTrivia(lines[end - 1])) end -= 1;
    let table;
    try {
      table = parseToml(lines.slice(start, end).join("\n")).skills?.config?.[0];
    } catch {
      return null;
    }
    if (table?.name === skill && table.enabled === false && Object.keys(table).length === 2) {
      // The blank line written in front of the table goes with it.
      ranges.push([start > 0 && lines[start - 1].trim() === "" ? start - 1 : start, end]);
    }
    start = end - 1;
  }
  if (!ranges.length) return null;
  const drop = new Set(ranges.flatMap(([from, to]) => Array.from({ length: to - from }, (_, index) => from + index)));
  const next = lines.filter((_, index) => !drop.has(index)).join("\n");
  try {
    const before = parseToml(text);
    const after = parseToml(next);
    const kept = (before.skills.config || []).filter((entry) => !(entry?.name === skill && entry.enabled === false && Object.keys(entry).length === 2));
    const expected = { ...before, skills: { ...before.skills, config: kept } };
    if (!kept.length) delete expected.skills.config;
    if (!Object.keys(expected.skills).length) delete expected.skills;
    if (canonical(after) !== canonical(expected)) return null;
  } catch {
    return null;
  }
  return next;
}

/**
 * The reverse of `disableOps` for one Agent's own switch, computed from the file as it is now
 * (Agents rewrite their configs, so a pause is never undone by putting an old backup back).
 * Returns a "resume" item, instructions, or null when the switch is already on.
 */
export async function enableOps(agent, skill, context) {
  const id = `resume:${agent.agentId}:${skill}`;
  const group = path.join(context.backupDirectory, context.group);
  const item = (ops, title) => ({ id, title: `${agent.name}：${title}`, kind: "resume", skill, agentId: agent.agentId, choices: ["resume", "skip"], choice: "resume", ops, expect: [] });
  const manual = (text) => ({ ...instructions(agent, skill, text), id });
  switch (agent.agentId) {
    case "codex": {
      const file = path.join(context.homeDirectory, ".codex", "config.toml");
      const text = await readText(file);
      if (text === null) return null;
      let entries = [];
      try {
        entries = Array.isArray(object(parseToml(text).skills).config) ? parseToml(text).skills.config : [];
      } catch {
        return manual("config.toml 无法解析，请手动删掉停用它的 [[skills.config]]。");
      }
      if (!entries.some((entry) => entry?.name === skill && entry.enabled === false)) return null;
      const next = removeCodexSwitch(text, skill);
      if (next === null) return manual(`config.toml 里停用 ${skill} 的那段还有别的设置，没有自动改；请手动删掉或改成 enabled = true。`);
      return item([{ op: "write", path: file, content: next, ifUnchanged: textHash(text), backup: path.join(group, "config", "codex-config.toml"), diff: `- [[skills.config]]\n- name = ${tomlString(skill)}\n- enabled = false` }], `删掉 config.toml 里停用 ${skill} 的设置`);
    }
    case "gemini": {
      const file = path.join(context.homeDirectory, ".gemini", "settings.json");
      const op = jsonEdit(file, await readText(file), (value) => {
        const list = object(value.skills).disabled;
        if (!Array.isArray(list) || !list.includes(skill)) return null;
        value.skills = { ...value.skills, disabled: list.filter((name) => name !== skill) };
        return `skills.disabled: "${skill}"`;
      }, group, "gemini-settings.json");
      if (!op) return manual("settings.json 无法解析，请在 skills.disabled 中手动去掉。");
      return op.noop ? null : item([{ ...op, diff: `- ${op.diff.slice(2)}` }], `在 settings.json 中重新启用 ${skill}`);
    }
    case "openclaw":
    case "qclaw": {
      const install = await resolveOpenClawInstall(agent.agentId, context.homeDirectory);
      if (!install.configPath) return null;
      const op = jsonEdit(install.configPath, await readText(install.configPath), (value) => {
        const entry = object(object(object(value.skills).entries)[skill]);
        if (entry.enabled !== false) return null;
        const rest = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "enabled"));
        const entries = { ...value.skills.entries };
        if (Object.keys(rest).length) entries[skill] = rest;
        else delete entries[skill];
        value.skills = { ...value.skills, entries };
        return `skills.entries.${skill}.enabled = false`;
      }, group, `${agent.agentId}-openclaw.json`);
      if (!op) return manual(`配置文件含注释，未自动修改；请把 skills.entries.${skill}.enabled 改回 true。`);
      return op.noop ? null : item([{ ...op, diff: `- ${op.diff.slice(2)}` }], `在 openclaw.json 中重新启用 ${skill}`);
    }
    case "office-raccoon": {
      const install = await resolveRaccoonInstall(context.homeDirectory);
      const file = path.join(install.configDir, "skill-settings.json");
      const op = jsonEdit(file, await readText(file), (value) => {
        const list = value.disabledSkillNames;
        if (!Array.isArray(list) || !list.includes(skill)) return null;
        value.disabledSkillNames = list.filter((name) => name !== skill);
        return `disabledSkillNames: "${skill}"`;
      }, group, "office-raccoon-skill-settings.json");
      if (!op) return manual("skill-settings.json 无法解析，请在应用的技能设置里重新启用。");
      return op.noop ? null : item([{ ...op, diff: `- ${op.diff.slice(2)}` }], `在 skill-settings.json 中重新启用 ${skill}`);
    }
    case "hermes": {
      const current = [...(await context.hermesDisabled())];
      if (!current.includes(skill)) return null;
      const next = JSON.stringify(current.filter((name) => name !== skill));
      const hermes = await context.findCommand("hermes");
      return hermes
        ? item(context.hermesCommandOps(hermes, ["config", "set", "skills.disabled", next]), `用 hermes config set 重新启用 ${skill}`)
        : manual(`请运行 hermes config set skills.disabled '${next}'。`);
    }
    default:
      return null;
  }
}
