import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { unzipSync, zipSync } from "fflate";
import { scanSmartOrder, scanSmartOrderConnectors } from "./smartorder.mjs";

const HOME_DIRECTORY = homedir();
const STATE_DIRECTORY = path.join(HOME_DIRECTORY, ".agent-skill-manager");
const CONFIG_FILE = path.join(STATE_DIRECTORY, "config.json");
const HISTORY_FILE = path.join(STATE_DIRECTORY, "history.jsonl");
const BACKUP_DIRECTORY = path.join(STATE_DIRECTORY, "backups");
const IMPORT_DIRECTORY = path.join(STATE_DIRECTORY, "imports");
const WORKBUDDY_EXPERTS_RELATIVE_PATH = path.join(
  ".workbuddy",
  "plugins",
  "marketplaces",
  "experts",
  "plugins",
);
const WORKBUDDY_EXPERT_MANIFEST_RELATIVE_PATH = path.join(
  ".workbuddy",
  "app",
  "cache",
  "experts",
  "manifest.json",
);
const HERMES_HOME_RELATIVE_PATH = ".hermes";
const FINGERPRINT_CACHE_FILE = path.join(
  STATE_DIRECTORY,
  "fingerprint-cache.json",
);
const SERVER_PORT = Number(process.env.SKILL_MANAGER_PORT || 43110);
const SERVER_HOST = process.env.SKILL_MANAGER_HOST || "127.0.0.1";
const SCAN_CACHE_TTL = 5 * 60_000;
const CAPABILITY_CACHE_TTL = 2 * 60_000;
const FINGERPRINT_CACHE_LIMIT = 4_000;
const SKILL_ENTRY_LIMIT = 1_500;
const SKILL_CONTENT_LIMIT = 2_000_000;
const SKILL_IMAGE_PREVIEW_LIMIT = 20_000_000;
const SKILL_ARCHIVE_LIMIT = 25_000_000;
const SKILL_UNPACKED_LIMIT = 100_000_000;
const ALLOWED_ORIGINS = new Set(
  (process.env.SKILL_MANAGER_ORIGINS ||
    "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const IGNORED_DIRECTORIES = new Set([
  ".backup",
  ".backups",
  ".git",
  ".svn",
  ".cache",
  ".DS_Store",
  ".mypy_cache",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "node_modules",
  "venv",
  "__pycache__",
]);

