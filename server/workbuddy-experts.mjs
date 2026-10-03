import { createHash } from "node:crypto";
import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  frontmatterBlock,
  localizedText,
  parseFrontmatter,
  readNestedYamlScalar,
  readYamlScalar,
} from "./frontmatter.mjs";
import {
  compactHomePath,
  exists,
  findSkillDirectoryNames,
  homeVariants,
  isSensitiveFileName,
  isWithin,
  listDirectories,
  object,
  readBoundedJson,
  readBoundedText,
  realpathOrNull,
  resolveInside,
  text,
} from "./fs-safe.mjs";
import { readWorkBuddyExpertUsage, usageFor } from "./workbuddy-usage.mjs";

/**
 * WorkBuddy experts and expert teams, read-only.
 *
 * Sources (per marketplace): the downloaded/authored plugin under
 * `~/.workbuddy/plugins/marketplaces/<marketplace>/plugins/<name>/` and the installed
 * copy under `~/.workbuddy/plugins/cache/<marketplace>/<name>/<version>/` (an `.in_use`
 * marker means WorkBuddy is using it). `my-experts` are the user's own experts; their
 * distributable zip lives in `marketplaces/my-experts/dist/<name>.zip`.
 */

export const WORKBUDDY_MARKETPLACES = [
  { id: "my-experts", origin: "mine", label: "我的专家" },
  { id: "experts", origin: "market", label: "专家市场" },
];
const MEMBER_FILE_LIMIT = 2_000_000;
const MANIFEST_LIMIT = 512_000;
const FILE_COUNT_LIMIT = 1_500;
const EXPERT_LIMIT = 300;
const AVATAR_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".svg"]);
const IGNORED = new Set([".git", "node_modules", ".DS_Store"]);

export function capabilityId(productId, sourcePath) {
  return createHash("sha256")
    .update(`${productId}:${sourcePath}`)
    .digest("hex")
    .slice(0, 20);
}

const avatarId = (rootPath, relativePath) =>
  createHash("sha256")
    .update(`expert-avatar:${rootPath}:${relativePath}`)
    .digest("hex")
    .slice(0, 24);

/** Files that expert browsing never lists or previews (see isSensitiveFileName). */
export function isSensitiveCapabilityPath(relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/");
  // The expert manifest itself is shown, but only after default-deny masking.
  if (normalized === ".codebuddy-plugin/plugin.json") return false;
  return isSensitiveFileName(normalized);
}

function normalizeRelative(value) {
  return String(value || "")
    .replace(/^\.\//u, "")
    .split(path.sep)
    .join("/");
}

/** Registers an avatar image that the manifest references inside the expert directory. */
async function registerAvatar(rootPath, relativePath, assets) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized || !AVATAR_EXTENSIONS.has(path.extname(normalized).toLowerCase())) return null;
  if (!(await resolveInside(rootPath, normalized))) return null;
  const id = avatarId(rootPath, normalized);
  assets.set(id, { root: rootPath, relativePath: normalized });
  return id;
}

async function parseMember(pluginPath, relativePath) {
  const normalizedPath = normalizeRelative(relativePath);
  const extension = path.extname(normalizedPath).toLowerCase();
  if (
    !normalizedPath ||
    ![".md", ".markdown"].includes(extension) ||
    isSensitiveCapabilityPath(normalizedPath)
  ) {
    return null;
  }
  const resolvedFile = await resolveInside(pluginPath, normalizedPath);
  if (!resolvedFile) return null;
  const read = await readBoundedText(resolvedFile, MEMBER_FILE_LIMIT);
  if (read.status !== "ok") return null;
  const source = read.text;
  const parsed = parseFrontmatter(source, path.basename(normalizedPath, extension));
  const block = frontmatterBlock(source);
  return {
    id: createHash("sha256").update(resolvedFile).digest("hex").slice(0, 16),
    name: parsed.name,
    displayName: text(
      readNestedYamlScalar(block, "displayName", "zh") ||
        readNestedYamlScalar(block, "displayName", "en") ||
        parsed.displayName,
      80,
    ),
    profession: text(
      readNestedYamlScalar(block, "profession", "zh") ||
        readNestedYamlScalar(block, "profession", "en"),
      80,
    ),
    description: parsed.description,
    maxTurns: Number(readYamlScalar(block, "maxTurns")) || null,
    filePath: normalizedPath,
    avatar: null,
  };
}

