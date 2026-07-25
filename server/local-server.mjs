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
import { unzipSync, zipSync } from "fflate";

const HOME_DIRECTORY = homedir();
const STATE_DIRECTORY = path.join(HOME_DIRECTORY, ".agent-skill-manager");
const CONFIG_FILE = path.join(STATE_DIRECTORY, "config.json");
const HISTORY_FILE = path.join(STATE_DIRECTORY, "history.jsonl");
const BACKUP_DIRECTORY = path.join(STATE_DIRECTORY, "backups");
const IMPORT_DIRECTORY = path.join(STATE_DIRECTORY, "imports");
const SERVER_PORT = Number(process.env.SKILL_MANAGER_PORT || 43110);
const SERVER_HOST = process.env.SKILL_MANAGER_HOST || "127.0.0.1";
const SKILL_ENTRY_LIMIT = 1_500;
const SKILL_CONTENT_LIMIT = 2_000_000;
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
  ".git",
  ".svn",
  ".cache",
  ".DS_Store",
  "node_modules",
  "__pycache__",
]);

const AGENT_CATALOG = [
  {
    id: "codex",
    name: "Codex",
    shortName: "CX",
    color: "#d7f56d",
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
    color: "#ff7a4d",
    paths: ["~/.claude/skills"],
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    shortName: "WB",
    color: "#74c7ec",
    paths: ["~/.workbuddy/skills", "~/.workbuddy/connectors/skills"],
  },
  {
    id: "cursor",
    name: "Cursor",
    shortName: "CR",
    color: "#65d6b4",
    paths: ["~/.cursor/skills"],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    shortName: "GM",
    color: "#8ab4f8",
    paths: ["~/.gemini/skills"],
  },
  {
    id: "kiro",
    name: "Kiro",
    shortName: "KI",
    color: "#c6a5f7",
    paths: ["~/.kiro/skills"],
  },
  {
    id: "trae",
    name: "Trae",
    shortName: "TR",
    color: "#54d8d0",
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
    color: "#47d7a2",
    paths: ["~/.windsurf/skills"],
  },
  {
    id: "cline",
    name: "Cline",
    shortName: "CL",
    color: "#f2a94f",
    paths: ["~/.cline/skills"],
  },
  {
    id: "roo-code",
    name: "Roo Code",
    shortName: "RO",
    color: "#ff8a72",
    paths: ["~/.roo/skills", "~/.roo-code/skills"],
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    shortName: "CB",
    color: "#f0ce5a",
    paths: ["~/.codebuddy/skills"],
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    shortName: "QW",
    color: "#a98cf3",
    paths: ["~/.qwen/skills", "~/.qwen-code/skills"],
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    shortName: "GH",
    color: "#b1a3d8",
    paths: ["~/.copilot/skills", "~/.github/copilot/skills"],
  },
];

const DEFAULT_CONFIG = {
  version: 1,
  syncMode: "copy",
  agents: AGENT_CATALOG.slice(0, 3),
  visibleAgentIds: ["codex", "claude"],
};

let cachedScan = null;
let cachedScanAt = 0;
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

      return {
        id,
        name,
        shortName:
          String(agent?.shortName || name.slice(0, 2))
            .trim()
            .slice(0, 3)
            .toUpperCase() || "AG",
        color: /^#[0-9a-f]{6}$/i.test(String(agent?.color))
          ? String(agent.color)
          : ["#d7f56d", "#ff7a4d", "#74c7ec", "#f6ca45"][index % 4],
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

  return {
    version: 1,
    syncMode: input?.syncMode === "symlink" ? "symlink" : "copy",
    agents: finalAgents,
    visibleAgentIds,
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
        await Promise.all(agent.paths.map((agentPath) => pathExists(expandHome(agentPath))))
      ).some(Boolean);
      if (detected) detectedAgents.push(agent);
    }
    config = sanitizeConfig({
      ...DEFAULT_CONFIG,
      agents: detectedAgents.length ? detectedAgents : DEFAULT_CONFIG.agents,
    });
  }

  const configuredIds = new Set(config.agents.map((agent) => agent.id));
  const newlyDetected = [];
  for (const agent of AGENT_CATALOG) {
    if (configuredIds.has(agent.id)) continue;
    const detected = (
      await Promise.all(agent.paths.map((agentPath) => pathExists(expandHome(agentPath))))
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
  cachedScan = null;
  return config;
}

async function discoverSkillDirectories(rootPath, maxDepth = 4) {
  const discovered = [];

  async function visit(currentPath, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
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

async function fingerprintDirectory(directoryPath) {
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
        await visit(absolutePath, relativePath);
      } else if (entryStats.isSymbolicLink()) {
        fileCount += 1;
        hash.update(`link:${relativePath}:${await readlink(absolutePath)}`);
      } else if (entryStats.isFile()) {
        fileCount += 1;
        byteCount += entryStats.size;
        hash.update(`file:${relativePath}:${entryStats.size}:`);
        if (entryStats.size <= 512_000 && byteCount <= 4_000_000) {
          await new Promise((resolve) => {
            const stream = createReadStream(absolutePath);
            stream.on("data", (chunk) => hash.update(chunk));
            stream.on("error", () => resolve());
            stream.on("end", resolve);
          });
        } else {
          hash.update(String(entryStats.mtimeMs));
        }
      }
    }
  }

  await visit(directoryPath);
  return {
    hash: hash.digest("hex"),
    fileCount,
    byteCount,
    latestModified,
    truncated,
  };
}

