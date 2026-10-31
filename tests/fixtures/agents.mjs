import { writeFixtureFile } from "./smartorder.mjs";

/**
 * Install evidence for synthetic homes (server/agent-detection.mjs): a product file per
 * Agent, never a skills folder. Agents without it are not installed and not offered.
 */
const EVIDENCE = {
  codex: [".codex/config.toml", ""],
  claude: [".claude/settings.json", "{}\n"],
  workbuddy: [".workbuddy/settings.json", "{}\n"],
  cursor: [".cursor/argv.json", "{}\n"],
  gemini: [".gemini/settings.json", "{}\n"],
  kiro: [".kiro/settings.json", "{}\n"],
  trae: [".trae/settings.json", "{}\n"],
  codebuddy: [".codebuddy/settings.json", "{}\n"],
  copilot: [".copilot/config.json", "{}\n"],
  opencode: [".config/opencode/opencode.json", "{}\n"],
};

export async function markInstalled(home, ...agentIds) {
  for (const agentId of agentIds) {
    const evidence = EVIDENCE[agentId];
    if (!evidence) throw new Error(`no install evidence fixture for ${agentId}`);
    await writeFixtureFile(home, ...evidence);
  }
}