async function countFiles(rootPath) {
  let count = 0;
  let hasReadme = false;
  async function visit(directory, depth) {
    if (count >= FILE_COUNT_LIMIT || depth > 8) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= FILE_COUNT_LIMIT) return;
      if (IGNORED.has(entry.name)) continue;
      const relative = path.relative(rootPath, path.join(directory, entry.name));
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), depth + 1);
      else if ((entry.isFile() || entry.isSymbolicLink()) && !isSensitiveCapabilityPath(relative)) {
        count += 1;
        if (relative === "README.md") hasReadme = true;
      }
    }
  }
  await visit(rootPath, 0);
  return { fileCount: count, hasReadme };
}

/** Real version directories of an installed expert, newest first, with the in-use marker. */
async function installedVersions(cacheDirectory, realPluginsRoot) {
  const versions = [];
  for (const version of await listDirectories(cacheDirectory, 50)) {
    const versionPath = path.join(cacheDirectory, version.name);
    const realVersion = await realpathOrNull(versionPath);
    if (!realVersion || !isWithin(realPluginsRoot, realVersion)) continue;
    const info = await lstat(versionPath).catch(() => null);
    versions.push({
      name: version.name,
      path: realVersion,
      inUse: await exists(path.join(versionPath, ".in_use")),
      mtimeMs: info?.mtimeMs || 0,
    });
  }
  return versions.sort(
    (left, right) => Number(right.inUse) - Number(left.inUse) || right.mtimeMs - left.mtimeMs,
  );
}

function localizedList(values, limit, length = 200) {
  return (Array.isArray(values) ? values : [])
    .map((value) => text(localizedText(value), length))
    .filter(Boolean)
    .slice(0, limit);
}

async function describeExpert({ name, rootPath, marketplace, versions, pluginsRoot, assets, usage, compact }) {
  const manifestPath = await resolveInside(rootPath, ".codebuddy-plugin/plugin.json");
  const manifestRead = manifestPath ? await readBoundedJson(manifestPath, MANIFEST_LIMIT) : null;
  if (manifestRead?.status !== "ok") return null;
  const manifest = object(manifestRead.value);
  const members = (
    await Promise.all(
      (Array.isArray(manifest.agents) ? manifest.agents.slice(0, 50) : []).map((agentPath) =>
        parseMember(rootPath, agentPath),
      ),
    )
  ).filter(Boolean);
  const declaredMembers = Array.isArray(manifest.members) ? manifest.members.slice(0, 50) : [];
  for (const member of members) {
    const declared = declaredMembers.find((item) => {
      const memberId = object(item).id;
      return (
        typeof memberId === "string" &&
        (memberId === member.name || memberId === path.basename(member.filePath, ".md"))
      );
    });
    if (declared?.avatar) member.avatar = await registerAvatar(rootPath, declared.avatar, assets);
  }
  const { fileCount, hasReadme } = await countFiles(rootPath);
  const isTeam =
    manifest.expertType === "team" || members.length > 1 || Array.isArray(manifest.members);
  const fallbackName = text(manifest.name, 128) || name;
  const declaredSkills = (Array.isArray(manifest.skills) ? manifest.skills : [])
    .filter((item) => typeof item === "string")
    .map((item) => text(path.basename(normalizeRelative(item)), 128))
    .filter(Boolean);
  const skillsRoot = await resolveInside(rootPath, "skills");
  const skills = declaredSkills.length
    ? [...new Set(declaredSkills)].slice(0, 100)
    : skillsRoot
      ? await findSkillDirectoryNames(skillsRoot, rootPath, { maxDepth: 1, limit: 100 })
      : [];
  const avatar =
    (typeof manifest.avatar === "string" && (await registerAvatar(rootPath, manifest.avatar, assets))) ||
    (await registerAvatar(rootPath, "avatars/expert.png", assets));
  const inUseVersion = versions.find((version) => version.inUse);
  const packaged = Boolean(
    (await lstat(path.join(pluginsRoot, "marketplaces", marketplace.id, "dist", `${name}.zip`)).catch(() => null))?.isFile(),
  );
  const manifestStats = await stat(manifestPath);
  return {
    id: capabilityId("workbuddy", rootPath),
    productId: "workbuddy",
    productName: "WorkBuddy",
    productShortName: "WB",
    productColor: "#78d4c7",
    kind: isTeam ? "expert-team" : "expert",
    kindLabel: isTeam ? "专家团" : "专家",
    origin: marketplace.origin,
    originLabel: marketplace.label,
    marketplace: marketplace.id,
    name: fallbackName,
    displayName: text(localizedText(manifest.displayName, fallbackName), 80) || fallbackName,
    description:
      text(localizedText(manifest.displayDescription, manifest.description || ""), 2_000) ||
      "暂无专家说明",
    profession: text(localizedText(manifest.profession), 80),
    version: text(String(manifest.version || ""), 64),
    category: text(manifest.categoryId, 64),
    tags: localizedList(manifest.tags, 8, 40),
    defaultPrompt: text(localizedText(manifest.defaultInitPrompt), 2_000) || null,
    quickPrompts: localizedList(manifest.quickPrompts, 12, 400),
    skills,
    members,
    memberCount: members.length,
    fileCount,
    connectorCount: Array.isArray(manifest.connectorIds) ? manifest.connectorIds.length : 0,
    skillCount: skills.length,
    avatar,
    packaged,
    installed: versions.length > 0,
    inUse: Boolean(inUseVersion),
    installedVersion: (inUseVersion || versions[0])?.name || null,
    used: usageFor(usage, fallbackName, name, manifest.agentName),
    model: "",
    sourcePath: compact(rootPath),
    primaryFilePath: members[0]?.filePath || (hasReadme ? "README.md" : ".codebuddy-plugin/plugin.json"),
    modifiedAt: manifestStats.mtime.toISOString(),
    rootPath,
    allowedFiles: null,
    virtualFiles: new Map(),
  };
}

