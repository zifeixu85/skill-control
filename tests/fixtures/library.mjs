import { chmod, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { writeFixtureFile } from "./smartorder.mjs";

/**
 * This machine's library layout in a temporary home: ~/.agents/skills with reverse links
 * into ~/.codex/skills and an app folder, ~/.claude/skills as an independent mirror,
 * two diverged gstack checkouts, relative links from OpenClaw / Hermes / Kiro, and lark-cli
 * installs with shell snapshots and a Hermes launchd plist. Secrets contain "ZZ9".
 */

const skill = (name, body = "same") => `---\nname: ${name}\ndescription: ${name} fixture\n---\n# ${name}\n\n${body}\n`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export async function createLibraryHome(home) {
  const library = path.join(home, ".agents", "skills");
  const claude = path.join(home, ".claude", "skills");
  const codex = path.join(home, ".codex", "skills");
  await writeFixtureFile(library, "shared-a/SKILL.md", skill("shared-a"));
  await writeFixtureFile(library, "shared-b/SKILL.md", skill("shared-b", "library version"));
  await writeFixtureFile(library, "lark-shared/SKILL.md", skill("lark-shared"));
  await writeFixtureFile(library, "gstack/SKILL.md", skill("gstack"));
  await writeFixtureFile(library, "gstack/.git/HEAD", "ref: refs/heads/main\n");
  // Reverse links: the real folders live in Codex's own directory and an app folder.
  await writeFixtureFile(codex, "rev-1/SKILL.md", skill("rev-1"));
  await writeFixtureFile(home, "Library/Application Support/Cindy/skills/cindy/SKILL.md", skill("cindy"));
  await symlink(path.join(codex, "rev-1"), path.join(library, "rev-1"));
  await symlink(path.join(home, "Library/Application Support/Cindy/skills/cindy"), path.join(library, "cindy"));
  // Claude: an independent mirror with the same names (one drifted), plus the same reverse link.
  await writeFixtureFile(claude, "shared-a/SKILL.md", skill("shared-a"));
  await writeFixtureFile(claude, "shared-b/SKILL.md", skill("shared-b", "claude edit"));
  await writeFixtureFile(claude, "only-claude/SKILL.md", skill("only-claude"));
  await writeFixtureFile(claude, "gstack/SKILL.md", skill("gstack", "diverged"));
  await writeFixtureFile(claude, "gstack/.git/HEAD", "ref: refs/heads/main\n");
  await writeFixtureFile(claude, "gstack/sub/gstack-x/SKILL.md", skill("gstack-x"));
  await symlink(path.join(codex, "rev-1"), path.join(claude, "rev-1"));
  // Codex: an identical duplicate of a library skill, and links into Claude's gstack.
  await writeFixtureFile(codex, "shared-a/SKILL.md", skill("shared-a"));
  await symlink(path.join(claude, "gstack", "sub", "gstack-x"), path.join(codex, "gstack-x"));
  // OpenClaw / Hermes / Kiro: relative links into the library.
  for (const agentDir of [".openclaw/skills", ".hermes/skills", ".kiro/skills"]) {
    await mkdir(path.join(home, agentDir), { recursive: true });
    await symlink(path.join("..", "..", ".agents", "skills", "lark-shared"), path.join(home, agentDir, "lark-shared"));
  }
  await writeFixtureFile(home, ".openclaw/openclaw.json", "{}\n");
  await writeFixtureFile(home, ".hermes/config.yaml", "model:\n  default: x\nskills:\n  disabled: []\n");
  await writeFixtureFile(home, ".agents/.skill-lock.json", json({ version: 3, skills: { "lark-shared": { source: "open.feishu.cn", sourceType: "well-known", sourceUrl: "https://open.feishu.cn/.well-known/skills/lark-shared/SKILL.md", skillFolderHash: "", installedAt: "x", updatedAt: "x" } } }));
}

export const libraryAgents = (home) => {
  const agent = (id, paths) => ({ id, name: id, shortName: id.slice(0, 2), color: "#8fc9ef", paths });
  return [
    agent("codex", [path.join(home, ".codex", "skills"), path.join(home, ".agents", "skills")]),
    agent("claude", [path.join(home, ".claude", "skills")]),
    agent("openclaw", [path.join(home, ".openclaw", "skills")]),
    agent("hermes", [path.join(home, ".hermes", "skills")]),
    agent("kiro", [path.join(home, ".kiro", "skills")]),
  ];
};

/** lark-cli: npm global (Go binary behind run.js), Hermes' bundled copy, snapshots and plist. */
export async function createLarkCliHome(home) {
  const prefix = path.join(home, ".nvm", "versions", "node", "v24.0.0");
  const packageRoot = path.join(prefix, "lib", "node_modules", "@larksuite", "cli");
  await writeFixtureFile(packageRoot, "package.json", json({ name: "@larksuite/cli", version: "1.0.97" }));
  const runJs = await writeFixtureFile(packageRoot, "scripts/run.js", "#!/usr/bin/env node\nrequire('../bin/lark-cli')\n");
  await chmod(runJs, 0o755);
  // The native program: any executable that is not a "#!" script stands in for Mach-O.
  const native = await writeFixtureFile(packageRoot, "bin/lark-cli", Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  await chmod(native, 0o755);
  await mkdir(path.join(prefix, "bin"), { recursive: true });
  await symlink(path.join("..", "lib", "node_modules", "@larksuite", "cli", "scripts", "run.js"), path.join(prefix, "bin", "lark-cli"));
  const hermesRoot = path.join(home, ".hermes", "node", "lib", "node_modules", "@larksuite", "cli");
  await writeFixtureFile(hermesRoot, "package.json", json({ name: "@larksuite/cli", version: "1.0.56" }));
  const hermesRun = await writeFixtureFile(hermesRoot, "scripts/run.js", "#!/usr/bin/env node\n");
  await chmod(hermesRun, 0o755);
  await mkdir(path.join(home, ".hermes", "node", "bin"), { recursive: true });
  await symlink(path.join("..", "lib", "node_modules", "@larksuite", "cli", "scripts", "run.js"), path.join(home, ".hermes", "node", "bin", "lark-cli"));
  const nvmBin = path.join(prefix, "bin");
  // Codex: zsh array form; Claude: export PATH form; both contain nvm.
  await writeFixtureFile(home, ".codex/shell_snapshots/a.sh", `# snapshot\nexport -T PATH path=( ${home}/.local/bin ${nvmBin} /usr/bin /bin )\nexport OPENAI_API_KEY=ZZ9snapshotSecret01\n`);
  await writeFixtureFile(home, ".claude/shell-snapshots/snapshot-zsh-1.sh", `export PATH=${home}/.local/bin:${nvmBin}:/usr/bin:/bin\nexport GITHUB_TOKEN=ZZ9snapshotSecret02\n`);
  await writeFixtureFile(home, "Library/LaunchAgents/ai.hermes.gateway.plist", `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>EnvironmentVariables</key>
<dict>
<key>HERMES_HOME</key><string>${home}/.hermes</string>
<key>PATH</key><string>${home}/.hermes/node/bin:${home}/stale/dir:/usr/bin:/bin</string>
<key>OPENAI_API_KEY</key><string>ZZ9plistSecret03</string>
</dict>
</dict></plist>
`);
  // Local workspace configured with a keychain secret; no master.key.file; no hermes workspace.
  await writeFixtureFile(home, ".lark-cli/config.json", json({ apps: [{ appId: "cli_ZZ9appid04", appSecret: { source: "keychain", id: "ZZ9keychainId05" }, brand: "feishu" }] }));
  await writeFixtureFile(home, ".lark-cli/update-state.json", json({ latest_version: "1.0.97", checked_at: 1 }));
  // Allow rules: Claude has one, Codex and Gemini do not; Codex runs sandboxed.
  await writeFixtureFile(home, ".claude/settings.json", json({ permissions: { allow: ["Bash(lark-cli *)"], deny: [] }, env: { SECRET_TOKEN: "ZZ9claudeEnv06" } }));
  await writeFixtureFile(home, ".codex/config.toml", 'sandbox_mode = "workspace-write"\n');
  await writeFixtureFile(home, ".gemini/settings.json", json({ mcpServers: { x: { command: "npx", env: { API_KEY: "ZZ9geminiEnv07" } } } }));
  return { nvmBin, native };
}
