import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { classifyPath } from "./fs-links.mjs";
import { object } from "./fs-safe.mjs";
import { resolveOpenClawInstall } from "./openclaw.mjs";

/**
 * Per-Agent "disable this skill" switches (docs §1.5). Config edits are reversible write
 * ops with a backup and a diff; files that cannot be edited without losing comments get
 * instructions instead; Hermes goes through its own CLI.
 */

const readText = (file) => readFile(file, "utf8").catch(() => null);
const tomlString = (value) => JSON.stringify(String(value));

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
      const text = (await readText(file)) || "";
      let parsed = {};
      try {
        parsed = parseToml(text);
      } catch {
        return instructions(agent, skill, "config.toml 无法解析，请手动添加 [[skills.config]] name / enabled = false。");
      }
      const entries = Array.isArray(object(parsed.skills).config) ? parsed.skills.config : [];
      if (entries.some((entry) => entry?.name === skill && entry.enabled === false)) return null;
      const block = `\n[[skills.config]]\nname = ${tomlString(skill)}\nenabled = false\n`;
      return item([{ op: "write", path: file, content: `${text.replace(/\n*$/u, "\n")}${block}`, backup: path.join(group, "config", "codex-config.toml"), diff: block.trim().split("\n").map((line) => `+ ${line}`).join("\n") }], `在 config.toml 中停用 ${skill}`);
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
