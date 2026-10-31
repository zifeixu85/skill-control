/**
 * Importing a folder (issue 16): the folder is zipped in the page and sent like a .zip, so it
 * goes through the same checks as every package (SKILL.md, size, paths). Nothing is read
 * from disk by path; .git, node_modules and Finder litter are left out.
 */

export interface FolderFile {
  /** "my-skill/scripts/run.sh" */
  path: string;
  size: number;
  file: Blob;
}

export const FOLDER_MAX_BYTES = 25_000_000;
export const FOLDER_MAX_FILES = 1_500;
const SKIPPED = /(^|\/)(\.git|node_modules|__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/u;

export interface FolderPlan {
  root: string;
  files: FolderFile[];
  skipped: number;
  error: string | null;
}

/** Which files go into the zip, under one top folder, and why a folder can't be imported. */
export function planFolder(files: FolderFile[]): FolderPlan {
  const clean = files.map((item) => ({ ...item, path: item.path.replace(/^\/+/u, "").split("\\").join("/") })).filter((item) => item.path);
  const kept = clean.filter((item) => !SKIPPED.test(item.path));
  const roots = new Set(kept.map((item) => item.path.split("/")[0]));
  const root = roots.size === 1 && kept.every((item) => item.path.includes("/")) ? [...roots][0] : "";
  const plan = (error: string | null): FolderPlan => ({ root: root || "skill", files: kept, skipped: clean.length - kept.length, error });
  if (!kept.length) return plan("文件夹是空的。");
  if (!kept.some((item) => /(^|\/)SKILL\.md$/iu.test(item.path))) return plan("文件夹里没有 SKILL.md，不像一个技能。");
  if (kept.length > FOLDER_MAX_FILES) return plan(`文件太多（${kept.length} 个），最多 ${FOLDER_MAX_FILES} 个。`);
  const bytes = kept.reduce((sum, item) => sum + item.size, 0);
  if (bytes > FOLDER_MAX_BYTES) return plan("文件夹超过 25 MB，无法导入。");
  return plan(null);
}

/** Files of a picked directory (<input webkitdirectory>), with their relative paths. */
export function filesFromInput(list: FileList | null): FolderFile[] {
  return [...(list || [])].map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, size: file.size, file }));
}

type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  file?: (success: (file: File) => void, failure: (error: unknown) => void) => void;
  createReader?: () => { readEntries: (success: (entries: Entry[]) => void, failure: (error: unknown) => void) => void };
};

/** A dropped folder (DataTransferItem.webkitGetAsEntry), walked recursively; null when it isn't one. */
export async function filesFromDrop(item: DataTransferItem | undefined): Promise<FolderFile[] | null> {
  const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null })?.webkitGetAsEntry?.();
  if (!entry?.isDirectory) return null;
  const out: FolderFile[] = [];
  const walk = async (node: Entry): Promise<void> => {
    if (out.length > FOLDER_MAX_FILES) return;
    if (node.isFile && node.file) {
      const file = await new Promise<File>((resolve, reject) => node.file?.(resolve, reject));
      out.push({ path: node.fullPath, size: file.size, file });
      return;
    }
    if (!node.isDirectory || !node.createReader || SKIPPED.test(node.fullPath)) return;
    const reader = node.createReader();
    // readEntries answers in batches until it returns an empty list.
    for (;;) {
      const batch = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walk(child);
    }
  };
  await walk(entry);
  return out;
}

/** The folder as a .zip File, ready for the normal import. */
export async function zipFolder(plan: FolderPlan): Promise<File> {
  const { zipSync } = await import("fflate");
  const content: Record<string, Uint8Array> = {};
  for (const item of plan.files) {
    const path = item.path.startsWith(`${plan.root}/`) ? item.path : `${plan.root}/${item.path}`;
    content[path] = new Uint8Array(await item.file.arrayBuffer());
  }
  const bytes = zipSync(content, { level: 6 });
  return new File([bytes], `${plan.root}.zip`, { type: "application/zip" });
}
