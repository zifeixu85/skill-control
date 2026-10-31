import { TIER_HOW, type LibraryData } from "./library";
import { asOptionalString, asRecord, asString } from "./parse";

/**
 * 设置 → Agent 集成: the `skill-control` command-line launcher and the bundled
 * `skill-control` skill, so installs made inside an Agent also go through the library.
 * GET /api/cli-launcher, POST /api/cli-launcher/install | /uninstall;
 * GET /api/library/companion-skill, POST /api/library/companion-skill/install.
 */

export interface LauncherStatus {
  /** False on platforms without a launcher yet (Windows); `reason` says why. */
  supported: boolean;
  reason: string | null;
  /** ~/.local/bin/skill-control */
  path: string;
  /** Ours and present. */
  installed: boolean;
  /** A file is there that Skill Control didn't write: never overwritten. */
  foreign: boolean;
  /** The script matches this version of the app (else 安装 refreshes it). */
  upToDate: boolean;
  /** The app (or Node) it starts. */
  runsWith: string | null;
  /** Whether that folder is on the shell PATH; null when unknown. */
  onPath: boolean | null;
  pathHint: string | null;
}

export interface CompanionStatus {
  name: string;
  /** The app ships the skill. */
  available: boolean;
  version: string | null;
  inLibrary: boolean;
  /** The library's copy is the bundled version. */
  upToDate: boolean;
  /** Per Agent: its tier and whether it sees the library's copy. */
  fanout: Record<string, { tier: string; state: string }>;
}

export const CLI_PATH = "~/.local/bin/skill-control";
export const COMPANION = "skill-control";

export const CLI_EXAMPLES = [
  { command: "skill-control status pdf-tools", note: "这个技能在哪些 Agent 里能用" },
  { command: "skill-control add ~/Downloads/my-skill --link primary", note: "放进技能库，再接入所有常用 Agent" },
  { command: "skill-control doctor", note: "解释哪些 Agent 看不到哪些技能、为什么" },
];

export function normalizeLauncher(raw: unknown): LauncherStatus {
  const record = asRecord(raw);
  return {
    supported: record.supported !== false,
    reason: asOptionalString(record.reason),
    path: asString(record.path, CLI_PATH),
    installed: record.installed === true,
    foreign: record.foreign === true,
    upToDate: record.upToDate === true,
    runsWith: asOptionalString(record.runsWith),
    onPath: typeof record.onPath === "boolean" ? record.onPath : null,
    pathHint: asOptionalString(record.pathHint),
  };
}

export function normalizeCompanion(raw: unknown): CompanionStatus {
  const record = asRecord(raw);
  const fanout: CompanionStatus["fanout"] = {};
  for (const [agentId, value] of Object.entries(asRecord(record.fanout))) {
    const item = asRecord(value);
    fanout[agentId] = { tier: asString(item.tier, "none"), state: asString(item.state, "none") };
  }
  return {
    name: asString(record.name, COMPANION),
    available: record.available !== false,
    version: asOptionalString(record.version),
    inLibrary: record.inLibrary === true,
    upToDate: record.upToDate === true,
    fanout,
  };
}

/** Per primary Agent: can it use the bundled skill-control skill? The library knows best. */
export function companionReach(
  library: LibraryData | null | undefined,
  status: CompanionStatus | null | undefined,
  primary: string[],
): { agentId: string; visible: boolean }[] {
  const entry = library?.entries.find((item) => item.name === COMPANION);
  return primary.map((agentId) => ({
    agentId,
    visible: (entry ? entry.fanout[agentId]?.state : status?.fanout[agentId]?.state) === "visible",
  }));
}

/** What 装到常用 Agent will do, per Agent, in the words of its 接入方式. */
export function companionPlanText(library: LibraryData | null | undefined, primary: string[], name: (id: string) => string): string {
  const tier = (agentId: string) => library?.agents.find((agent) => agent.agentId === agentId)?.tier || null;
  // An extra-directory Agent that already sees library skills needs nothing either.
  const configured = (agentId: string) => tier(agentId) === "config" && Boolean(library?.entries.some((entry) => entry.fanout[agentId]?.state === "visible"));
  const readers = primary
    .filter((id) => tier(id) === "native" || configured(id))
    .map((id) => (configured(id) ? `${name(id)} 已通过额外目录读取` : `${name(id)} 会自动读取`));
  const others = primary
    .filter((id) => tier(id) !== "native" && !configured(id))
    .map((id) => {
      const value = tier(id);
      return value && value !== "none" ? `${name(id)}（${TIER_HOW[value]}）` : name(id);
    });
  const parts = [`放进技能库 ~/.agents/skills/${COMPANION}`];
  if (others.length) parts.push(`再接入 ${others.join("、")}`);
  const tail = readers.length ? `；${readers.join("、")}，不用改动` : "";
  return `${parts.join("，")}${tail}。`;
}
