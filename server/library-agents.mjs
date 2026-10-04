import { realpath } from "node:fs/promises";
import path from "node:path";
import { object, readBoundedJson, readBoundedToml } from "./fs-safe.mjs";
import { hermesHomeFor, loadHermesHome } from "./hermes.mjs";
import { resolveOpenClawInstall } from "./openclaw.mjs";

/**
 * How each Agent sees the shared library (~/.agents/skills), per the verified matrix in
 * docs/LIBRARY-UPDATES-CLI.md §1.2: native readers need no links, Hermes reads extra
 * folders from config, the rest get one relative link per skill.
 */

export const AGENT_TIERS = {
  codex: { tier: "native", note: "原生读取库；不合并同名技能（自有目录里的同名副本会再出现一次），~/.codex/skills 已被官方标为过时", disable: "codex" },
  gemini: { tier: "native", note: "原生读取库", disable: "gemini" },
  cursor: { tier: "native", note: "原生读取库" },
  copilot: { tier: "native", note: "原生读取库" },
  opencode: { tier: "native", note: "原生读取库" },
  windsurf: { tier: "native", note: "原生读取库" },
  amp: { tier: "native", note: "原生读取库" },
  openclaw: { tier: "native", containment: true, note: "原生读取库；拒绝真实路径越出根目录的链接", disable: "openclaw" },
  qclaw: { tier: "native", containment: true, note: "原生读取库；拒绝真实路径越出根目录的链接", disable: "openclaw" },
  hermes: { tier: "config", note: "通过 skills.external_dirs 读取库；本地同名技能优先", disable: "hermes" },
  claude: { tier: "link", note: "逐技能相对链接" },
  kiro: { tier: "link", note: "逐技能相对链接" },
  codebuddy: { tier: "link", note: "逐技能相对链接" },
  workbuddy: { tier: "link", note: "逐技能相对链接" },
  trae: { tier: "link", note: "逐技能相对链接（全局目录）" },
};

export const tierOf = (agentId) => AGENT_TIERS[agentId]?.tier || "none";

const expand = (value, homeDirectory) =>
  value === "~" ? homeDirectory : typeof value === "string" && value.startsWith("~/") ? path.join(homeDirectory, value.slice(2)) : path.resolve(value);

/** Each Agent's own skill folders (configured paths minus the library itself). */
export async function agentOwnDirectories(agent, { homeDirectory, libraryPath }) {
  const realLibrary = await realpath(libraryPath).catch(() => libraryPath);
  const result = [];
  for (const raw of agent.paths || []) {
    const directory = expand(raw, homeDirectory);
    const real = await realpath(directory).catch(() => directory);
    if (real === realLibrary || directory === libraryPath) continue;
    result.push(directory);
  }
  return [...new Set(result)];
}

/** Per-Agent switches and settings that affect visibility. */
export async function readAgentSwitches(agentId, homeDirectory) {
  switch (agentId) {
    case "codex": {
      const config = await readBoundedToml(path.join(homeDirectory, ".codex", "config.toml"), 4_000_000);
      const entries = Array.isArray(object(object(config.value).skills).config) ? config.value.skills.config : [];
      return {
        disabled: new Set(entries.filter((entry) => object(entry).enabled === false && typeof entry.name === "string").map((entry) => entry.name.trim())),
        disabledPaths: new Set(entries.filter((entry) => object(entry).enabled === false && typeof entry.path === "string").map((entry) => path.resolve(expand(entry.path, homeDirectory)))),
        sandboxMode: typeof object(config.value).sandbox_mode === "string" ? config.value.sandbox_mode : null,
        networkAccess: object(object(config.value).sandbox_workspace_write).network_access === true,
      };
    }
    case "gemini": {
      const settings = await readBoundedJson(path.join(homeDirectory, ".gemini", "settings.json"), 2_000_000);
      const list = object(object(settings.value).skills).disabled;
      return { disabled: new Set(Array.isArray(list) ? list.filter((name) => typeof name === "string") : []) };
    }
    case "openclaw":
    case "qclaw": {
      const install = await resolveOpenClawInstall(agentId, homeDirectory);
      const entries = object(object(install.config.skills).entries);
      return {
        available: install.available,
        stateDir: install.stateDir,
        disabled: new Set(Object.entries(entries).filter(([, entry]) => object(entry).enabled === false).map(([name]) => name)),
      };
    }
    case "hermes": {
      const state = await loadHermesHome(hermesHomeFor(homeDirectory), { homeDirectory });
      return {
        available: state.available,
        skillsDir: state.skillsDir,
        externalDirs: state.externalDirs,
        disabled: state.disabled,
      };
    }
    default:
      return { disabled: new Set() };
  }
}
