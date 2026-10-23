import { asArray, asOptionalString, asRecord, asString } from "./parse";
import { persistentStore } from "./storage";

/**
 * How to fix an issue: an instruction to paste into the user's own AI (default — most people
 * aren't terminal users) and, when possible, terminal commands. Remedy = { commands?, prompt }.
 */

export interface RemedyCommand {
  label: string | null;
  command: string;
}

/** Something the app can do itself, e.g. { kind: "agent-update", id: "codex" } → 一键更新. */
export interface RemedyAction {
  kind: string;
  id: string;
}

export interface Remedy {
  prompt: string;
  commands: RemedyCommand[];
  action: RemedyAction | null;
}

export type RemedyMode = "ai" | "terminal";

export const REMEDY_MODE_LABELS: Record<RemedyMode, string> = { ai: "AI 指令", terminal: "终端指令" };

/** The chosen tab, remembered per user (localStorage, guarded). */
export const remedyModeStore = persistentStore<RemedyMode>("remedy-mode", "ai", (value) => value === "ai" || value === "terminal");

export function normalizeRemedy(value: unknown): Remedy | null {
  const record = asRecord(value);
  const prompt = asString(record.prompt).trim();
  const commands = asArray(record.commands)
    .map((item) => {
      const entry = asRecord(item);
      return { label: asOptionalString(entry.label), command: asString(entry.command).trim() };
    })
    .filter((entry) => entry.command);
  const rawAction = asRecord(record.action);
  const action = asString(rawAction.kind) && asString(rawAction.id) ? { kind: asString(rawAction.kind), id: asString(rawAction.id) } : null;
  return prompt || commands.length || action ? { prompt, commands, action } : null;
}

/** Tabs to offer: AI when there is a prompt, terminal only when there are commands. */
export function remedyModes(remedy: Remedy): RemedyMode[] {
  const modes: RemedyMode[] = [];
  if (remedy.prompt) modes.push("ai");
  if (remedy.commands.length) modes.push("terminal");
  return modes;
}

/** The preferred tab when this remedy has it, else whatever it does have. */
export function resolveMode(preferred: RemedyMode, remedy: Remedy): RemedyMode {
  const modes = remedyModes(remedy);
  return modes.includes(preferred) ? preferred : modes[0] || "ai";
}

/** Text to show and copy: the prompt, or commands with their labels as shell comments. */
export function remedyText(remedy: Remedy, mode: RemedyMode): string {
  if (mode === "ai") return remedy.prompt;
  return remedy.commands.map((entry) => (entry.label ? `# ${entry.label}\n${entry.command}` : entry.command)).join("\n\n");
}
