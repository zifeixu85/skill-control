import type { FileEntry } from "./types";

export interface TreeNode {
  name: string;
  path: string;
  type: FileEntry["type"];
  entry: FileEntry | null;
  children: TreeNode[];
}

const PRIMARY_FILES = ["skill.md", "soul.md", "identity.md", "readme.md", "plugin.json"];

function rank(node: TreeNode): number {
  const primary = PRIMARY_FILES.indexOf(node.name.toLowerCase());
  if (primary >= 0) return primary;
  return node.type === "directory" ? 10 : 20;
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((node) => ({ ...node, children: sortTree(node.children) }))
    .sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name, "en"));
}

/** Nests the flat listing from /api/skill-files (directories may be implicit). */
export function buildFileTree(entries: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "directory", entry: null, children: [] };
  const index = new Map<string, TreeNode>([["", root]]);
  const ensureDirectory = (directoryPath: string): TreeNode => {
    const existing = index.get(directoryPath);
    if (existing) return existing;
    const parts = directoryPath.split("/");
    const parent = ensureDirectory(parts.slice(0, -1).join("/"));
    const node: TreeNode = {
      name: parts[parts.length - 1],
      path: directoryPath,
      type: "directory",
      entry: null,
      children: [],
    };
    parent.children.push(node);
    index.set(directoryPath, node);
    return node;
  };
  for (const entry of entries) {
    const clean = entry.path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
    if (!clean) continue;
    if (entry.type === "directory") {
      const node = ensureDirectory(clean);
      node.entry = entry;
      continue;
    }
    const parts = clean.split("/");
    const parent = ensureDirectory(parts.slice(0, -1).join("/"));
    const node: TreeNode = { name: parts[parts.length - 1], path: clean, type: entry.type, entry, children: [] };
    parent.children.push(node);
    index.set(clean, node);
  }
  return sortTree(root.children);
}

/** First file worth opening: SKILL.md, SOUL.md, then the first Markdown, then any file. */
export function defaultFilePath(entries: FileEntry[], preferred?: string | null): string | null {
  const files = entries.filter((entry) => entry.type !== "directory");
  if (preferred && files.some((entry) => entry.path === preferred)) return preferred;
  const byName = (name: string) => files.find((entry) => entry.path.toLowerCase() === name);
  return (
    byName("skill.md")?.path ||
    byName("soul.md")?.path ||
    files.find((entry) => /\.(md|markdown)$/i.test(entry.path) && !entry.path.includes("/"))?.path ||
    files.find((entry) => /\.(md|markdown)$/i.test(entry.path))?.path ||
    files[0]?.path ||
    null
  );
}

/** Resolves a Markdown link relative to the file it appears in; null if it leaves the root. */
export function resolveRelativePath(fromFile: string, href: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) {
    return null;
  }
  let target: string;
  try {
    target = decodeURIComponent(href.split("#")[0].split("?")[0]);
  } catch {
    return null;
  }
  const base = target.startsWith("/") ? [] : fromFile.split("/").slice(0, -1);
  const parts = [...base];
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length ? parts.join("/") : null;
}

export const isImagePath = (value: string) => /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(value);
export const isMarkdownPath = (value: string) => /\.(md|markdown)$/i.test(value);

/** Directories that start open: the top level and any ancestor of the selected file. */
export function ancestorPaths(filePath: string | null): string[] {
  if (!filePath) return [];
  const parts = filePath.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}