const IMAGE_MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const AGENT_CATALOG = [
  {
    id: "codex",
    name: "Codex",
    shortName: "CX",
    color: "#8fc9ef",
    paths: [
      "~/.codex/skills",
      "~/.agents/skills",
      "~/.codex/vendor_imports/skills",
    ],
  },
  {
    id: "claude",
    name: "Claude Code",
    shortName: "CC",
    color: "#c7b7ef",
    paths: ["~/.claude/skills"],
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    shortName: "WB",
    color: "#78d4c7",
    paths: ["~/.workbuddy/skills", "~/.workbuddy/connectors/skills"],
  },
  {
    id: "cursor",
    name: "Cursor",
    shortName: "CR",
    color: "#8fd0ae",
    paths: ["~/.cursor/skills"],
  },
  {
    id: "smartorder",
    name: "订单来了",
    shortName: "订",
    color: "#9abbd6",
    paths: ["~/.smartorder/skills"],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    shortName: "GM",
    color: "#9ebbf4",
    paths: ["~/.gemini/skills"],
  },
  {
    id: "kiro",
    name: "Kiro",
    shortName: "KI",
    color: "#d0afe8",
    paths: ["~/.kiro/skills"],
  },
  {
    id: "trae",
    name: "Trae",
    shortName: "TR",
    color: "#7bcbd5",
    paths: ["~/.trae/skills"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    shortName: "OC",
    color: "#d8d6ce",
    paths: ["~/.config/opencode/skills", "~/.opencode/skills"],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    shortName: "WS",
    color: "#70cfa5",
    paths: ["~/.windsurf/skills"],
  },
  {
    id: "cline",
    name: "Cline",
    shortName: "CL",
    color: "#d8c08a",
    paths: ["~/.cline/skills"],
  },
  {
    id: "roo-code",
    name: "Roo Code",
    shortName: "RO",
    color: "#d1afd7",
    paths: ["~/.roo/skills", "~/.roo-code/skills"],
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    shortName: "CB",
    color: "#bfd49b",
    paths: ["~/.codebuddy/skills"],
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    shortName: "QW",
    color: "#a995df",
    paths: ["~/.qwen/skills", "~/.qwen-code/skills"],
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    shortName: "GH",
    color: "#aeb7d4",
    paths: ["~/.copilot/skills", "~/.github/copilot/skills"],
  },
];

const LEGACY_AGENT_COLORS = new Map([
  ["codex", "#d7f56d"],
  ["claude", "#ff7a4d"],
  ["workbuddy", "#74c7ec"],
  ["cursor", "#65d6b4"],
  ["gemini", "#8ab4f8"],
  ["kiro", "#c6a5f7"],
  ["trae", "#54d8d0"],
  ["opencode", "#d8d6ce"],
  ["windsurf", "#47d7a2"],
  ["cline", "#f2a94f"],
  ["roo-code", "#ff8a72"],
  ["codebuddy", "#f0ce5a"],
  ["qwen-code", "#a98cf3"],
  ["copilot", "#b1a3d8"],
]);

const AGENT_FALLBACK_COLORS = [
  "#8fc9ef",
  "#c7b7ef",
  "#78d4c7",
  "#aeb7d4",
];

const DEFAULT_CONFIG = {
  version: 3,
  syncMode: "copy",
  agents: AGENT_CATALOG.slice(0, 3),
  visibleAgentIds: ["codex", "claude"],
  dismissedAgentIds: [],
};

let cachedScan = null;
let cachedScanAt = 0;
let cachedCapabilityProducts = null;
let cachedCapabilityProductsAt = 0;
let pendingScan = null;
let scanGeneration = 0;
let fingerprintCacheLoaded = false;
let fingerprintCacheDirty = false;
let fingerprintCacheLoadPromise = null;
const fingerprintCache = new Map();
const importedSkills = new Map();

function expandHome(inputPath) {
  if (inputPath === "~") return HOME_DIRECTORY;
  if (inputPath.startsWith("~/")) {
    return path.join(HOME_DIRECTORY, inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

function compactHome(inputPath) {
  if (inputPath === HOME_DIRECTORY) return "~";
  if (inputPath.startsWith(`${HOME_DIRECTORY}${path.sep}`)) {
    return `~/${inputPath.slice(HOME_DIRECTORY.length + 1)}`;
  }
  return inputPath;
}

function invalidateScanCache() {
  cachedScan = null;
  cachedScanAt = 0;
  scanGeneration += 1;
}

function stripYamlValue(value = "") {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readYamlScalar(block, key) {
  const lines = block.split("\n");
  const keyPattern = new RegExp(`^${key}:\\s*(.*)$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(keyPattern);
    if (!match) continue;
    const value = match[1].trim();
    if (!/^[>|][+-]?$/.test(value)) return stripYamlValue(value);
    const collected = [];
    for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (line && !/^\s/.test(line)) break;
      collected.push(line.replace(/^\s{1,4}/, ""));
    }
    const separator = value.startsWith(">") ? " " : "\n";
    return collected.join(separator).replace(/\s+/g, " ").trim();
  }
  return "";
}

function containsChinese(value = "") {
  return /[\u3400-\u9fff]/u.test(value);
}

function cleanMarkdownText(value = "") {
  return value
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~>#|]/g, "")
    .replace(/^\s*[-+\d.)]+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstChineseScalar(block, keys) {
  for (const key of keys) {
    const value = readYamlScalar(block, key);
    if (containsChinese(value)) return value;
  }
  return "";
}

function findChineseHeading(body) {
  const headings = body.match(/^#\s+(.+)$/gm) || [];
  for (const heading of headings) {
    const value = cleanMarkdownText(heading.replace(/^#\s+/, ""));
    if (containsChinese(value) && value.length <= 64) return value;
  }
  return "";
}

function findChineseIntroduction(body, displayName) {
  const withoutCode = body.replace(/```[\s\S]*?```/g, "");
  const blocks = withoutCode.split(/\n\s*\n/);
  for (const block of blocks) {
    if (/^\s*#/m.test(block)) continue;
    const value = cleanMarkdownText(block);
    const chineseCount = (value.match(/[\u3400-\u9fff]/gu) || []).length;
    if (
      chineseCount >= 5 &&
      value !== displayName &&
      value.length >= 12 &&
      value.length <= 320
    ) {
      return value;
    }
  }
  return "";
}

export function parseFrontmatter(source, fallbackName) {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const block = match?.[1] ?? "";
  const body = match ? normalized.slice(match[0].length).trim() : normalized.trim();
  const tagsMatch = block.match(/^tags:\s*\[([^\]]*)\]/m);
  const name = readYamlScalar(block, "name") || fallbackName;
  const localizedName = firstChineseScalar(block, [
    "name_zh",
    "name_cn",
    "display_name_zh",
    "displayNameZh",
    "title_zh",
    "display_name",
    "title",
    "中文名称",
  ]);
  const displayName =
    (containsChinese(name) && name) ||
    localizedName ||
    findChineseHeading(body) ||
    name;
  const rawDescription = readYamlScalar(block, "description");
  const localizedDescription = firstChineseScalar(block, [
    "description_zh",
    "description_cn",
    "summary_zh",
    "intro_zh",
    "中文描述",
    "中文介绍",
  ]);
  const description =
    localizedDescription ||
    (containsChinese(rawDescription) && rawDescription) ||
    findChineseIntroduction(body, displayName) ||
    rawDescription ||
    body
      .replace(/^#+\s+/gm, "")
      .replace(/\s+/g, " ")
      .slice(0, 180) ||
    "暂无描述";
  const tags = tagsMatch
    ? tagsMatch[1]
        .split(",")
        .map(stripYamlValue)
        .filter(Boolean)
        .slice(0, 6)
    : [];

  return { name, displayName, description, tags, body };
}

function localizedText(value, fallback = "") {
  if (typeof value === "string") return value.trim() || fallback;
  if (!value || typeof value !== "object") return fallback;
  return String(
    value.zh ||
      value["zh-CN"] ||
      value.zh_CN ||
      value.en ||
      Object.values(value).find((item) => typeof item === "string") ||
      fallback,
  ).trim();
}

function frontmatterBlock(source) {
  return (
    source
      .replace(/\r\n/g, "\n")
      .match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1] || ""
  );
}

function readNestedYamlScalar(block, parentKey, childKey) {
  const escapedParent = parentKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedChild = childKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parentMatch = block.match(
    new RegExp(
      `^${escapedParent}:\\s*\\n((?:[ \\t]+[^\\n]*(?:\\n|$))*)`,
      "m",
    ),
  );
  if (!parentMatch) return "";
  const childMatch = parentMatch[1].match(
    new RegExp(`^[ \\t]+${escapedChild}:\\s*(.+)$`, "m"),
  );
  return childMatch ? stripYamlValue(childMatch[1]) : "";
}

function parseSimpleYamlSection(source, sectionName, allowedKeys) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const sectionIndex = lines.findIndex(
    (line) => line.trimEnd() === `${sectionName}:`,
  );
  if (sectionIndex < 0) return {};
  const result = {};
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[^\s#][^:]*:/u.test(line)) break;
    const match = line.match(/^\s{2}([a-zA-Z0-9_-]+):\s*(.*?)\s*$/u);
    if (!match || !allowedKeys.includes(match[1]) || !match[2]) continue;
    const rawValue = stripYamlValue(match[2]);
    if (/^(true|false)$/i.test(rawValue)) {
      result[match[1]] = rawValue.toLowerCase() === "true";
    } else if (/^-?\d+(?:\.\d+)?$/u.test(rawValue)) {
      result[match[1]] = Number(rawValue);
    } else {
      result[match[1]] = rawValue;
    }
  }
  return result;
}

function capabilityId(productId, sourcePath) {
  return createHash("sha256")
    .update(`${productId}:${sourcePath}`)
    .digest("hex")
    .slice(0, 20);
}

function publicCapability(capability) {
  const publicValue = { ...capability };
  delete publicValue.rootPath;
  delete publicValue.virtualFiles;
  delete publicValue.allowedFiles;
  return publicValue;
}

async function parseWorkBuddyExpertMember(pluginPath, relativePath) {
  const normalizedPath = String(relativePath || "")
    .replace(/^\.\//u, "")
    .split(path.sep)
    .join("/");
  const extension = path.extname(normalizedPath).toLowerCase();
  if (
    !normalizedPath ||
    ![".md", ".markdown"].includes(extension) ||
    isSensitiveCapabilityPath(normalizedPath)
  ) {
    return null;
  }
  try {
    const { resolvedFile, fileStats } = await resolveSkillFile(
      pluginPath,
      normalizedPath,
    );
    if (fileStats.size > SKILL_CONTENT_LIMIT) return null;
    const source = await readFile(resolvedFile, "utf8");
    const parsed = parseFrontmatter(
      source,
      path.basename(normalizedPath, ".md"),
    );
    const block = frontmatterBlock(source);
    const displayName =
      readNestedYamlScalar(block, "displayName", "zh") ||
      readNestedYamlScalar(block, "displayName", "en") ||
      parsed.displayName;
    const profession =
      readNestedYamlScalar(block, "profession", "zh") ||
      readNestedYamlScalar(block, "profession", "en") ||
      "";
    const maxTurns = Number(readYamlScalar(block, "maxTurns")) || null;
    return {
      id: createHash("sha256").update(resolvedFile).digest("hex").slice(0, 16),
      name: parsed.name,
      displayName,
      profession,
      description: parsed.description,
      maxTurns,
      filePath: normalizedPath,
    };
  } catch {
    return null;
  }
}

export async function scanWorkBuddyExperts(homeDirectory = HOME_DIRECTORY) {
  const expertsRoot = path.join(homeDirectory, WORKBUDDY_EXPERTS_RELATIVE_PATH);
  if (!(await pathExists(expertsRoot))) {
    return {
      id: "workbuddy",
      name: "WorkBuddy",
      shortName: "WB",
      color: "#78d4c7",
      kindLabel: "专家 / 专家团",
      sourcePath: compactHome(expertsRoot),
      available: false,
      catalogCount: 0,
      itemCount: 0,
      memberCount: 0,
      items: [],
    };
  }

  let catalogCount = 0;
  const catalogManifest = await readJsonFile(
    path.join(homeDirectory, WORKBUDDY_EXPERT_MANIFEST_RELATIVE_PATH),
    null,
  );
  if (Array.isArray(catalogManifest?.experts)) {
    catalogCount = catalogManifest.experts.length;
  }

  const pluginEntries = (await readdir(expertsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  const items = [];

  for (const pluginEntry of pluginEntries) {
    const pluginPath = path.join(expertsRoot, pluginEntry.name);
    const pluginConfig = await readJsonFile(
      path.join(pluginPath, ".codebuddy-plugin", "plugin.json"),
      null,
    );
    if (!pluginConfig) continue;
    const configuredAgentPaths = Array.isArray(pluginConfig.agents)
      ? pluginConfig.agents
      : [];
    const members = (
      await Promise.all(
        configuredAgentPaths.map((agentPath) =>
          parseWorkBuddyExpertMember(pluginPath, agentPath),
        ),
      )
    ).filter(Boolean);
    const listing = await listSkillFiles(pluginPath);
    const modifiedAt = (
      await stat(
        path.join(pluginPath, ".codebuddy-plugin", "plugin.json"),
      )
    ).mtime.toISOString();
    const isTeam =
      pluginConfig.expertType === "team" ||
      members.length > 1 ||
      Array.isArray(pluginConfig.members);
    const fallbackName = pluginConfig.name || pluginEntry.name;
    const displayName =
      localizedText(pluginConfig.displayName, fallbackName) || fallbackName;
    const description =
      localizedText(
        pluginConfig.displayDescription,
        pluginConfig.description || "",
      ) || "暂无专家说明";
    const primaryFilePath =
      members[0]?.filePath ||
      (listing.entries.some(
        (entry) => entry.type === "file" && entry.path === "README.md",
      )
        ? "README.md"
        : ".codebuddy-plugin/plugin.json");
    items.push({
      id: capabilityId("workbuddy", pluginPath),
      productId: "workbuddy",
      productName: "WorkBuddy",
      productShortName: "WB",
      productColor: "#78d4c7",
      kind: isTeam ? "expert-team" : "expert",
      kindLabel: isTeam ? "专家团" : "专家",
      name: fallbackName,
      displayName,
      description,
      profession: localizedText(pluginConfig.profession),
      version: String(pluginConfig.version || ""),
      tags: (Array.isArray(pluginConfig.tags) ? pluginConfig.tags : [])
        .map((tag) => localizedText(tag))
        .filter(Boolean)
        .slice(0, 8),
      members,
      memberCount: members.length,
      fileCount: listing.fileCount,
      connectorCount: Array.isArray(pluginConfig.connectorIds)
        ? pluginConfig.connectorIds.length
        : 0,
      skillCount: Array.isArray(pluginConfig.skills)
        ? pluginConfig.skills.length
        : 0,
      model: "",
      sourcePath: compactHome(pluginPath),
      primaryFilePath,
      modifiedAt,
      rootPath: pluginPath,
      allowedFiles: null,
      virtualFiles: new Map(),
    });
  }

  return {
    id: "workbuddy",
    name: "WorkBuddy",
    shortName: "WB",
    color: "#78d4c7",
    kindLabel: "专家 / 专家团",
    sourcePath: compactHome(expertsRoot),
    available: true,
    catalogCount,
    itemCount: items.length,
    memberCount: items.reduce((sum, item) => sum + item.memberCount, 0),
    items,
  };
}

function safeHermesConfiguration(source, profileRoot) {
  const sectionKeys = {
    model: ["provider", "default"],
    agent: [
      "max_turns",
      "reasoning_effort",
      "tool_use_enforcement",
      "disabled_toolsets",
    ],
    delegation: [
      "model",
      "provider",
      "reasoning_effort",
      "max_iterations",
      "child_timeout_seconds",
      "max_concurrent_children",
      "max_spawn_depth",
      "orchestrator_enabled",
      "subagent_auto_approve",
      "inherit_mcp_toolsets",
    ],
    display: ["personality", "language", "interface"],
    terminal: ["backend", "cwd", "timeout", "working_dir"],
    skills: ["external_dirs", "guard_agent_created"],
    kanban: [
      "auto_decompose",
      "default_assignee",
      "orchestrator_profile",
      "max_in_progress_per_profile",
    ],
  };
  const summary = {
    note: "仅展示非敏感配置；API Key、Token、认证与会话数据已省略。",
    profilePath: compactHome(profileRoot),
  };
  for (const [sectionName, allowedKeys] of Object.entries(sectionKeys)) {
    const values = parseSimpleYamlSection(source, sectionName, allowedKeys);
    for (const pathKey of ["cwd", "working_dir"]) {
      if (typeof values[pathKey] === "string" && path.isAbsolute(values[pathKey])) {
        values[pathKey] = compactHome(values[pathKey]);
      }
    }
    if (Object.keys(values).length) summary[sectionName] = values;
  }
  return summary;
}

async function countDirectSkillDirectories(rootPath) {
  if (!(await pathExists(rootPath))) return 0;
  const entries = await readdir(rootPath, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (await pathExists(path.join(rootPath, entry.name, "SKILL.md"))) count += 1;
  }
  return count;
}

async function createHermesProfileCapability(profileRoot, profileName, isDefault) {
  const configPath = path.join(profileRoot, "config.yaml");
  const soulPath = path.join(profileRoot, "SOUL.md");
  const profileMetadataPath = path.join(profileRoot, "profile.yaml");
  const configSource = (await pathExists(configPath))
    ? await readFile(configPath, "utf8")
    : "";
  const soulSource = (await pathExists(soulPath))
    ? await readFile(soulPath, "utf8")
    : "";
  const metadataSource = (await pathExists(profileMetadataPath))
    ? await readFile(profileMetadataPath, "utf8")
    : "";
  const safeConfig = safeHermesConfiguration(configSource, profileRoot);
  const modelConfig = safeConfig.model || {};
  const agentConfig = safeConfig.agent || {};
  const delegationConfig = safeConfig.delegation || {};
  const profileDescription =
    readYamlScalar(frontmatterBlock(metadataSource) || metadataSource, "description") ||
    cleanMarkdownText(soulSource).slice(0, 220) ||
    "使用 Hermes Profile、SOUL.md 与委派设置定义的本地 Agent。";
  const displayName =
    readYamlScalar(frontmatterBlock(metadataSource) || metadataSource, "displayName") ||
    readYamlScalar(frontmatterBlock(metadataSource) || metadataSource, "name") ||
    (isDefault ? "Hermes 默认 Agent" : profileName);
  const virtualPath = "配置摘要.json";
  const virtualFiles = new Map([
    [
      virtualPath,
      `${JSON.stringify(safeConfig, null, 2)}\n`,
    ],
  ]);
  const allowedFiles = new Set();
  for (const fileName of ["SOUL.md", "profile.yaml", "AGENTS.md"]) {
    if (await pathExists(path.join(profileRoot, fileName))) {
      allowedFiles.add(fileName);
    }
  }
  const primaryFilePath = allowedFiles.has("SOUL.md")
    ? "SOUL.md"
    : virtualPath;
  const referenceStats = await stat(
    (await pathExists(configPath)) ? configPath : profileRoot,
  );
  return {
    id: capabilityId("hermes", profileRoot),
    productId: "hermes",
    productName: "Hermes Agent",
    productShortName: "HM",
    productColor: "#e4b86a",
    kind: "agent-profile",
    kindLabel: isDefault ? "默认 Agent" : "Agent Profile",
    name: profileName,
    displayName,
    description: profileDescription,
    profession: "",
    version: "",
    tags: [
      "SOUL.md",
      delegationConfig.orchestrator_enabled ? "可委派" : "",
    ].filter(Boolean),
    members: [],
    memberCount: 0,
    fileCount: allowedFiles.size + virtualFiles.size,
    connectorCount: 0,
    skillCount: await countDirectSkillDirectories(
      path.join(profileRoot, "skills"),
    ),
    model: [modelConfig.provider, modelConfig.default]
      .filter(Boolean)
      .join(" / "),
    maxTurns: agentConfig.max_turns || null,
    delegation: {
      enabled: Boolean(delegationConfig.orchestrator_enabled),
      maxConcurrentChildren:
        Number(delegationConfig.max_concurrent_children) || null,
      maxSpawnDepth: Number(delegationConfig.max_spawn_depth) || null,
    },
    sourcePath: compactHome(profileRoot),
    primaryFilePath,
    modifiedAt: referenceStats.mtime.toISOString(),
    rootPath: profileRoot,
    allowedFiles,
    virtualFiles,
  };
}

export async function scanHermesProfiles(homeDirectory = HOME_DIRECTORY) {
  const hermesRoot = path.join(homeDirectory, HERMES_HOME_RELATIVE_PATH);
  if (!(await pathExists(hermesRoot))) {
    return {
      id: "hermes",
      name: "Hermes Agent",
      shortName: "HM",
      color: "#e4b86a",
      kindLabel: "Agent Profile",
      sourcePath: compactHome(hermesRoot),
      available: false,
      catalogCount: 0,
      itemCount: 0,
      memberCount: 0,
      items: [],
    };
  }

  const items = [
    await createHermesProfileCapability(hermesRoot, "default", true),
  ];
  const profilesRoot = path.join(hermesRoot, "profiles");
  if (await pathExists(profilesRoot)) {
    const profileEntries = (
      await readdir(profilesRoot, { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const profileEntry of profileEntries) {
      items.push(
        await createHermesProfileCapability(
          path.join(profilesRoot, profileEntry.name),
          profileEntry.name,
          false,
        ),
      );
    }
  }

  return {
    id: "hermes",
    name: "Hermes Agent",
    shortName: "HM",
    color: "#e4b86a",
    kindLabel: "Agent Profile",
    sourcePath: compactHome(hermesRoot),
    available: true,
    catalogCount: items.length,
    itemCount: items.length,
    memberCount: 0,
    items,
  };
}

async function getCapabilityProducts(force = false) {
  if (
    !force &&
    cachedCapabilityProducts &&
    Date.now() - cachedCapabilityProductsAt < CAPABILITY_CACHE_TTL
  ) {
    return cachedCapabilityProducts;
  }
  const products = await Promise.all([
    scanWorkBuddyExperts(),
    scanHermesProfiles(),
  ]);
  cachedCapabilityProducts = products;
  cachedCapabilityProductsAt = Date.now();
  return products;
}

export async function scanCapabilityCatalog(
  homeDirectory = HOME_DIRECTORY,
  { force = false } = {},
) {
  const products =
    homeDirectory === HOME_DIRECTORY
      ? await getCapabilityProducts(force)
      : await Promise.all([
          scanWorkBuddyExperts(homeDirectory),
          scanHermesProfiles(homeDirectory),
        ]);
  const availableProducts = products.filter((product) => product.available);
  return {
    products: availableProducts.map((product) => ({
      ...product,
      items: product.items.map(publicCapability),
    })),
    totals: {
      products: availableProducts.length,
      profiles: availableProducts.reduce(
        (sum, product) => sum + product.itemCount,
        0,
      ),
      members: availableProducts.reduce(
        (sum, product) => sum + product.memberCount,
        0,
      ),
    },
    scannedAt: new Date().toISOString(),
  };
}

async function resolveCapability(capabilityIdValue) {
  if (!/^[a-f0-9]{20}$/u.test(String(capabilityIdValue || ""))) return null;
  const products = await getCapabilityProducts();
  for (const product of products) {
    const capability = product.items.find(
      (item) => item.id === capabilityIdValue,
    );
    if (capability) return capability;
  }
  return null;
}

function isSensitiveCapabilityPath(relativePath) {
  const normalizedPath = String(relativePath || "")
    .replaceAll("\\", "/")
    .toLowerCase();
  const segments = normalizedPath.split("/");
  const filename = segments.at(-1) || "";
  return (
    segments.includes(".git") ||
    filename === ".env" ||
    filename.startsWith(".env.") ||
    filename === "auth.json" ||
    filename === "credentials.json" ||
    /(?:^|[-_.])(?:api[-_.]?key|token|secret|credentials?|session|auth(?:entication)?)(?:[-_.]|$)/u.test(
      filename,
    )
  );
}

async function listCapabilityFiles(capability) {
  if (capability.productId === "workbuddy") {
    const listing = await listSkillFiles(capability.rootPath);
    const entries = listing.entries.filter(
      (entry) => !isSensitiveCapabilityPath(entry.path),
    );
    return {
      ...listing,
      entries,
      fileCount: entries.filter((entry) => entry.type === "file").length,
      directoryCount: entries.filter((entry) => entry.type === "directory")
        .length,
    };
  }
  const entries = [];
  for (const filePath of capability.allowedFiles) {
    const fileStats = await stat(path.join(capability.rootPath, filePath));
    entries.push({
      path: filePath,
      name: path.basename(filePath),
      type: "file",
      size: fileStats.size,
      modifiedAt: fileStats.mtime.toISOString(),
      language: languageForFile(filePath),
      linkTarget: null,
    });
  }
  for (const [filePath, content] of capability.virtualFiles) {
    entries.push({
      path: filePath,
      name: filePath,
      type: "file",
      size: Buffer.byteLength(content),
      modifiedAt: capability.modifiedAt,
      language: "json",
      linkTarget: null,
    });
  }
  entries.sort((left, right) => {
    if (left.path === capability.primaryFilePath) return -1;
    if (right.path === capability.primaryFilePath) return 1;
    return left.path.localeCompare(right.path);
  });
  return {
    entries,
    fileCount: entries.length,
    directoryCount: 0,
    truncated: false,
  };
}

async function readCapabilityFile(capability, requestedPath) {
  const normalizedPath = String(requestedPath || "")
    .split(path.sep)
    .join("/");
  if (isSensitiveCapabilityPath(normalizedPath)) {
    throw new Error("为保护本机隐私，这类认证或会话文件不会开放预览。");
  }
  if (capability.virtualFiles.has(normalizedPath)) {
    const content = capability.virtualFiles.get(normalizedPath);
    return {
      path: normalizedPath,
      name: path.basename(normalizedPath),
      size: Buffer.byteLength(content),
      modifiedAt: capability.modifiedAt,
      language: languageForFile(normalizedPath),
      mimeType: null,
      previewKind: "text",
      content,
      previewable: true,
      reason: null,
    };
  }
  if (
    capability.allowedFiles &&
    !capability.allowedFiles.has(normalizedPath)
  ) {
    throw new Error("这个 Agent 配置文件未开放预览。");
  }
  return readSkillFileContent(capability.rootPath, normalizedPath);
}

async function pathExists(inputPath) {
  try {
    await lstat(inputPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

function sanitizeConfig(input) {
  const rawAgents = Array.isArray(input?.agents) ? input.agents.slice(0, 24) : [];
  const inputVersion = Number(input?.version) || 1;
  const catalogById = new Map(AGENT_CATALOG.map((agent) => [agent.id, agent]));
  const seenIds = new Set();
  const agents = rawAgents
    .map((agent, index) => {
      const candidateId = String(agent?.id || `agent-${index + 1}`)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32);
      let id = candidateId || `agent-${index + 1}`;
      let suffix = 2;
      while (seenIds.has(id)) {
        id = `${candidateId || "agent"}-${suffix++}`;
      }
      seenIds.add(id);

      const name = String(agent?.name || id).trim().slice(0, 48) || id;
      const paths = [
        ...new Set(
          (Array.isArray(agent?.paths) ? agent.paths : [])
            .map((item) => String(item).trim())
            .filter(
              (item) =>
                item.length > 0 &&
                item.length < 1024 &&
                !item.includes("\0") &&
                (item.startsWith("~/") || path.isAbsolute(item)),
            )
            .slice(0, 8),
        ),
      ];

      const suppliedColor = /^#[0-9a-f]{6}$/i.test(String(agent?.color))
        ? String(agent.color).toLowerCase()
        : "";
      const legacyColor = LEGACY_AGENT_COLORS.get(id);
      const catalogColor = catalogById.get(id)?.color;
      const shouldMigrateLegacyColor =
        inputVersion < 2 &&
        legacyColor &&
        catalogColor &&
        suppliedColor === legacyColor.toLowerCase();

      return {
        id,
        name,
        shortName:
          String(agent?.shortName || name.slice(0, 2))
            .trim()
            .slice(0, 3)
            .toUpperCase() || "AG",
        color: shouldMigrateLegacyColor
          ? catalogColor
          : suppliedColor || AGENT_FALLBACK_COLORS[index % AGENT_FALLBACK_COLORS.length],
        paths,
      };
    })
    .filter((agent) => agent.paths.length > 0);
  const finalAgents = agents.length ? agents : DEFAULT_CONFIG.agents;
  const configuredIds = new Set(finalAgents.map((agent) => agent.id));
  const requestedVisibleIds = Array.isArray(input?.visibleAgentIds)
    ? [...new Set(input.visibleAgentIds.map(String))].filter((id) =>
        configuredIds.has(id),
      )
    : [];
  const defaultVisibleIds = DEFAULT_CONFIG.visibleAgentIds.filter((id) =>
    configuredIds.has(id),
  );
  const visibleAgentIds =
    requestedVisibleIds.length > 0
      ? requestedVisibleIds
      : defaultVisibleIds.length > 0
        ? defaultVisibleIds
        : finalAgents.slice(0, 2).map((agent) => agent.id);
  const dismissedAgentIds = Array.isArray(input?.dismissedAgentIds)
    ? [
        ...new Set(
          input.dismissedAgentIds
            .map((id) =>
              String(id)
                .toLowerCase()
                .replace(/[^a-z0-9-]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 32),
            )
            .filter((id) => id && !configuredIds.has(id)),
        ),
      ]
    : [];

  return {
    version: 3,
    syncMode: input?.syncMode === "symlink" ? "symlink" : "copy",
    agents: finalAgents,
    visibleAgentIds,
    dismissedAgentIds,
  };
}

export async function loadConfig() {
  const storedConfig = await readJsonFile(CONFIG_FILE, null);
  let config;
  if (storedConfig) {
    config = sanitizeConfig(storedConfig);
  } else {
    const detectedAgents = [];
    for (const agent of AGENT_CATALOG) {
      const detected = (
        await Promise.all([
          ...agent.paths,
          ...(agent.id === "smartorder" ? ["~/.smartorder/config.toml"] : []),
        ].map((agentPath) => pathExists(expandHome(agentPath))))
      ).some(Boolean);
      if (detected) detectedAgents.push(agent);
    }
    config = sanitizeConfig({
      ...DEFAULT_CONFIG,
      agents: detectedAgents.length ? detectedAgents : DEFAULT_CONFIG.agents,
    });
  }

  const configuredIds = new Set(config.agents.map((agent) => agent.id));
  const dismissedAgentIds = new Set(config.dismissedAgentIds);
  const newlyDetected = [];
  for (const agent of AGENT_CATALOG) {
    if (configuredIds.has(agent.id) || dismissedAgentIds.has(agent.id)) continue;
    const detected = (
      await Promise.all([
        ...agent.paths,
        ...(agent.id === "smartorder" ? ["~/.smartorder/config.toml"] : []),
      ].map((agentPath) => pathExists(expandHome(agentPath))))
    ).some(Boolean);
    if (detected) newlyDetected.push(agent);
  }
  return sanitizeConfig({
    ...config,
    agents: [...config.agents, ...newlyDetected],
  });
}

async function saveConfig(input) {
  const config = sanitizeConfig(input);
  await mkdir(STATE_DIRECTORY, { recursive: true });
  const temporaryFile = `${CONFIG_FILE}.tmp-${process.pid}`;
  await writeFile(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporaryFile, CONFIG_FILE);
  invalidateScanCache();
  return config;
}

async function discoverSkillDirectories(rootPath, maxDepth = 4, strictBoundary = false) {
  const discovered = [];
  const boundary = strictBoundary ? await realpath(rootPath) : null;

  async function visit(currentPath, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      if (boundary && !isWithin(boundary, await realpath(currentPath))) return;
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) return;
      throw error;
    }

    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      discovered.push(currentPath);
      return;
    }

    await Promise.all(
      entries
        .filter(
          (entry) =>
            !IGNORED_DIRECTORIES.has(entry.name) &&
            (entry.isDirectory() || entry.isSymbolicLink()),
        )
        .map(async (entry) => {
          const childPath = path.join(currentPath, entry.name);
          if (entry.isSymbolicLink()) {
            try {
              if (!(await stat(childPath)).isDirectory()) return;
            } catch {
              return;
            }
          }
          await visit(childPath, depth + 1);
        }),
    );
  }

  if (await pathExists(rootPath)) await visit(rootPath, 0);
  return discovered;
}

async function loadFingerprintCache() {
  if (fingerprintCacheLoaded) return;
  if (fingerprintCacheLoadPromise) return fingerprintCacheLoadPromise;

  fingerprintCacheLoadPromise = (async () => {
    const stored = await readJsonFile(FINGERPRINT_CACHE_FILE, null);
    if (stored?.version === 1 && Array.isArray(stored.entries)) {
      for (const entry of stored.entries.slice(-FINGERPRINT_CACHE_LIMIT)) {
        if (
          typeof entry?.path === "string" &&
          typeof entry?.snapshot === "string" &&
          typeof entry?.fingerprint?.hash === "string"
        ) {
          fingerprintCache.set(entry.path, {
            snapshot: entry.snapshot,
            fingerprint: entry.fingerprint,
            usedAt: Number(entry.usedAt) || 0,
          });
        }
      }
    }
    fingerprintCacheLoaded = true;
  })().finally(() => {
    fingerprintCacheLoadPromise = null;
  });

  return fingerprintCacheLoadPromise;
}

async function persistFingerprintCache() {
  if (!fingerprintCacheDirty) return;
  const entries = [...fingerprintCache.entries()]
    .map(([cachePath, entry]) => ({ path: cachePath, ...entry }))
    .sort((left, right) => left.usedAt - right.usedAt)
    .slice(-FINGERPRINT_CACHE_LIMIT);
  const retainedPaths = new Set(entries.map((entry) => entry.path));
  for (const cachePath of fingerprintCache.keys()) {
    if (!retainedPaths.has(cachePath)) fingerprintCache.delete(cachePath);
  }

  await mkdir(STATE_DIRECTORY, { recursive: true });
  const temporaryFile = `${FINGERPRINT_CACHE_FILE}.tmp-${process.pid}`;
  await writeFile(
    temporaryFile,
    `${JSON.stringify({ version: 1, entries })}\n`,
    "utf8",
  );
  await rename(temporaryFile, FINGERPRINT_CACHE_FILE);
  fingerprintCacheDirty = false;
}

async function fingerprintDirectory(
  directoryPath,
  { persistentCache = false, force = false } = {},
) {
  if (persistentCache) await loadFingerprintCache();

  const metadataHash = createHash("sha256");
  const records = [];
  const hash = createHash("sha256");
  let fileCount = 0;
  let byteCount = 0;
  let latestModified = 0;
  let truncated = false;

  async function visit(currentPath, relativeRoot = "") {
    if (fileCount >= 500 || byteCount >= 4_000_000) {
      truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (fileCount >= 500 || byteCount >= 4_000_000) {
        truncated = true;
        break;
      }
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = path.join(relativeRoot, entry.name);
      let entryStats;
      try {
        entryStats = await lstat(absolutePath);
      } catch {
        continue;
      }
      latestModified = Math.max(latestModified, entryStats.mtimeMs);

      if (entryStats.isDirectory()) {
        metadataHash.update(
          `directory:${relativePath}:${entryStats.mtimeMs};`,
        );
        await visit(absolutePath, relativePath);
      } else if (entryStats.isSymbolicLink()) {
        let linkTarget = "";
        try {
          linkTarget = await readlink(absolutePath);
        } catch {
          linkTarget = "链接目标不可用";
        }
        fileCount += 1;
        metadataHash.update(
          `link:${relativePath}:${entryStats.mtimeMs}:${linkTarget};`,
        );
        records.push({
          type: "link",
          relativePath,
          linkTarget,
        });
      } else if (entryStats.isFile()) {
        fileCount += 1;
        byteCount += entryStats.size;
        metadataHash.update(
          `file:${relativePath}:${entryStats.size}:${entryStats.mtimeMs};`,
        );
        records.push({
          type: "file",
          absolutePath,
          relativePath,
          size: entryStats.size,
          modifiedAt: entryStats.mtimeMs,
        });
      }
    }
  }

  await visit(directoryPath);
  metadataHash.update(`truncated:${truncated};`);
  const snapshot = metadataHash.digest("hex");
  const cached = fingerprintCache.get(directoryPath);
  if (!force && cached?.snapshot === snapshot) {
    cached.usedAt = Date.now();
    return cached.fingerprint;
  }

  let hashedByteCount = 0;
  for (const record of records) {
    if (record.type === "link") {
      hash.update(`link:${record.relativePath}:${record.linkTarget}`);
      continue;
    }

    hashedByteCount += record.size;
    hash.update(`file:${record.relativePath}:${record.size}:`);
    if (record.size <= 512_000 && hashedByteCount <= 4_000_000) {
      await new Promise((resolve) => {
        const stream = createReadStream(record.absolutePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", () => resolve());
        stream.on("end", resolve);
      });
    } else {
      hash.update(String(record.modifiedAt));
    }
  }

  const fingerprint = {
    hash: hash.digest("hex"),
    fileCount,
    byteCount,
    latestModified,
    truncated,
  };
  fingerprintCache.set(directoryPath, {
    snapshot,
    fingerprint,
    usedAt: Date.now(),
  });
  fingerprintCacheDirty = true;
  return fingerprint;
}

async function describeSkillDirectory(
  skillPath,
  agent,
  rootPath,
  fingerprintOptions,
) {
  const manifestPath = path.join(skillPath, "SKILL.md");
  const manifest = await readFile(manifestPath, "utf8");
  const parsed = parseFrontmatter(manifest, path.basename(skillPath));
  const fingerprint = await fingerprintDirectory(skillPath, fingerprintOptions);
  const linkStats = await lstat(skillPath);
  let linkTarget = null;
  if (linkStats.isSymbolicLink()) {
    try {
      linkTarget = compactHome(await realpath(skillPath));
    } catch {
      linkTarget = "链接目标不可用";
    }
  }
  const instanceId = createHash("sha1")
    .update(`${agent.id}:${skillPath}`)
    .digest("hex")
    .slice(0, 16);

  return {
    id: instanceId,
    agentId: agent.id,
    agentName: agent.name,
    root: compactHome(rootPath),
    path: compactHome(skillPath),
    absolutePath: skillPath,
    directoryName: path.basename(skillPath),
    name: parsed.name,
    displayName: parsed.displayName,
    description: parsed.description,
    tags: parsed.tags,
    hash: fingerprint.hash,
    shortHash: fingerprint.hash.slice(0, 8),
    fileCount: fingerprint.fileCount,
    byteCount: fingerprint.byteCount,
    modifiedAt: fingerprint.latestModified
      ? new Date(fingerprint.latestModified).toISOString()
      : null,
    isSymlink: linkStats.isSymbolicLink(),
    linkTarget,
    truncated: fingerprint.truncated,
  };
}

async function readHistory(limit = 16, homeDirectory = HOME_DIRECTORY) {
  try {
    const historyPath = homeDirectory === HOME_DIRECTORY ? HISTORY_FILE : path.join(homeDirectory, ".agent-skill-manager", "history.jsonl");
    const content = await readFile(historyPath, "utf8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function scanAll(
  configInput,
  { persistentCache = false, forceFingerprints = false, homeDirectory = HOME_DIRECTORY } = {},
) {
  const config = sanitizeConfig(configInput);
  const visibleAgentIds = new Set(config.visibleAgentIds);
  const visibleAgents = config.agents.filter((agent) =>
    visibleAgentIds.has(agent.id),
  );
  const agentScans = await Promise.all(
    config.agents.map(async (agent) => {
      const visible = visibleAgentIds.has(agent.id);
      const smartOrder = agent.id === "smartorder" ? await scanSmartOrder(homeDirectory) : null;
      const scanSources = [
        ...agent.paths.map((sourcePath) => ({ path: sourcePath, readOnly: false, label: "" })),
        ...(smartOrder?.skillSources || []),
      ].filter((source, index, list) => list.findIndex((item) => expandHome(item.path) === expandHome(source.path)) === index);
      const rootScans = await Promise.all(
        scanSources.map(async (source) => {
          const configuredPath = source.path;
          const rootPath = expandHome(configuredPath);
          const available = await pathExists(rootPath);
          const skillDirectories = (available
            ? await discoverSkillDirectories(rootPath, 4, agent.id === "smartorder")
            : []).filter((skillPath) => !(smartOrder?.disabledSkillPaths || []).some((disabled) =>
              disabled === skillPath || disabled === path.join(skillPath, "SKILL.md")));
          const instances = visible
            ? (
                await Promise.all(
                  skillDirectories.map(async (skillPath) => {
                    try {
                      const instance = await describeSkillDirectory(
                        skillPath,
                        agent,
                        rootPath,
                        {
                          persistentCache,
                          force: forceFingerprints,
                        },
                      );
                      if (agent.id === "smartorder") {
                        instance.readOnly = source.readOnly || path.relative(rootPath, skillPath).split(path.sep).includes(".system");
                        instance.sourceLabel = source.label || (instance.readOnly ? "客户端内置" : "本地技能");
                      }
                      return instance;
                    } catch (error) {
                      return {
                        error: error?.message || "读取失败",
                        agentId: agent.id,
                        path: compactHome(skillPath),
                      };
                    }
                  }),
                )
              ).filter((instance) => !instance.error)
            : [];
          return {
            root: {
              configuredPath,
              path: compactHome(rootPath),
              available,
              skillCount: skillDirectories.length,
              ...(source.readOnly ? { readOnly: true, sourceLabel: source.label } : {}),
            },
            instances,
            directoryNames: skillDirectories.map((skillPath) =>
              path.basename(skillPath).trim().toLocaleLowerCase(),
            ),
          };
        }),
      );
      const instances = rootScans.flatMap((rootScan) => rootScan.instances);
      const skillNames = visible
        ? instances.map((instance) =>
            instance.name.trim().toLocaleLowerCase(),
          )
        : rootScans.flatMap((rootScan) => rootScan.directoryNames);
      return {
        agent: {
          ...agent,
          roots: rootScans.map((rootScan) => rootScan.root),
          available: rootScans.some((rootScan) => rootScan.root.available),
          visible,
          ...(smartOrder ? { warnings: smartOrder.warnings } : {}),
          installationCount: rootScans.reduce(
            (total, rootScan) => total + rootScan.root.skillCount,
            0,
          ),
          skillCount: new Set(skillNames).size,
        },
        instances,
      };
    }),
  );
  const agentResults = agentScans.map((agentScan) => agentScan.agent);
  const allInstances = agentScans.flatMap((agentScan) => agentScan.instances);
  if (persistentCache) await persistFingerprintCache();

  const groups = new Map();
  for (const instance of allInstances) {
    if (!visibleAgentIds.has(instance.agentId)) continue;
    const key = instance.name.trim().toLocaleLowerCase();
    const existing = groups.get(key) || [];
    existing.push(instance);
    groups.set(key, existing);
  }

  const skills = [...groups.entries()]
    .map(([key, instances]) => {
      const sortedInstances = [...instances].sort((a, b) =>
        String(b.modifiedAt).localeCompare(String(a.modifiedAt)),
      );
      const hashes = new Set(instances.map((instance) => instance.hash));
      const installedAgentIds = [
        ...new Set(instances.map((instance) => instance.agentId)),
      ];
      const coverage = installedAgentIds.length / visibleAgents.length;
      const conflict = hashes.size > 1;
      const status = conflict
        ? "conflict"
        : coverage === 1
          ? "synced"
          : installedAgentIds.length === 1
            ? "single"
            : "partial";
      const newest = sortedInstances[0];
      const localized = sortedInstances.find(
        (instance) =>
          containsChinese(instance.displayName) ||
          containsChinese(instance.description),
      );
      const id = createHash("sha1").update(key).digest("hex").slice(0, 16);
      return {
        id,
        name: newest.name,
        displayName: localized?.displayName || newest.displayName || newest.name,
        description: localized?.description || newest.description,
        tags: [...new Set(instances.flatMap((instance) => instance.tags))].slice(
          0,
          6,
        ),
        status,
        conflict,
        coverage,
        installedAgentIds,
        missingAgentIds: visibleAgents
          .map((agent) => agent.id)
          .filter((agentId) => !installedAgentIds.includes(agentId)),
        hashes: [...hashes].map((hash) => hash.slice(0, 8)),
        modifiedAt: newest.modifiedAt,
        fileCount: Math.max(...instances.map((instance) => instance.fileCount)),
        instances: sortedInstances.map((instance) => {
          const publicInstance = { ...instance };
          delete publicInstance.absolutePath;
          delete publicInstance.description;
          delete publicInstance.tags;
          delete publicInstance.linkTarget;
          delete publicInstance.truncated;
          return publicInstance;
        }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    agents: agentResults,
    skills,
    totals: {
      uniqueSkills: skills.length,
      installations: allInstances.filter((instance) =>
        visibleAgentIds.has(instance.agentId),
      ).length,
      synced: skills.filter((skill) => skill.status === "synced").length,
      conflicts: skills.filter((skill) => skill.status === "conflict").length,
      incomplete: skills.filter((skill) =>
        ["single", "partial"].includes(skill.status),
      ).length,
      coverage: skills.length
        ? skills.reduce((sum, skill) => sum + skill.coverage, 0) / skills.length
        : 0,
    },
    history: await readHistory(16, homeDirectory),
    scannedAt: new Date().toISOString(),
  };
}

async function scanInWorker(config, forceFingerprints) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./scan-worker.mjs", import.meta.url), {
      workerData: { config, forceFingerprints },
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
      void worker.terminate();
    };
    worker.once("message", (message) => {
      if (message?.ok) {
        finish(resolve, message.scan);
      } else {
        const error = new Error(message?.error || "后台扫描失败。");
        if (message?.stack) error.stack = message.stack;
        finish(reject, error);
      }
    });
    worker.once("error", (error) => finish(reject, error));
    worker.once("exit", (code) => {
      if (!settled) {
        finish(reject, new Error(`后台扫描线程异常退出（${code}）。`));
      }
    });
  });
}

async function getScan(force = false) {
  if (
    !force &&
    cachedScan &&
    Date.now() - cachedScanAt < SCAN_CACHE_TTL
  ) {
    return cachedScan;
  }

  const generation = scanGeneration;
  if (
    pendingScan?.generation === generation &&
    (!force || pendingScan.force)
  ) {
    return pendingScan.promise;
  }

  const promise = (async () => {
    const config = await loadConfig();
    let scan;
    try {
      scan = await scanInWorker(config, force);
    } catch (workerError) {
      console.warn(
        `[skills] 后台扫描不可用，已回退到当前进程：${
          workerError?.message || workerError
        }`,
      );
      scan = await scanAll(config, {
        persistentCache: true,
        forceFingerprints: force,
      });
    }
    if (generation === scanGeneration) {
      cachedScan = scan;
      cachedScanAt = Date.now();
    }
    return scan;
  })();
  pendingScan = { generation, force, promise };

  try {
    return await promise;
  } finally {
    if (pendingScan?.promise === promise) pendingScan = null;
  }
}

function resolveInstance(scan, instanceId) {
  for (const skill of scan.skills) {
    const instance = skill.instances.find((item) => item.id === instanceId);
    if (instance) {
      return {
        skill,
        instance: { ...instance, absolutePath: expandHome(instance.path) },
      };
    }
  }
  return null;
}

function isWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isStrictlyWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function languageForFile(filePath) {
  const basename = path.basename(filePath).toLowerCase();
  const extension = path.extname(basename).slice(1);
  if (basename === "skill.md" || extension === "md" || extension === "mdx") {
    return "markdown";
  }
  return (
    {
      cjs: "javascript",
      css: "css",
      csv: "csv",
      html: "html",
      java: "java",
      js: "javascript",
      json: "json",
      jsx: "jsx",
      mjs: "javascript",
      py: "python",
      rb: "ruby",
      rs: "rust",
      sh: "shell",
      svg: "svg",
      toml: "toml",
      ts: "typescript",
      tsx: "tsx",
      txt: "text",
      xml: "xml",
      yaml: "yaml",
      yml: "yaml",
    }[extension] || extension || "text"
  );
}

function imageMimeTypeForFile(filePath) {
  return IMAGE_MIME_TYPES.get(path.extname(filePath).toLowerCase()) || null;
}

function bufferLooksLikeText(buffer) {
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.includes(0)) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length < 0.05;
}

async function resolveSkillFile(directoryPath, requestedPath) {
  const relativePath = String(requestedPath || "").split("\\").join("/");
  if (
    !relativePath ||
    relativePath.includes("\0") ||
    path.posix.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith("../")
  ) {
    throw new Error("文件路径无效。");
  }

  const rootPath = await realpath(directoryPath);
  const candidatePath = path.resolve(directoryPath, relativePath);
  if (!isWithin(path.resolve(directoryPath), candidatePath)) {
    throw new Error("不能读取 Skill 目录之外的文件。");
  }

  const resolvedFile = await realpath(candidatePath);
  if (!isWithin(rootPath, resolvedFile)) {
    throw new Error("不能读取指向 Skill 目录之外的文件。");
  }
  const fileStats = await stat(resolvedFile);
  if (!fileStats.isFile()) throw new Error("所选路径不是文件。");
  return { relativePath, resolvedFile, fileStats };
}

export async function listSkillFiles(directoryPath) {
  const resolvedRoot = await realpath(directoryPath);
  const entries = [];
  let truncated = false;

  async function visit(currentPath, relativeRoot = "") {
    if (entries.length >= SKILL_ENTRY_LIMIT) {
      truncated = true;
      return;
    }
    let children = [];
    try {
      children = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

    for (const child of children) {
      if (entries.length >= SKILL_ENTRY_LIMIT) {
        truncated = true;
        break;
      }
      if (IGNORED_DIRECTORIES.has(child.name)) continue;
      const absolutePath = path.join(currentPath, child.name);
      const relativePath = path.join(relativeRoot, child.name).split(path.sep).join("/");
      let childStats;
      try {
        childStats = await lstat(absolutePath);
      } catch {
        continue;
      }

      if (childStats.isSymbolicLink()) {
        let linkTarget = "";
        try {
          linkTarget = await readlink(absolutePath);
        } catch {
          linkTarget = "链接目标不可用";
        }
        entries.push({
          path: relativePath,
          name: child.name,
          type: "symlink",
          size: childStats.size,
          modifiedAt: childStats.mtime.toISOString(),
          language: "link",
          linkTarget,
        });
        continue;
      }

      if (childStats.isDirectory()) {
        entries.push({
          path: relativePath,
          name: child.name,
          type: "directory",
          size: 0,
          modifiedAt: childStats.mtime.toISOString(),
          language: null,
          linkTarget: null,
        });
        await visit(absolutePath, relativePath);
        continue;
      }

      if (childStats.isFile()) {
        entries.push({
          path: relativePath,
          name: child.name,
          type: "file",
          size: childStats.size,
          modifiedAt: childStats.mtime.toISOString(),
          language: languageForFile(relativePath),
          linkTarget: null,
        });
      }
    }
  }

  await visit(resolvedRoot);
  return {
    entries,
    fileCount: entries.filter((entry) => entry.type !== "directory").length,
    directoryCount: entries.filter((entry) => entry.type === "directory").length,
    truncated,
  };
}

export async function readSkillFileContent(directoryPath, requestedPath) {
  const { relativePath, resolvedFile, fileStats } = await resolveSkillFile(
    directoryPath,
    requestedPath,
  );
  const imageMimeType = imageMimeTypeForFile(relativePath);

  const base = {
    path: relativePath,
    name: path.basename(relativePath),
    size: fileStats.size,
    modifiedAt: fileStats.mtime.toISOString(),
    language: languageForFile(relativePath),
    mimeType: imageMimeType,
    previewKind: imageMimeType ? "image" : "text",
  };
  if (imageMimeType) {
    if (fileStats.size > SKILL_IMAGE_PREVIEW_LIMIT) {
      return {
        ...base,
        content: null,
        previewable: false,
        previewKind: "unavailable",
        reason: `图片超过 ${Math.round(SKILL_IMAGE_PREVIEW_LIMIT / 1_000_000)} MB，未在界面中加载。`,
      };
    }
    if (imageMimeType !== "image/svg+xml") {
      return {
        ...base,
        content: null,
        previewable: true,
        reason: null,
      };
    }
    if (fileStats.size > SKILL_CONTENT_LIMIT) {
      return {
        ...base,
        content: null,
        previewable: true,
        reason: null,
      };
    }
  }

  if (fileStats.size > SKILL_CONTENT_LIMIT) {
    return {
      ...base,
      content: null,
      previewable: false,
      previewKind: "unavailable",
      reason: `文件超过 ${Math.round(SKILL_CONTENT_LIMIT / 1_000_000)} MB，未在界面中加载。`,
    };
  }

  const buffer = await readFile(resolvedFile);
  if (!bufferLooksLikeText(buffer)) {
    return {
      ...base,
      content: null,
      previewable: false,
      previewKind: "unavailable",
      reason: "这是二进制文件，暂不支持文本预览。",
    };
  }
  return {
    ...base,
    content: buffer.toString("utf8"),
    previewable: true,
    reason: null,
  };
}

function validateSvgPreview(buffer) {
  if (!bufferLooksLikeText(buffer)) {
    throw new Error("SVG 文件不是有效的文本格式。");
  }
  const source = buffer.toString("utf8");
  if (!/<svg(?:\s|>)/i.test(source)) {
    throw new Error("文件扩展名是 SVG，但没有找到 SVG 根元素。");
  }
  const unsafeMarkup =
    /<\s*(?:script|foreignObject|iframe|object|embed|audio|video)\b/i;
  const eventHandler = /\b(?:on[a-z]+)\s*=/i;
  const referenceValues = [
    ...source.matchAll(
      /\b(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi,
    ),
  ].map((match) => match[1].trim());
  const cssUrlValues = [
    ...source.matchAll(/url\s*\(\s*["']?([^'")]+)["']?\s*\)/gi),
  ].map((match) => match[1].trim());
  const hasExternalReference = [...referenceValues, ...cssUrlValues].some(
    (value) => value && !value.startsWith("#") && !value.startsWith("data:image/"),
  );
  if (
    unsafeMarkup.test(source) ||
    eventHandler.test(source) ||
    /@import\b/i.test(source) ||
    hasExternalReference
  ) {
    throw new Error("SVG 包含脚本、外部资源或其他不安全内容，已阻止渲染。");
  }
}

export async function readSkillImageAsset(directoryPath, requestedPath) {
  const { relativePath, resolvedFile, fileStats } = await resolveSkillFile(
    directoryPath,
    requestedPath,
  );
  const mimeType = imageMimeTypeForFile(relativePath);
  if (!mimeType) throw new Error("该文件不是支持预览的图片格式。");
  if (fileStats.size > SKILL_IMAGE_PREVIEW_LIMIT) {
    throw new Error(
      `图片超过 ${Math.round(SKILL_IMAGE_PREVIEW_LIMIT / 1_000_000)} MB，无法预览。`,
    );
  }

  const buffer = await readFile(resolvedFile);
  if (mimeType === "image/svg+xml") validateSvgPreview(buffer);
  return {
    buffer,
    mimeType,
    filename: path.basename(relativePath),
  };
}

async function hashFileForDiff(directoryPath, requestedPath) {
  const { resolvedFile } = await resolveSkillFile(directoryPath, requestedPath);
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(resolvedFile);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(items.length, 1)) },
      () => run(),
    ),
  );
  return results;
}

function diffEntryMetadata(entry) {
  if (!entry) return null;
  return {
    type: entry.type,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
    language: entry.language,
    mimeType:
      entry.type === "file" ? imageMimeTypeForFile(entry.path) : null,
    linkTarget: entry.type === "symlink" ? entry.linkTarget : null,
  };
}

export async function compareSkillDirectories(leftDirectory, rightDirectory) {
  const [leftListing, rightListing] = await Promise.all([
    listSkillFiles(leftDirectory),
    listSkillFiles(rightDirectory),
  ]);
  const leftEntries = new Map(
    leftListing.entries
      .filter((entry) => entry.type !== "directory")
      .map((entry) => [entry.path, entry]),
  );
  const rightEntries = new Map(
    rightListing.entries
      .filter((entry) => entry.type !== "directory")
      .map((entry) => [entry.path, entry]),
  );
  const paths = [...new Set([...leftEntries.keys(), ...rightEntries.keys()])].sort(
    (left, right) => {
      if (left.toLowerCase() === "skill.md") return -1;
      if (right.toLowerCase() === "skill.md") return 1;
      return left.localeCompare(right);
    },
  );

  const compared = await mapWithConcurrency(paths, 6, async (entryPath) => {
    const left = leftEntries.get(entryPath) || null;
    const right = rightEntries.get(entryPath) || null;
    let change;

    if (!left) {
      change = "right-only";
    } else if (!right) {
      change = "left-only";
    } else if (left.type !== right.type) {
      change = "type-changed";
    } else if (left.type === "symlink") {
      change =
        left.linkTarget === right.linkTarget ? "unchanged" : "modified";
    } else if (left.size !== right.size) {
      change = "modified";
    } else {
      const [leftHash, rightHash] = await Promise.all([
        hashFileForDiff(leftDirectory, entryPath),
        hashFileForDiff(rightDirectory, entryPath),
      ]);
      change = leftHash === rightHash ? "unchanged" : "modified";
    }

    return {
      path: entryPath,
      name: path.basename(entryPath),
      change,
      left: diffEntryMetadata(left),
      right: diffEntryMetadata(right),
    };
  });
  const summary = {
    modified: compared.filter((entry) => entry.change === "modified").length,
    leftOnly: compared.filter((entry) => entry.change === "left-only").length,
    rightOnly: compared.filter((entry) => entry.change === "right-only").length,
    typeChanged: compared.filter((entry) => entry.change === "type-changed")
      .length,
    unchanged: compared.filter((entry) => entry.change === "unchanged").length,
    total: compared.length,
  };

  return {
    summary,
    entries: compared.filter((entry) => entry.change !== "unchanged"),
    truncated: leftListing.truncated || rightListing.truncated,
  };
}

function lineOperations(leftSource, rightSource) {
  const maxLines = 2_000;
  const allLeftLines = leftSource === "" ? [] : leftSource.split(/\r?\n/);
  const allRightLines = rightSource === "" ? [] : rightSource.split(/\r?\n/);
  const leftLines = allLeftLines.slice(0, maxLines);
  const rightLines = allRightLines.slice(0, maxLines);
  const truncated =
    allLeftLines.length > maxLines || allRightLines.length > maxLines;
  const columns = rightLines.length + 1;
  const cellCount = (leftLines.length + 1) * columns;
  const operations = [];

  if (cellCount <= 1_250_000) {
    const table = new Uint32Array(cellCount);
    for (let leftIndex = 1; leftIndex <= leftLines.length; leftIndex += 1) {
      for (
        let rightIndex = 1;
        rightIndex <= rightLines.length;
        rightIndex += 1
      ) {
        const cell = leftIndex * columns + rightIndex;
        table[cell] =
          leftLines[leftIndex - 1] === rightLines[rightIndex - 1]
            ? table[(leftIndex - 1) * columns + rightIndex - 1] + 1
            : Math.max(
                table[(leftIndex - 1) * columns + rightIndex],
                table[leftIndex * columns + rightIndex - 1],
              );
      }
    }

    let leftIndex = leftLines.length;
    let rightIndex = rightLines.length;
    while (leftIndex > 0 || rightIndex > 0) {
      if (
        leftIndex > 0 &&
        rightIndex > 0 &&
        leftLines[leftIndex - 1] === rightLines[rightIndex - 1]
      ) {
        operations.push({
          kind: "context",
          text: leftLines[leftIndex - 1],
        });
        leftIndex -= 1;
        rightIndex -= 1;
      } else if (
        rightIndex > 0 &&
        (leftIndex === 0 ||
          table[leftIndex * columns + rightIndex - 1] >
            table[(leftIndex - 1) * columns + rightIndex])
      ) {
        operations.push({
          kind: "added",
          text: rightLines[rightIndex - 1],
        });
        rightIndex -= 1;
      } else {
        operations.push({
          kind: "removed",
          text: leftLines[leftIndex - 1],
        });
        leftIndex -= 1;
      }
    }
    operations.reverse();
  } else {
    let prefixLength = 0;
    while (
      prefixLength < leftLines.length &&
      prefixLength < rightLines.length &&
      leftLines[prefixLength] === rightLines[prefixLength]
    ) {
      operations.push({
        kind: "context",
        text: leftLines[prefixLength],
      });
      prefixLength += 1;
    }
    let leftSuffix = leftLines.length - 1;
    let rightSuffix = rightLines.length - 1;
    const suffix = [];
    while (
      leftSuffix >= prefixLength &&
      rightSuffix >= prefixLength &&
      leftLines[leftSuffix] === rightLines[rightSuffix]
    ) {
      suffix.unshift({ kind: "context", text: leftLines[leftSuffix] });
      leftSuffix -= 1;
      rightSuffix -= 1;
    }
    for (let index = prefixLength; index <= leftSuffix; index += 1) {
      operations.push({ kind: "removed", text: leftLines[index] });
    }
    for (let index = prefixLength; index <= rightSuffix; index += 1) {
      operations.push({ kind: "added", text: rightLines[index] });
    }
    operations.push(...suffix);
  }

  let leftNumber = 0;
  let rightNumber = 0;
  const numbered = operations.map((operation) => {
    if (operation.kind !== "added") leftNumber += 1;
    if (operation.kind !== "removed") rightNumber += 1;
    return {
      ...operation,
      leftNumber: operation.kind === "added" ? null : leftNumber,
      rightNumber: operation.kind === "removed" ? null : rightNumber,
    };
  });
  const collapsed = [];
  for (let index = 0; index < numbered.length; ) {
    if (numbered[index].kind !== "context") {
      collapsed.push(numbered[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < numbered.length && numbered[end].kind === "context") end += 1;
    const run = numbered.slice(index, end);
    if (run.length > 8) {
      collapsed.push(
        ...run.slice(0, 3),
        {
          kind: "skip",
          text: `${run.length - 6} 行未变化`,
          leftNumber: null,
          rightNumber: null,
        },
        ...run.slice(-3),
      );
    } else {
      collapsed.push(...run);
    }
    index = end;
  }

  return { lines: collapsed, truncated };
}

export async function readSkillDirectoryDiffFile(
  leftDirectory,
  rightDirectory,
  requestedPath,
) {
  const normalizedPath = String(requestedPath || "").split("\\").join("/");
  const [leftListing, rightListing] = await Promise.all([
    listSkillFiles(leftDirectory),
    listSkillFiles(rightDirectory),
  ]);
  const leftEntry =
    leftListing.entries.find(
      (entry) => entry.path === normalizedPath && entry.type !== "directory",
    ) || null;
  const rightEntry =
    rightListing.entries.find(
      (entry) => entry.path === normalizedPath && entry.type !== "directory",
    ) || null;
  if (!leftEntry && !rightEntry) throw new Error("差异列表中没有这个文件。");

  const left =
    leftEntry?.type === "file"
      ? await readSkillFileContent(leftDirectory, normalizedPath)
      : null;
  const right =
    rightEntry?.type === "file"
      ? await readSkillFileContent(rightDirectory, normalizedPath)
      : null;
  const existingSides = [left, right].filter(Boolean);
  const previewKind =
    existingSides.length > 0 &&
    existingSides.every(
      (side) => side.previewKind === "image" && side.previewable,
    )
    ? "image"
    : existingSides.length > 0 &&
        existingSides.every(
          (side) => side.previewKind === "text" && side.previewable,
        )
      ? "text"
      : "unavailable";
  const textDiff =
    previewKind === "text"
      ? lineOperations(right?.content || "", left?.content || "")
      : null;

  return {
    path: normalizedPath,
    name: path.basename(normalizedPath),
    previewKind,
    left,
    right,
    leftLinkTarget: leftEntry?.linkTarget || null,
    rightLinkTarget: rightEntry?.linkTarget || null,
    lines: textDiff?.lines || [],
    truncated: textDiff?.truncated || false,
    reason:
      previewKind === "unavailable"
        ? "该文件类型暂不支持内容级比较，可根据文件大小和修改时间判断。"
        : null,
  };
}

function sanitizeSkillDirectoryName(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeArchivePath(inputPath) {
  const normalized = String(inputPath || "")
    .split("\\")
    .join("/")
    .replace(/^\.\/+/, "");
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    parts.includes("..")
  ) {
    throw new Error("压缩包包含不安全的文件路径。");
  }
  return normalized;
}

export function inspectSkillArchive(archiveBuffer, originalFilename = "skill.skill") {
  const input = Buffer.from(archiveBuffer);
  if (!input.length) throw new Error(".skill 文件为空。");
  if (input.length > SKILL_ARCHIVE_LIMIT) {
    throw new Error(".skill 文件超过 25 MB，无法导入。");
  }

  let entryCount = 0;
  let unpackedSize = 0;
  const unpacked = unzipSync(input, {
    filter(file) {
      normalizeArchivePath(file.name);
      entryCount += 1;
      unpackedSize += file.originalSize;
      if (entryCount > SKILL_ENTRY_LIMIT) {
        throw new Error(`.skill 文件数量超过 ${SKILL_ENTRY_LIMIT} 个。`);
      }
      if (file.originalSize > SKILL_ARCHIVE_LIMIT) {
        throw new Error(".skill 包含超过 25 MB 的单个文件。");
      }
      if (unpackedSize > SKILL_UNPACKED_LIMIT) {
        throw new Error(".skill 解压后超过 100 MB。");
      }
      return !file.name.endsWith("/");
    },
  });

  const archiveEntries = Object.entries(unpacked)
    .map(([entryPath, data]) => [normalizeArchivePath(entryPath), data])
    .filter(
      ([entryPath]) =>
        !entryPath.startsWith("__MACOSX/") &&
        path.posix.basename(entryPath) !== ".DS_Store",
    );
  const manifestPaths = archiveEntries
    .map(([entryPath]) => entryPath)
    .filter((entryPath) => path.posix.basename(entryPath).toLowerCase() === "skill.md")
    .sort(
      (left, right) =>
        left.split("/").length - right.split("/").length ||
        left.localeCompare(right),
    );
  if (!manifestPaths.length) {
    throw new Error(".skill 包中没有找到必需的 SKILL.md。");
  }

  const manifestPath = manifestPaths[0];
  const rootPrefix = manifestPath.slice(
    0,
    manifestPath.length - path.posix.basename(manifestPath).length,
  );
  const files = new Map();
  for (const [entryPath, data] of archiveEntries) {
    if (rootPrefix && !entryPath.startsWith(rootPrefix)) {
      throw new Error(".skill 包只能包含一个技能根目录。");
    }
    const relativePath = rootPrefix ? entryPath.slice(rootPrefix.length) : entryPath;
    if (!relativePath) continue;
    files.set(
      relativePath.toLowerCase() === "skill.md" ? "SKILL.md" : relativePath,
      Buffer.from(data),
    );
  }

  const manifest = files.get("SKILL.md");
  if (!manifest) throw new Error(".skill 包中的 SKILL.md 无法读取。");
  const rootName = rootPrefix
    ? rootPrefix.split("/").filter(Boolean).at(-1)
    : path.basename(originalFilename, path.extname(originalFilename));
  const parsed = parseFrontmatter(manifest.toString("utf8"), rootName);
  const directoryName =
    sanitizeSkillDirectoryName(parsed.name) ||
    sanitizeSkillDirectoryName(rootName) ||
    `imported-${createHash("sha1").update(input).digest("hex").slice(0, 8)}`;

  return {
    originalFilename,
    directoryName,
    name: parsed.name || directoryName,
    displayName: parsed.displayName || parsed.name || directoryName,
    description: parsed.description,
    tags: parsed.tags,
    fileCount: files.size,
    byteCount: [...files.values()].reduce((total, file) => total + file.length, 0),
    files,
  };
}

export async function stageSkillArchive(
  archiveBuffer,
  originalFilename = "skill.skill",
  importRoot = IMPORT_DIRECTORY,
) {
  const inspected = inspectSkillArchive(archiveBuffer, originalFilename);
  const importId = createHash("sha1")
    .update(archiveBuffer)
    .update(String(Date.now()))
    .digest("hex")
    .slice(0, 20);
  const rootPath = path.join(importRoot, importId, inspected.directoryName);
  await mkdir(rootPath, { recursive: true });
  for (const [relativePath, content] of inspected.files) {
    const destinationPath = path.resolve(rootPath, relativePath);
    if (!isWithin(rootPath, destinationPath)) {
      throw new Error("压缩包包含不安全的文件路径。");
    }
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, content);
  }
  const listing = await listSkillFiles(rootPath);
  const fingerprint = await fingerprintDirectory(rootPath);
  const imported = {
    importId,
    originalFilename: inspected.originalFilename,
    directoryName: inspected.directoryName,
    name: inspected.name,
    displayName: inspected.displayName,
    description: inspected.description,
    tags: inspected.tags,
    fileCount: inspected.fileCount,
    byteCount: inspected.byteCount,
    rootPath,
    shortHash: fingerprint.hash.slice(0, 8),
    entries: listing.entries,
    directoryCount: listing.directoryCount,
  };
  importedSkills.set(importId, imported);
  return imported;
}

function resolveImportedSkill(importId) {
  const normalizedId = String(importId || "");
  if (!/^[a-f0-9]{20}$/.test(normalizedId)) {
    throw new Error("导入记录无效。");
  }
  const imported = importedSkills.get(normalizedId);
  if (!imported) throw new Error("导入预览已失效，请重新选择 .skill 文件。");
  return imported;
}

export async function createSkillArchive(
  directoryPath,
  directoryName,
  format = "skill",
) {
  const archiveLabel = format === "zip" ? "ZIP" : ".skill";
  const safeDirectoryName =
    sanitizeSkillDirectoryName(directoryName) || "exported-skill";
  const listing = await listSkillFiles(directoryPath);
  if (listing.truncated) {
    throw new Error(
      `${archiveLabel} 导出最多支持 ${SKILL_ENTRY_LIMIT} 个条目，请先精简技能目录。`,
    );
  }
  const archiveFiles = {};
  let unpackedSize = 0;
  for (const entry of listing.entries) {
    if (entry.type !== "file" && entry.type !== "symlink") continue;
    const candidatePath = path.resolve(directoryPath, entry.path);
    const resolvedRoot = await realpath(directoryPath);
    const resolvedFile = await realpath(candidatePath);
    if (!isWithin(resolvedRoot, resolvedFile)) continue;
    const fileStats = await stat(resolvedFile);
    if (!fileStats.isFile()) continue;
    if (fileStats.size > SKILL_ARCHIVE_LIMIT) {
      throw new Error(`${archiveLabel} 导出不支持超过 25 MB 的单个文件。`);
    }
    unpackedSize += fileStats.size;
    if (unpackedSize > SKILL_UNPACKED_LIMIT) {
      throw new Error(`${archiveLabel} 导出内容总大小不能超过 100 MB。`);
    }
    archiveFiles[`${safeDirectoryName}/${entry.path}`] = await readFile(resolvedFile);
  }
  if (!archiveFiles[`${safeDirectoryName}/SKILL.md`]) {
    throw new Error("技能目录中没有可打包的 SKILL.md。");
  }
  const archive = Buffer.from(zipSync(archiveFiles, { level: 6 }));
  if (archive.length > SKILL_ARCHIVE_LIMIT) {
    throw new Error(`${archiveLabel} 导出文件超过 25 MB，请先精简技能内容。`);
  }
  return archive;
}

async function planImportInstall({ importId, targetAgentIds }) {
  const imported = resolveImportedSkill(importId);
  const config = await loadConfig();
  const scan = await getScan(true);
  const targetIds = [
    ...new Set(Array.isArray(targetAgentIds) ? targetAgentIds : []),
  ].slice(0, 24);
  const existingSkill = scan.skills.find(
    (skill) => skill.name.toLocaleLowerCase() === imported.name.toLocaleLowerCase(),
  );
  const backupGroup = timestampLabel();
  const actions = [];

  for (const targetAgentId of targetIds) {
    const agent = config.agents.find((item) => item.id === targetAgentId);
    if (!agent) continue;
    const existing = existingSkill?.instances.find(
      (instance) => instance.agentId === targetAgentId,
    );
    if (existing?.readOnly) throw new Error(`${agent.name} 的该技能由客户端或插件管理，请在原客户端更新，管理器仅提供读取。`);
    const existingPath = existing ? expandHome(existing.path) : null;
    const rootPath =
      (existingPath
        ? agent.paths
            .map(expandHome)
            .find((candidateRoot) => isWithin(candidateRoot, existingPath))
        : null) || expandHome(agent.paths[0]);
    const destinationPath = existing
      ? existingPath
      : path.join(rootPath, imported.directoryName);
    if (!isStrictlyWithin(rootPath, destinationPath)) {
      throw new Error(
        `目标必须位于 ${agent.name} 的技能目录内，不能替换技能根目录本身。`,
      );
    }
    const exists = await pathExists(destinationPath);
    const identical = existing?.shortHash === imported.shortHash;
    const action = identical ? "noop" : exists ? "replace" : "create";
    const backupPath =
      action === "replace"
        ? path.join(
            BACKUP_DIRECTORY,
            backupGroup,
            agent.id,
            path.basename(destinationPath),
          )
        : null;
    actions.push({
      agentId: agent.id,
      agentName: agent.name,
      action,
      mode: "copy",
      source: compactHome(imported.rootPath),
      destination: compactHome(destinationPath),
      backup: backupPath ? compactHome(backupPath) : null,
      sourceHash: imported.shortHash,
      targetHash: existing?.shortHash || null,
      identical,
    });
  }

  return {
    importId,
    skillName: imported.name,
    displayName: imported.displayName,
    actions,
    backupGroup,
  };
}

export async function materializeSkillDirectory({
  sourcePath,
  destinationPath,
  backupPath = null,
  mode = "copy",
}) {
  const parentPath = path.dirname(destinationPath);
  const suffix = randomUUID();
  const destinationName = path.basename(destinationPath);
  const preparedPath = path.join(
    parentPath,
    `.${destinationName}.skill-control-new-${suffix}`,
  );
  const previousPath = path.join(
    parentPath,
    `.${destinationName}.skill-control-old-${suffix}`,
  );
  let previousMoved = false;

  await mkdir(parentPath, { recursive: true });
  try {
    if (mode === "symlink") {
      await symlink(sourcePath, preparedPath, "dir");
    } else {
      await cp(sourcePath, preparedPath, {
        recursive: true,
        dereference: true,
        preserveTimestamps: true,
        errorOnExist: true,
      });
    }

    if (backupPath) {
      await mkdir(path.dirname(backupPath), { recursive: true });
      await cp(destinationPath, backupPath, {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
        errorOnExist: true,
      });
      await rename(destinationPath, previousPath);
      previousMoved = true;
    }

    try {
      await rename(preparedPath, destinationPath);
    } catch (error) {
      if (previousMoved && !(await pathExists(destinationPath))) {
        await rename(previousPath, destinationPath);
        previousMoved = false;
      }
      throw error;
    }

    if (previousMoved) {
      await rm(previousPath, { recursive: true, force: true });
      previousMoved = false;
    }
  } finally {
    await rm(preparedPath, { recursive: true, force: true });
    if (previousMoved && !(await pathExists(destinationPath))) {
      await rename(previousPath, destinationPath);
    }
  }
}

async function executeImportInstall(input) {
  if (input?.confirm !== true) {
    throw new Error("需要明确确认后才能安装到技能目录。");
  }
  const plan = await planImportInstall(input);
  const completed = [];
  for (const action of plan.actions) {
    if (action.action === "noop") {
      completed.push({ ...action, result: "skipped" });
      continue;
    }
    const sourcePath = expandHome(action.source);
    const destinationPath = expandHome(action.destination);
    const backupPath = action.backup ? expandHome(action.backup) : null;
    await materializeSkillDirectory({
      sourcePath,
      destinationPath,
      backupPath,
      mode: "copy",
    });
    completed.push({ ...action, result: "completed" });
  }

  const historyEntry = {
    id: createHash("sha1")
      .update(`${Date.now()}:${plan.skillName}:import`)
      .digest("hex")
      .slice(0, 12),
    type: "import",
    skillName: plan.skillName,
    mode: "copy",
    targets: completed
      .filter((action) => action.result === "completed")
      .map((action) => action.agentName),
    backups: completed.filter((action) => action.backup).length,
    createdAt: new Date().toISOString(),
  };
  await mkdir(STATE_DIRECTORY, { recursive: true });
  await appendFile(HISTORY_FILE, `${JSON.stringify(historyEntry)}\n`, "utf8");
  invalidateScanCache();
  return { ...plan, actions: completed, historyEntry };
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function planSync({
  sourceInstanceId,
  targetAgentIds,
  mode = "copy",
}) {
  const config = await loadConfig();
  const scan = await getScan(true);
  const resolved = resolveInstance(scan, sourceInstanceId);
  if (!resolved) throw new Error("找不到同步来源，请重新扫描后再试。");
  const targetIds = [
    ...new Set(Array.isArray(targetAgentIds) ? targetAgentIds : []),
  ].slice(0, 24);
  const backupGroup = timestampLabel();
  const actions = [];

  for (const targetAgentId of targetIds) {
    const agent = config.agents.find((item) => item.id === targetAgentId);
    if (!agent) continue;
    const existing = resolved.skill.instances.find(
      (instance) => instance.agentId === targetAgentId,
    );
    if (existing?.readOnly) throw new Error(`${agent.name} 的该技能由客户端或插件管理，请在原客户端更新，管理器仅提供读取。`);
    const existingPath = existing ? expandHome(existing.path) : null;
    const rootPath =
      (existingPath
        ? agent.paths
            .map(expandHome)
            .find((candidateRoot) => isWithin(candidateRoot, existingPath))
        : null) || expandHome(agent.paths[0]);
    const destinationPath = existing
      ? existingPath
      : path.join(rootPath, resolved.instance.directoryName);
    if (!isStrictlyWithin(rootPath, destinationPath)) {
      throw new Error(
        `目标必须位于 ${agent.name} 的技能目录内，不能替换技能根目录本身。`,
      );
    }
    const exists = await pathExists(destinationPath);
    const samePath =
      path.resolve(destinationPath) === path.resolve(resolved.instance.absolutePath);
    const sameHash = existing?.hash === resolved.instance.hash;
    const action = samePath || (sameHash && mode === "copy")
      ? "noop"
      : exists
        ? "replace"
        : "create";
    const backupPath =
      action === "replace"
        ? path.join(
            BACKUP_DIRECTORY,
            backupGroup,
            agent.id,
            path.basename(destinationPath),
          )
        : null;
    actions.push({
      agentId: agent.id,
      agentName: agent.name,
      action,
      mode: mode === "symlink" ? "symlink" : "copy",
      source: compactHome(resolved.instance.absolutePath),
      destination: compactHome(destinationPath),
      backup: backupPath ? compactHome(backupPath) : null,
      sourceHash: resolved.instance.shortHash,
      targetHash: existing?.shortHash || null,
      identical: sameHash,
    });
  }

  return {
    skillId: resolved.skill.id,
    skillName: resolved.skill.name,
    sourceInstanceId,
    sourceAgentId: resolved.instance.agentId,
    mode: mode === "symlink" ? "symlink" : "copy",
    actions,
    backupGroup,
  };
}

async function executeSync(input) {
  if (input?.confirm !== true) {
    throw new Error("需要明确确认后才能写入技能目录。");
  }
  const plan = await planSync(input);
  const completed = [];
  for (const action of plan.actions) {
    if (action.action === "noop") {
      completed.push({ ...action, result: "skipped" });
      continue;
    }
    const sourcePath = expandHome(action.source);
    const destinationPath = expandHome(action.destination);
    const backupPath = action.backup ? expandHome(action.backup) : null;
    await materializeSkillDirectory({
      sourcePath,
      destinationPath,
      backupPath,
      mode: action.mode,
    });
    completed.push({ ...action, result: "completed" });
  }

  const historyEntry = {
    id: createHash("sha1")
      .update(`${Date.now()}:${plan.skillName}`)
      .digest("hex")
      .slice(0, 12),
    type: "sync",
    skillName: plan.skillName,
    mode: plan.mode,
    targets: completed
      .filter((action) => action.result === "completed")
      .map((action) => action.agentName),
    backups: completed.filter((action) => action.backup).length,
    createdAt: new Date().toISOString(),
  };
  await mkdir(STATE_DIRECTORY, { recursive: true });
  await appendFile(HISTORY_FILE, `${JSON.stringify(historyEntry)}\n`, "utf8");
  invalidateScanCache();
  return { ...plan, actions: completed, historyEntry };
}

function jsonResponse(response, statusCode, payload, origin) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(payload));
}

function binaryResponse(response, statusCode, payload, headers = {}, origin) {
  const responseHeaders = {
    "content-type": "application/octet-stream",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    responseHeaders["access-control-allow-origin"] = origin;
    responseHeaders["access-control-expose-headers"] = "content-disposition";
    responseHeaders.vary = "Origin";
  }
  response.writeHead(statusCode, responseHeaders);
  response.end(payload);
}

async function readRequestBuffer(request, limit = SKILL_ARCHIVE_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("上传文件过大。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("请求内容过大。");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function originAllowed(request) {
  const origin = request.headers.origin;
  return !origin || ALLOWED_ORIGINS.has(origin);
}

async function revealPath(instanceId) {
  const scan = await getScan();
  const resolved = resolveInstance(scan, instanceId);
  if (!resolved) throw new Error("找不到这个技能目录。");
  const targetPath = resolved.instance.absolutePath;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", ["-R", targetPath]]
      : process.platform === "win32"
        ? ["explorer.exe", [targetPath]]
        : ["xdg-open", [targetPath]];

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function handleRequest(request, response) {
  const origin = request.headers.origin;
  if (!originAllowed(request)) {
    jsonResponse(response, 403, { error: "不允许的请求来源。" });
    return;
  }
  if (request.method === "OPTIONS") {
    const headers = {
      "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
      "access-control-allow-headers":
        "content-type,x-skill-manager-confirm,x-skill-filename",
      "access-control-max-age": "600",
    };
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers.vary = "Origin";
    }
    response.writeHead(204, headers);
    response.end();
    return;
  }

  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      jsonResponse(
        response,
        200,
        { ok: true, service: "Skill Control local service" },
        origin,
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/config") {
      jsonResponse(response, 200, await loadConfig(), origin);
      return;
    }
    if (request.method === "PUT" && requestUrl.pathname === "/api/config") {
      const config = await saveConfig(await readRequestBody(request));
      jsonResponse(response, 200, config, origin);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/scan") {
      const force = requestUrl.searchParams.get("force") === "1";
      jsonResponse(response, 200, await getScan(force), origin);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/connectors") {
      jsonResponse(response, 200, await scanSmartOrderConnectors(HOME_DIRECTORY), origin);
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/capabilities"
    ) {
      const force = requestUrl.searchParams.get("force") === "1";
      jsonResponse(
        response,
        200,
        await scanCapabilityCatalog(HOME_DIRECTORY, { force }),
        origin,
      );
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/capability-files"
    ) {
      const capabilityIdValue = requestUrl.searchParams.get("capabilityId");
      const capability = await resolveCapability(capabilityIdValue);
      if (!capability) throw new Error("找不到这个专家或 Agent 配置。");
      jsonResponse(
        response,
        200,
        {
          ...(await listCapabilityFiles(capability)),
          capability: publicCapability(capability),
        },
        origin,
      );
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/capability-file"
    ) {
      const capabilityIdValue = requestUrl.searchParams.get("capabilityId");
      const requestedPath = requestUrl.searchParams.get("path");
      const capability = await resolveCapability(capabilityIdValue);
      if (!capability) throw new Error("找不到这个专家或 Agent 配置。");
      jsonResponse(
        response,
        200,
        await readCapabilityFile(capability, requestedPath),
        origin,
      );
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/capability-asset"
    ) {
      const capabilityIdValue = requestUrl.searchParams.get("capabilityId");
      const requestedPath = requestUrl.searchParams.get("path");
      const capability = await resolveCapability(capabilityIdValue);
      if (!capability) throw new Error("找不到这个专家或 Agent 配置。");
      if (
        isSensitiveCapabilityPath(requestedPath) ||
        (capability.allowedFiles &&
          !capability.allowedFiles.has(String(requestedPath || "")))
      ) {
        throw new Error("这个 Agent 配置文件未开放预览。");
      }
      const asset = await readSkillImageAsset(
        capability.rootPath,
        requestedPath,
      );
      binaryResponse(
        response,
        200,
        asset.buffer,
        {
          "content-type": asset.mimeType,
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
          "cache-control": "private, max-age=300",
          "content-security-policy":
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
          "cross-origin-resource-policy": "same-site",
        },
        origin,
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/skill-diff") {
      const leftInstanceId = requestUrl.searchParams.get("leftInstanceId");
      const rightInstanceId = requestUrl.searchParams.get("rightInstanceId");
      const scan = await getScan();
      const leftResolved = resolveInstance(scan, leftInstanceId);
      const rightResolved = resolveInstance(scan, rightInstanceId);
      if (!leftResolved || !rightResolved) {
        throw new Error("找不到需要比较的技能版本。");
      }
      if (leftResolved.skill.id !== rightResolved.skill.id) {
        throw new Error("只能比较同一个技能的不同安装版本。");
      }
      const comparison = await compareSkillDirectories(
        leftResolved.instance.absolutePath,
        rightResolved.instance.absolutePath,
      );
      const publicInstance = (instance) => ({
        id: instance.id,
        agentId: instance.agentId,
        agentName: instance.agentName,
        shortHash: instance.shortHash,
        modifiedAt: instance.modifiedAt,
        fileCount: instance.fileCount,
        byteCount: instance.byteCount,
      });
      jsonResponse(
        response,
        200,
        {
          ...comparison,
          skillId: leftResolved.skill.id,
          skillName: leftResolved.skill.name,
          left: publicInstance(leftResolved.instance),
          right: publicInstance(rightResolved.instance),
        },
        origin,
      );
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/skill-diff-file"
    ) {
      const leftInstanceId = requestUrl.searchParams.get("leftInstanceId");
      const rightInstanceId = requestUrl.searchParams.get("rightInstanceId");
      const requestedPath = requestUrl.searchParams.get("path");
      const scan = await getScan();
      const leftResolved = resolveInstance(scan, leftInstanceId);
      const rightResolved = resolveInstance(scan, rightInstanceId);
      if (!leftResolved || !rightResolved) {
        throw new Error("找不到需要比较的技能版本。");
      }
      if (leftResolved.skill.id !== rightResolved.skill.id) {
        throw new Error("只能比较同一个技能的不同安装版本。");
      }
      jsonResponse(
        response,
        200,
        await readSkillDirectoryDiffFile(
          leftResolved.instance.absolutePath,
          rightResolved.instance.absolutePath,
          requestedPath,
        ),
        origin,
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/skill-files") {
      const instanceId = requestUrl.searchParams.get("instanceId");
      const scan = await getScan();
      const resolved = resolveInstance(scan, instanceId);
      if (!resolved) throw new Error("找不到这个技能目录。");
      const listing = await listSkillFiles(resolved.instance.absolutePath);
      jsonResponse(
        response,
        200,
        {
          ...listing,
          instance: {
            id: resolved.instance.id,
            agentId: resolved.instance.agentId,
            agentName: resolved.instance.agentName,
            path: resolved.instance.path,
            shortHash: resolved.instance.shortHash,
          },
        },
        origin,
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/skill-file") {
      const instanceId = requestUrl.searchParams.get("instanceId");
      const requestedPath = requestUrl.searchParams.get("path");
      const scan = await getScan();
      const resolved = resolveInstance(scan, instanceId);
      if (!resolved) throw new Error("找不到这个技能目录。");
      jsonResponse(
        response,
        200,
        await readSkillFileContent(
          resolved.instance.absolutePath,
          requestedPath,
        ),
        origin,
      );
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/skill-asset"
    ) {
      const instanceId = requestUrl.searchParams.get("instanceId");
      const requestedPath = requestUrl.searchParams.get("path");
      const scan = await getScan();
      const resolved = resolveInstance(scan, instanceId);
      if (!resolved) throw new Error("找不到这个技能目录。");
      const asset = await readSkillImageAsset(
        resolved.instance.absolutePath,
        requestedPath,
      );
      binaryResponse(
        response,
        200,
        asset.buffer,
        {
          "content-type": asset.mimeType,
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
          "cache-control": "private, max-age=300",
          "content-security-policy":
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
          "cross-origin-resource-policy": "same-site",
        },
        origin,
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/export-skill") {
      const instanceId = requestUrl.searchParams.get("instanceId");
      const requestedFormat = requestUrl.searchParams.get("format") || "skill";
      if (!["skill", "zip"].includes(requestedFormat)) {
        throw new Error("不支持的导出格式。");
      }
      const scan = await getScan();
      const resolved = resolveInstance(scan, instanceId);
      if (!resolved) throw new Error("找不到要打包的技能目录。");
      const archive = await createSkillArchive(
        resolved.instance.absolutePath,
        resolved.instance.directoryName,
        requestedFormat,
      );
      const extension = requestedFormat === "zip" ? "zip" : "skill";
      const filename = `${sanitizeSkillDirectoryName(
        resolved.instance.directoryName,
      )}.${extension}`;
      binaryResponse(
        response,
        200,
        archive,
        {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        },
        origin,
      );
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/import-skill") {
      const encodedFilename = String(
        request.headers["x-skill-filename"] || "imported.skill",
      );
      let originalFilename = "imported.skill";
      try {
        originalFilename = decodeURIComponent(encodedFilename);
      } catch {
        originalFilename = "imported.skill";
      }
      const imported = await stageSkillArchive(
        await readRequestBuffer(request),
        originalFilename,
      );
      const publicImported = { ...imported };
      delete publicImported.rootPath;
      jsonResponse(response, 200, publicImported, origin);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/import-file") {
      const imported = resolveImportedSkill(
        requestUrl.searchParams.get("importId"),
      );
      jsonResponse(
        response,
        200,
        await readSkillFileContent(
          imported.rootPath,
          requestUrl.searchParams.get("path"),
        ),
        origin,
      );
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/import-asset"
    ) {
      const imported = resolveImportedSkill(
        requestUrl.searchParams.get("importId"),
      );
      const asset = await readSkillImageAsset(
        imported.rootPath,
        requestUrl.searchParams.get("path"),
      );
      binaryResponse(
        response,
        200,
        asset.buffer,
        {
          "content-type": asset.mimeType,
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
          "cache-control": "private, max-age=300",
          "content-security-policy":
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
          "cross-origin-resource-policy": "same-site",
        },
        origin,
      );
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/import-install"
    ) {
      const body = await readRequestBody(request);
      if (body.dryRun === false) {
        if (request.headers["x-skill-manager-confirm"] !== "yes") {
          throw new Error("缺少安装确认标记。");
        }
        jsonResponse(response, 200, await executeImportInstall(body), origin);
      } else {
        jsonResponse(response, 200, await planImportInstall(body), origin);
      }
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/sync") {
      const body = await readRequestBody(request);
      if (body.dryRun === false) {
        if (request.headers["x-skill-manager-confirm"] !== "yes") {
          throw new Error("缺少同步确认标记。");
        }
        jsonResponse(response, 200, await executeSync(body), origin);
      } else {
        jsonResponse(response, 200, await planSync(body), origin);
      }
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/reveal") {
      const body = await readRequestBody(request);
      await revealPath(body.instanceId);
      jsonResponse(response, 200, { ok: true }, origin);
      return;
    }
    jsonResponse(response, 404, { error: "接口不存在。" }, origin);
  } catch (error) {
    jsonResponse(
      response,
      400,
      { error: error?.message || "本地服务处理失败。" },
      origin,
    );
  }
}

export function startServer({
  port = SERVER_PORT,
  host = SERVER_HOST,
} = {}) {
  const server = http.createServer(handleRequest);
  server.listen(port, host, () => {
    const address = server.address();
    const activePort =
      typeof address === "object" && address ? address.port : port;
    console.log(
      `  ➜  Skills:  http://${host}:${activePort} (local only)`,
    );
  });
  return server;
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  startServer();
}
