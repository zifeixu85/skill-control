import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileKindOf, inventoryCliTools, scriptDescription } from "../server/cli-inventory.mjs";
import { mentionsIn } from "../server/skill-mentions.mjs";
import { createLarkCliHome } from "./fixtures/library.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const LIMIT = { timeout: 30_000, skip: !POSIX };
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
const plist = (bundleId, version) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`;

async function executable(root, relative, content) {
  const file = await writeFixtureFile(root, relative, content);
  await chmod(file, 0o755);
  return file;
}

/** ~/.local/bin, nvm and Hermes npm globals, uv, bun, cargo and a fake Homebrew prefix. */
async function createCliHome(home) {
  await createLarkCliHome(home);
  const bin = path.join(home, ".local", "bin");
  await executable(bin, "whyai", `#!/usr/bin/env node\n// YAI CLI managed launcher token=ZZ9launcherToken01abc\n// installed under ${home}/.yai\nrequire("./x");\n`);
  await executable(bin, "agy", MACHO);
  await executable(bin, "uv", MACHO);
  await executable(bin, "opentoken.old", "#!/bin/sh\n");
  await executable(bin, "helper.bak", "#!/bin/sh\n");
  await writeFixtureFile(bin, "notes.txt", "not executable");
  // A link into an app bundle inside another app bundle (pcsuite.app/…/VClaw.app).
  const vclaw = path.join(home, "Applications", "pcsuite.app", "Contents", "Resources", "VClaw", "VClaw.app");
  await writeFixtureFile(vclaw, "Contents/Info.plist", plist("com.example.vclaw", "1.5.6"));
  await symlink(await executable(vclaw, "Contents/Resources/cli/vclaw-cli", "#!/bin/sh\n"), path.join(bin, "vclaw-cli"));
  // Claude Code's native installer: ~/.local/bin/claude → versions/<version>.
  await symlink(await executable(home, ".local/share/claude/versions/2.1.302", MACHO), path.join(bin, "claude"));
  // uv tool with its receipt and dist-info; a uv-managed Python.
  const tool = path.join(home, ".local", "share", "uv", "tools", "specify-cli");
  await writeFixtureFile(tool, "lib/python3.12/site-packages/specify_cli-0.12.4.dist-info/METADATA", "Name: specify-cli\n");
  await writeFixtureFile(tool, "uv-receipt.toml", `[tool]\nrequirements = [{ name = "specify-cli" }]\nentrypoints = [{ name = "specify", install-path = "${bin}/specify", from = "specify-cli" }]\n`);
  await symlink(await executable(tool, "bin/specify", "#!/usr/bin/python3\n# specify\n"), path.join(bin, "specify"));
  await symlink(await executable(home, ".local/share/uv/python/cpython-3.12.13-macos-aarch64-none/bin/python3.12", MACHO), path.join(bin, "python3.12"));
  // nvm npm globals: an AI package by keywords, a plain one, npm itself (skipped).
  const node = path.join(home, ".nvm", "versions", "node", "v24.0.0");
  await writeFixtureFile(node, "lib/node_modules/agent-browser/package.json", JSON.stringify({ name: "agent-browser", version: "0.34.0", keywords: ["ai-agent", "browser"], description: "Browser for agents" }));
  await symlink(await executable(node, "lib/node_modules/agent-browser/bin/agent-browser", MACHO), path.join(node, "bin", "agent-browser"));
  await writeFixtureFile(node, "lib/node_modules/cowsay/package.json", JSON.stringify({ name: "cowsay", version: "1.6.0" }));
  await symlink(await executable(node, "lib/node_modules/cowsay/cli.js", "#!/usr/bin/env node\n"), path.join(node, "bin", "cowsay"));
  await writeFixtureFile(node, "lib/node_modules/npm/package.json", JSON.stringify({ name: "npm", version: "11.0.0" }));
  await symlink(await executable(node, "lib/node_modules/npm/bin/npm-cli.js", "#!/usr/bin/env node\n"), path.join(node, "bin", "npm"));
  await executable(node, "bin/node", MACHO);
  // Hermes' own node: a todoist CLI linked from ~/.local/bin as well.
  const hermes = path.join(home, ".hermes", "node");
  await writeFixtureFile(hermes, "lib/node_modules/@doist/todoist-cli/package.json", JSON.stringify({ name: "@doist/todoist-cli", version: "1.75.3" }));
  await symlink(await executable(hermes, "lib/node_modules/@doist/todoist-cli/dist/td.js", "#!/usr/bin/env node\n"), path.join(hermes, "bin", "td"));
  await symlink(path.join(hermes, "bin", "td"), path.join(bin, "td"));
  // bun and cargo.
  await executable(home, ".bun/bin/bun", MACHO);
  await executable(home, ".cargo/bin/rg", MACHO);
  await writeFixtureFile(home, ".cargo/.crates.toml", '[v1]\n"ripgrep 14.1.0 (registry+https://github.com/rust-lang/crates.io-index)" = ["rg"]\n');
  // A Homebrew-like prefix: only commands a skill or an Agent names are listed.
  const brew = path.join(home, "brew");
  await mkdir(path.join(brew, "bin"), { recursive: true });
  await symlink(await executable(brew, "Cellar/ffmpeg/8.1.1/bin/ffmpeg", MACHO), path.join(brew, "bin", "ffmpeg"));
  await symlink(await executable(brew, "Cellar/jq/1.8.0/bin/jq", MACHO), path.join(brew, "bin", "jq"));
  await symlink(await executable(brew, "Cellar/coreutils/9.11/bin/factor", MACHO), path.join(brew, "bin", "factor"));
  // Skills: whyai and ffmpeg as commands; "factor" only as an English word.
  const skill = await writeFixtureFile(home, ".claude/skills/media/SKILL.md", "---\nname: media\n---\nThink about every factor.\n\n```bash\n$ ffmpeg -i in.mp4 out.gif\nwhyai --help | head\n```\nUse `lark-cli docs +fetch` too.\n");
  // Claude allows jq: an Agent names it.
  await writeFixtureFile(home, ".claude/settings.json", JSON.stringify({ permissions: { allow: ["Bash(lark-cli *)", "Bash(jq:*)"] } }));
  return { bin, brew, skillFiles: [{ file: skill, name: "media" }] };
}

