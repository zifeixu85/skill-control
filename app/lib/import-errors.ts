import { asArray, asRecord, asString } from "./parse";

/**
 * Import answers that need words or a choice (v0.3): 409 "multiple-skills" lists the skill
 * folders in the package (re-upload with `x-skill-root`), "no-skill" and "too-large" get
 * plain explanations.
 */

export interface SkillChoice {
  root: string;
  name: string;
}

type CodedError = { name?: string; code?: string | null; message?: string; details?: Record<string, unknown> };
const coded = (error: unknown): CodedError | null => (error && typeof error === "object" && (error as CodedError).name === "ApiError" ? (error as CodedError) : null);

/** The skills to choose from when a package or folder holds more than one; null otherwise. */
export function skillChoicesOf(error: unknown): SkillChoice[] | null {
  const apiError = coded(error);
  if (apiError?.code !== "multiple-skills") return null;
  const skills = asArray(apiError.details?.skills)
    .map((value) => {
      const item = asRecord(value);
      return { root: asString(item.root), name: asString(item.name, asString(item.root)) };
    })
    .filter((item) => item.root);
  return skills.length ? skills : null;
}

export function importErrorMessage(error: unknown, fallback: string): string {
  const apiError = coded(error);
  if (apiError?.code === "no-skill") return "没有找到 SKILL.md，这不像一个技能。技能文件夹里要有一个 SKILL.md。";
  if (apiError?.code === "too-large") return `太大了，没法导入${apiError.message ? `：${apiError.message}` : "。"}单个文件最多 25 MB，总共最多 100 MB。`;
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The desktop app's folder dialog, when the bridge has one (it returns a full path or null). */
export function desktopFolderPicker(): (() => Promise<string | null>) | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as { skillManagerDesktop?: { pickFolder?: () => Promise<unknown> } }).skillManagerDesktop;
  if (typeof bridge?.pickFolder !== "function") return null;
  return async () => {
    const picked = await bridge.pickFolder?.();
    return typeof picked === "string" && picked ? picked : null;
  };
}