function emptyProduct(sourcePath) {
  return {
    id: "workbuddy",
    name: "WorkBuddy",
    shortName: "WB",
    color: "#78d4c7",
    kindLabel: "专家 / 专家团",
    sourcePath,
    available: false,
    catalogCount: 0,
    itemCount: 0,
    memberCount: 0,
    items: [],
    warnings: [],
    assets: new Map(),
  };
}

export async function scanWorkBuddyExperts(homeDirectory = homedir(), { usage } = {}) {
  const pluginsRoot = path.join(homeDirectory, ".workbuddy", "plugins");
  const homes = [...(await homeVariants(homeDirectory)), ...(await homeVariants(homedir()))];
  const compact = (value) => compactHomePath(value, homes);
  const product = emptyProduct(compact(path.join(pluginsRoot, "marketplaces", "experts", "plugins")));
  const realPluginsRoot = await realpathOrNull(pluginsRoot);
  if (!realPluginsRoot) return product;

  const usageResult = usage === undefined ? await readWorkBuddyExpertUsage(homeDirectory) : usage;
  product.warnings.push(...(usageResult?.warnings || []));
  const catalog = await readBoundedJson(
    path.join(homeDirectory, ".workbuddy", "app", "cache", "experts", "manifest.json"),
    5_000_000,
  );
  if (catalog.status === "ok" && Array.isArray(catalog.value?.experts)) {
    product.catalogCount = catalog.value.experts.length;
  }

  for (const marketplace of WORKBUDDY_MARKETPLACES) {
    const sourceRoot = path.join(pluginsRoot, "marketplaces", marketplace.id, "plugins");
    const cacheRoot = path.join(pluginsRoot, "cache", marketplace.id);
    const names = [
      ...new Set([
        ...(await listDirectories(sourceRoot, EXPERT_LIMIT)).map((entry) => entry.name),
        ...(await listDirectories(cacheRoot, EXPERT_LIMIT)).map((entry) => entry.name),
      ]),
    ].sort((left, right) => left.localeCompare(right));
    if (names.length) product.available = true;
    for (const name of names.slice(0, EXPERT_LIMIT)) {
      const versions = await installedVersions(path.join(cacheRoot, name), realPluginsRoot);
      const sourceDirectory = await realpathOrNull(path.join(sourceRoot, name));
      const candidates = [
        sourceDirectory && isWithin(realPluginsRoot, sourceDirectory) ? sourceDirectory : null,
        ...versions.map((version) => version.path),
      ].filter(Boolean);
      for (const rootPath of candidates) {
        const item = await describeExpert({
          name,
          rootPath,
          marketplace,
          versions,
          pluginsRoot,
          assets: product.assets,
          usage: usageResult?.usage,
          compact,
        });
        if (item) {
          product.items.push(item);
          break;
        }
      }
    }
  }
  product.itemCount = product.items.length;
  product.memberCount = product.items.reduce((sum, item) => sum + item.memberCount, 0);
  return product;
}
