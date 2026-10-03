import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHealthReport } from "../server/health-report.mjs";
import { scanAll } from "../server/local-server.mjs";
import { readMcpSources } from "../server/mcp-inventory.mjs";
import { createCommandLookup } from "../server/path-lookup.mjs";
import { createOpenClawHome } from "./fixtures/claw-hermes.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const skill = (name, description = `${name} fixture`) => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;

async function createHealthHome(home) {
  const codexSkills = path.join(home, ".codex", "skills");
  await writeFixtureFile(codexSkills, "good-skill/SKILL.md", skill("good-skill"));
  await writeFixtureFile(codexSkills, "no-skill-md/README.md", "# Not a skill\n");
  await mkdir(path.join(codexSkills, "empty-folder"), { recursive: true });
  await writeFixtureFile(codexSkills, "bookkeeping/.marker", "x");
  await writeFixtureFile(codexSkills, "category/DESCRIPTION.md", "Hermes category\n");
  await writeFixtureFile(codexSkills, "no-frontmatter/SKILL.md", "# Title only\n");
  await writeFixtureFile(codexSkills, "missing-desc/SKILL.md", "---\nname: missing-desc\n---\n# x\n");
  await writeFixtureFile(codexSkills, "wrong-name/SKILL.md", skill("other-name"));
  await writeFixtureFile(codexSkills, "big-skill/SKILL.md", `${skill("big-skill")}${"x".repeat(300 * 1024)}\n`);
  if (POSIX) await symlink(path.join(home, "missing-target"), path.join(codexSkills, "broken-link"));
  // The same skill twice inside one agent, with different content.
  await writeFixtureFile(home, ".claude/skills/dup-skill/SKILL.md", skill("dup-skill", "first"));
  await writeFixtureFile(home, ".claude/skills-extra/dup-skill/SKILL.md", skill("dup-skill", "second"));
  await writeFixtureFile(home, ".codex/config.toml", `
[mcp_servers.missing]
command = "definitely-missing-cmd-zz"
[mcp_servers.nvmserver]
command = "nvmtool"
[mcp_servers.spaced]
command = "${path.join(home, "My Tools", "srv")}"
args = ["--stdio"]
[mcp_servers.leaky]
command = "/bin/sh"
env = { API_KEY = "ZZ9healthsecret36" }
`);
  await writeFixtureFile(home, "My Tools/srv", "#!/bin/sh\n");
  await chmod(path.join(home, "My Tools", "srv"), 0o755);
  await createOpenClawHome(home);
  // A tool that only exists under nvm.
  const nvmBin = path.join(home, ".nvm", "versions", "node", "v22.0.0", "bin");
  await mkdir(nvmBin, { recursive: true });
  await writeFile(path.join(nvmBin, "nvmtool"), "#!/bin/sh\n");
  await chmod(path.join(nvmBin, "nvmtool"), 0o755);
  return { nvmBin };
}