async function describeSkillDirectory(skillPath, agent, rootPath) {
  const manifestPath = path.join(skillPath, "SKILL.md");
  const manifest = await readFile(manifestPath, "utf8");
  const parsed = parseFrontmatter(manifest, path.basename(skillPath));
  const fingerprint = await fingerprintDirectory(skillPath);
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
    excerpt: parsed.body.slice(0, 1200),
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

async function readHistory(limit = 16) {
  try {
    const content = await readFile(HISTORY_FILE, "utf8");
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

export async function scanAll(configInput) {
  const config = sanitizeConfig(configInput);
  const visibleAgentIds = new Set(config.visibleAgentIds);
  const visibleAgents = config.agents.filter((agent) =>
    visibleAgentIds.has(agent.id),
  );
  const agentResults = [];
  const allInstances = [];

  for (const agent of config.agents) {
    const roots = [];
    for (const configuredPath of agent.paths) {
      const rootPath = expandHome(configuredPath);
      const available = await pathExists(rootPath);
      const skillDirectories = available
        ? await discoverSkillDirectories(rootPath)
        : [];
      const instances = (
        await Promise.all(
          skillDirectories.map(async (skillPath) => {
            try {
              return await describeSkillDirectory(skillPath, agent, rootPath);
            } catch (error) {
              return {
                error: error?.message || "读取失败",
                agentId: agent.id,
                path: compactHome(skillPath),
              };
            }
          }),
        )
      ).filter((instance) => !instance.error);
      allInstances.push(...instances);
      roots.push({
        configuredPath,
        path: compactHome(rootPath),
        available,
        skillCount: instances.length,
      });
    }
    agentResults.push({
      ...agent,
      roots,
      available: roots.some((root) => root.available),
      visible: visibleAgentIds.has(agent.id),
      installationCount: allInstances.filter(
        (instance) => instance.agentId === agent.id,
      ).length,
    });
  }

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
        excerpt: newest.excerpt,
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
          return publicInstance;
        }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const skillsPerAgent = new Map(
    config.agents.map((agent) => [
      agent.id,
      new Set(
        allInstances
          .filter((instance) => instance.agentId === agent.id)
          .map((instance) => instance.name.trim().toLocaleLowerCase()),
      ).size,
    ]),
  );

  for (const agent of agentResults) {
    agent.skillCount = skillsPerAgent.get(agent.id) || 0;
  }

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
    history: await readHistory(),
    scannedAt: new Date().toISOString(),
  };
}

async function getScan(force = false) {
  if (!force && cachedScan && Date.now() - cachedScanAt < 10_000) {
    return cachedScan;
  }
  cachedScan = await scanAll(await loadConfig());
  cachedScanAt = Date.now();
  return cachedScan;
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

  const base = {
    path: relativePath,
    name: path.basename(relativePath),
    size: fileStats.size,
    modifiedAt: fileStats.mtime.toISOString(),
    language: languageForFile(relativePath),
  };
  if (fileStats.size > SKILL_CONTENT_LIMIT) {
    return {
      ...base,
      content: null,
      previewable: false,
      reason: `文件超过 ${Math.round(SKILL_CONTENT_LIMIT / 1_000_000)} MB，未在界面中加载。`,
    };
  }

  const buffer = await readFile(resolvedFile);
  if (!bufferLooksLikeText(buffer)) {
    return {
      ...base,
      content: null,
      previewable: false,
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

export async function createSkillArchive(directoryPath, directoryName) {
  const safeDirectoryName =
    sanitizeSkillDirectoryName(directoryName) || "exported-skill";
  const listing = await listSkillFiles(directoryPath);
  if (listing.truncated) {
    throw new Error(
      `.skill 导出最多支持 ${SKILL_ENTRY_LIMIT} 个条目，请先精简技能目录。`,
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
      throw new Error(".skill 导出不支持超过 25 MB 的单个文件。");
    }
    unpackedSize += fileStats.size;
    if (unpackedSize > SKILL_UNPACKED_LIMIT) {
      throw new Error(".skill 导出内容总大小不能超过 100 MB。");
    }
    archiveFiles[`${safeDirectoryName}/${entry.path}`] = await readFile(resolvedFile);
  }
  if (!archiveFiles[`${safeDirectoryName}/SKILL.md`]) {
    throw new Error("技能目录中没有可打包的 SKILL.md。");
  }
  const archive = Buffer.from(zipSync(archiveFiles, { level: 6 }));
  if (archive.length > SKILL_ARCHIVE_LIMIT) {
    throw new Error(".skill 导出文件超过 25 MB，请先精简技能内容。");
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
  cachedScan = null;
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
  cachedScan = null;
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
    if (request.method === "GET" && requestUrl.pathname === "/api/export-skill") {
      const instanceId = requestUrl.searchParams.get("instanceId");
      const scan = await getScan();
      const resolved = resolveInstance(scan, instanceId);
      if (!resolved) throw new Error("找不到要打包的技能目录。");
      const archive = await createSkillArchive(
        resolved.instance.absolutePath,
        resolved.instance.directoryName,
      );
      const filename = `${sanitizeSkillDirectoryName(
        resolved.instance.directoryName,
      )}.skill`;
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