async function setup(context) {
  const home = await mkdtemp(path.join(tmpdir(), "cli-inventory-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const fixture = await createCliHome(home);
  const stateDirectory = path.join(home, ".agent-skill-manager");
  const run = () =>
    inventoryCliTools({
      homeDirectory: home,
      homes: [home],
      stateDirectory,
      skillFiles: fixture.skillFiles,
      agents: ["claude", "codex", "hermes"],
      systemPrefixes: [fixture.brew],
    });
  return { home, stateDirectory, run, ...fixture };
}

test("inventory: every user-installed command, its owner, kind and AI relevance, without running anything", LIMIT, async (context) => {
  const { home, stateDirectory, run } = await setup(context);
  const { tools, summary } = await run();
  const byId = Object.fromEntries(tools.map((tool) => [tool.id, tool]));
  assert.deepEqual(Object.keys(byId).sort(), ["agent-browser", "agy", "bun", "claude", "cowsay", "ffmpeg", "jq", "lark-cli", "lark-cli~2", "python3.12", "rg", "specify", "td", "uv", "vclaw-cli", "whyai"]);
  assert.equal(summary.hiddenBackups, 2, "*.bak and *.old are hidden");
  assert.deepEqual([summary.total, summary.aiRelated], [tools.length, tools.filter((tool) => tool.aiRelated).length]);

  // whyai: a node launcher script in ~/.local/bin, described by its redacted comment.
  const whyai = byId.whyai;
  assert.deepEqual([whyai.path, whyai.source, whyai.kind, whyai.interpreter, whyai.owner], ["~/.local/bin/whyai", "local-bin", "script", "node", null]);
  assert.match(whyai.description, /^YAI CLI managed launcher token=•••••• installed under ~\/\.yai$/u);
  assert.deepEqual([whyai.aiRelated, whyai.aiReasons, whyai.referencedBySkills], [true, ["skill-reference", "local-bin"], ["media"]]);
  assert.equal(typeof whyai.size, "number");
  assert.ok(Date.parse(whyai.mtime));

  // Owners: app bundle (innermost), native install, uv tool, npm packages (nvm and Hermes), cargo, Homebrew.
  assert.deepEqual(byId["vclaw-cli"].owner, { type: "app", name: "VClaw", version: "1.5.6", bundleId: "com.example.vclaw" });
  assert.deepEqual([byId["vclaw-cli"].kind, byId["vclaw-cli"].aiReasons], ["symlink", ["ai-app", "local-bin"]]);
  assert.deepEqual(byId.claude.owner, { type: "native", name: "claude", version: "2.1.302" });
  assert.equal(byId.claude.target, "~/.local/share/claude/versions/2.1.302");
  assert.deepEqual(byId.specify.owner, { type: "uv", name: "specify-cli", version: "0.12.4" });
  assert.deepEqual([byId["python3.12"].owner, byId["python3.12"].aiRelated], [{ type: "uv", name: "cpython", version: "3.12.13" }, false]);
  assert.deepEqual([byId.uv.aiRelated, byId.agy.aiRelated, byId.agy.kind], [false, true, "binary"]);
  assert.deepEqual(byId["agent-browser"].owner, { type: "npm", name: "agent-browser", version: "0.34.0" });
  assert.ok(byId["agent-browser"].aiReasons.includes("npm-keywords"));
  assert.equal(byId["agent-browser"].description, "Browser for agents");
  assert.deepEqual([byId.cowsay.aiRelated, byId.cowsay.source], [false, "npm"]);
  assert.equal(byId.npm, undefined, "npm and node ship with Node");
  assert.deepEqual([byId.td.owner, byId.td.links], [{ type: "npm", name: "@doist/todoist-cli", version: "1.75.3" }, ["~/.hermes/node/bin/td"]]);
  assert.deepEqual([byId["lark-cli"].owner.version, byId["lark-cli~2"].owner.version], ["1.0.97", "1.0.56"]);
  assert.deepEqual(byId.rg.owner, { type: "cargo", name: "ripgrep", version: "14.1.0" });
  assert.deepEqual([byId.ffmpeg.source, byId.ffmpeg.owner, byId.ffmpeg.referencedBySkills], ["homebrew", { type: "homebrew", name: "ffmpeg", version: "8.1.1" }, ["media"]]);
  assert.deepEqual([byId.jq.referencedCount, byId.jq.aiRelated], [0, false], "named by an allow rule only");
  assert.equal(byId.factor, undefined, "a prose word is not a mention");

  // Per-Agent availability from each Agent's PATH source, and its allow rule.
  const claudeRow = (tool) => tool.agents.find((row) => row.agentId === "claude");
  assert.deepEqual([claudeRow(whyai).available, claudeRow(whyai).allowed], [true, "missing"]);
  assert.deepEqual([claudeRow(byId["lark-cli"]).available, claudeRow(byId["lark-cli"]).allowed], [true, "present"]);
  assert.equal(claudeRow(byId["lark-cli~2"]).available, false, "Claude finds the nvm copy first");
  assert.match(claudeRow(byId["lark-cli~2"]).detail, /另一份/u);
  assert.equal(byId["lark-cli~2"].agents.find((row) => row.agentId === "hermes").available, true, "Hermes' launchd PATH has its own node first");

  const text = JSON.stringify({ tools, summary });
  assert.doesNotMatch(text, /ZZ9/u);
  assert.equal(text.includes(home), false);
  // The mention cache keeps only matched names, never skill text, and is reused.
  const cacheFile = path.join(stateDirectory, "cli-skill-mentions.json");
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
  const cache = await readFile(cacheFile, "utf8");
  assert.doesNotMatch(cache, /Think about|ffmpeg -i/u);
  const again = await run();
  assert.deepEqual(again.tools.map((tool) => tool.id), tools.map((tool) => tool.id));
});

test("mentions are command positions in code or distinctive words", () => {
  const names = new Set(["go", "digest", "claude", "lark-cli", "whyai", "git", "gh", "ffmpeg", "td", "python3"]);
  const text = "Go to the page and digest it. Use lark-cli or python3.\n```bash\n$ git status && gh pr list | grep x\nFOO=1 sudo ffmpeg -i a\nconst digest = hash(x)\n```\nRun `whyai --help` or `claude -p hi`. <td>cell</td>";
  assert.deepEqual(mentionsIn(text, names), ["claude", "ffmpeg", "gh", "git", "lark-cli", "python3", "whyai"]);
});

test("file kinds and descriptions come from the first bytes only", () => {
  assert.deepEqual(fileKindOf(Buffer.from("#!/usr/bin/env -S node --no-warnings\n")), { kind: "script", interpreter: "node" });
  assert.deepEqual(fileKindOf(Buffer.from("#!/bin/zsh\n")), { kind: "script", interpreter: "zsh" });
  assert.deepEqual(fileKindOf(MACHO), { kind: "binary", interpreter: null });
  assert.deepEqual(fileKindOf(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), { kind: "binary", interpreter: null });
  assert.equal(scriptDescription(Buffer.from("#!/bin/sh\n# -*- coding: utf-8 -*-\n#\n# Sync notes to the cloud\n# api_key: sk-ZZ9abcdefghijk012\nset -e\n# later comment\n"), []), "Sync notes to the cloud api_key: ••••••");
  assert.equal(scriptDescription(Buffer.from("#!/bin/sh\nexec x\n"), []), null);
});