test("health report finds broken links, bad frontmatter, oversize and duplicate copies, missing tools and secrets", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "health-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const { nvmBin } = await createHealthHome(home);
  const agent = (id, paths) => ({ id, name: id, shortName: id.slice(0, 2), color: "#8fc9ef", paths });
  const config = {
    agents: [
      agent("codex", [path.join(home, ".codex", "skills")]),
      agent("claude", [path.join(home, ".claude", "skills"), path.join(home, ".claude", "skills-extra")]),
      agent("gemini", [path.join(home, ".codex", "skills")]),
      agent("openclaw", [path.join(home, ".openclaw", "skills")]),
    ],
    visibleAgentIds: ["codex", "claude", "gemini", "openclaw"],
    primaryAgentIds: ["codex", "claude"],
  };
  const scan = JSON.parse(JSON.stringify(await scanAll(config, { homeDirectory: home })));
  const mcp = await readMcpSources(home);
  const report = await buildHealthReport({
    scan,
    plugins: [
      { agentId: "codex", displayName: "Cached Plugin", installed: true, configured: false, enabled: "unknown" },
      { agentId: "claude", displayName: "Ghost Plugin", installed: false, configured: true, enabled: true },
    ],
    mcpEntries: mcp.entries,
    homeDirectory: home,
    homes: [home],
    searchDirectories: [
      { directory: "/bin", nvm: false },
      { directory: nvmBin, nvm: true },
    ],
    env: {},
  });
  const has = (category, predicate = () => true) => report.findings.some((finding) => finding.category === category && predicate(finding));
  if (POSIX) assert.ok(has("broken-link", (finding) => finding.skillName === "broken-link" && finding.severity === "error" && finding.fix.kind === "remove-link"));
  assert.ok(has("missing-skill-md", (finding) => finding.skillName === "no-skill-md"));
  assert.equal(has("missing-skill-md", (finding) => ["empty-folder", "bookkeeping", "category"].includes(finding.skillName)), false);
  assert.equal(has("mcp-command-missing", (finding) => /spaced/u.test(finding.title)), false, "program paths may contain spaces");
  assert.ok(has("frontmatter", (finding) => /no-frontmatter/u.test(finding.title)));
  assert.ok(has("frontmatter", (finding) => /description/u.test(finding.title) && /missing-desc/u.test(finding.title)));
  assert.ok(has("name-mismatch", (finding) => /other-name/u.test(finding.title)));
  assert.ok(has("oversize", (finding) => finding.severity === "warn" && finding.skillName === "big-skill"));
  assert.ok(has("differing-copies", (finding) => finding.agentId === "claude" && finding.skillName === "dup-skill"));
  if (POSIX) assert.ok(has("hidden-by-product", (finding) => finding.skillName === "escaped-skill"));
  assert.ok(has("shadowed", (finding) => finding.skillName === "managed-skill" && finding.agentId === "openclaw"));
  assert.ok(has("disabled", (finding) => finding.skillName === "off-skill" && finding.fix.kind === "enable"));
  assert.ok(has("missing-bin", (finding) => finding.skillName === "needs-bins" && /op/u.test(finding.title)));
  assert.ok(has("missing-env", (finding) => /OP_TOKEN/u.test(finding.title)));
  assert.ok(has("mcp-command-missing", (finding) => /definitely-missing-cmd-zz/u.test(finding.title)));
  assert.ok(has("nvm-only", (finding) => /nvmtool/u.test(finding.title)));
  assert.equal(has("mcp-command-missing", (finding) => /leaky/u.test(finding.title)), false, "/bin/sh exists");
  assert.ok(has("mcp-literal-secret", (finding) => /leaky/u.test(finding.title) && /env\.API_KEY/u.test(finding.detail)));
  assert.ok(has("plugin-state", (finding) => /Cached Plugin/u.test(finding.title)));
  assert.ok(has("plugin-state", (finding) => /Ghost Plugin/u.test(finding.title) && finding.severity === "warn"));
  assert.ok(has("shared-root", (finding) => /codex/u.test(finding.detail) && /gemini/u.test(finding.detail)));
  assert.equal(report.counts.error + report.counts.warn + report.counts.info, report.findings.length);
  assert.ok(report.findings.every((finding) => /^[a-f0-9]{16}$/u.test(finding.id) && finding.fix?.kind && finding.title));
  assert.deepEqual(
    report.findings.map((finding) => finding.severity),
    [...report.findings.map((finding) => finding.severity)].sort((left, right) => ["error", "warn", "info"].indexOf(left) - ["error", "warn", "info"].indexOf(right)),
  );
  const body = JSON.stringify(report);
  assert.doesNotMatch(body, /ZZ9/u);
  assert.deepEqual(report.findings.filter((finding) => JSON.stringify(finding).includes(home)).map((finding) => [finding.category, finding.path, finding.title, finding.detail]), []);
});

test("command lookup never runs anything and flags nvm-only tools", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "lookup-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const plain = path.join(home, "bin");
  const nvm = path.join(home, "nvm", "bin");
  await mkdir(plain, { recursive: true });
  await mkdir(nvm, { recursive: true });
  for (const [directory, name, mode] of [[plain, "both", 0o755], [nvm, "both", 0o755], [nvm, "onlynvm", 0o755], [plain, "notexec", 0o644]]) {
    await writeFile(path.join(directory, name), "#!/bin/sh\nexit 1\n");
    await chmod(path.join(directory, name), mode);
  }
  const lookup = createCommandLookup([{ directory: nvm, nvm: true }, { directory: plain, nvm: false }]);
  assert.deepEqual(await lookup("both"), { found: true, nvmOnly: false, checked: true });
  assert.deepEqual(await lookup("onlynvm"), { found: true, nvmOnly: true, checked: true });
  if (POSIX) assert.deepEqual(await lookup("notexec"), { found: false, nvmOnly: false, checked: true });
  assert.deepEqual(await lookup("$(touch pwned)"), { found: false, nvmOnly: false, checked: false });
});
