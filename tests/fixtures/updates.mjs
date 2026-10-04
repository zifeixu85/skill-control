import { chmod, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { gitBlobSha, localTreeSha, treeShaFromListing } from "../../server/git-tree.mjs";
import { writeFixtureFile } from "./smartorder.mjs";

/**
 * Installed sources of every kind plus a mock network. Upstream content and API answers
 * are built here; nothing reaches the real network. Remote text contains "ZZ9" secrets
 * that must never appear in responses, and gh's token is "ghp_ZZ9…".
 */

export const HEAD = "1111111111111111111111111111111111111111";
export const GH_TOKEN = "ghp_ZZ9tokenSecretValue1234567890abcd";
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const skill = (name, body = "v1") => `---\nname: ${name}\ndescription: ${name} fixture\n---\n# ${name}\n\n${body}\n`;

/** Upstream skills in acme/skills at HEAD. */
export const UPSTREAM = {
  "fresh-skill": { "SKILL.md": skill("fresh-skill") },
  "old-skill": { "SKILL.md": skill("old-skill", "v2"), "scripts/run.sh": "#!/bin/sh\necho v2\n" },
  "edited-skill": { "SKILL.md": skill("edited-skill") },
  "both-skill": { "SKILL.md": skill("both-skill", "v2") },
  "drift-skill": { "SKILL.md": skill("drift-skill", "v2") },
};

export function upstreamListing() {
  const listing = [];
  for (const [name, files] of Object.entries(UPSTREAM)) {
    for (const [file, content] of Object.entries(files)) {
      listing.push({ path: `skills/${name}/${file}`, mode: file.endsWith(".sh") ? "100755" : "100644", type: "blob", sha: gitBlobSha(Buffer.from(content)).toString("hex"), size: Buffer.byteLength(content) });
    }
  }
  for (const name of Object.keys(UPSTREAM)) {
    listing.push({ path: "skills", type: "tree", mode: "040000", sha: "0".repeat(40) });
    listing.push({ path: `skills/${name}`, type: "tree", mode: "040000", sha: treeShaFromListing(listing, `skills/${name}`) });
    if (UPSTREAM[name]["scripts/run.sh"]) listing.push({ path: `skills/${name}/scripts`, type: "tree", mode: "040000", sha: treeShaFromListing(listing, `skills/${name}/scripts`) });
  }
  return listing;
}

const upstreamSha = (name) => upstreamListing().find((entry) => entry.type === "tree" && entry.path === `skills/${name}`).sha;

async function writeSkill(root, name, files) {
  for (const [file, content] of Object.entries(files)) {
    const target = await writeFixtureFile(root, `${name}/${file}`, content);
    if (file.endsWith(".sh")) await chmod(target, 0o755);
  }
  return localTreeSha(path.join(root, name));
}

/** A fake npm-installed CLI: prints its arguments, an env flag and a planted secret. */
async function fakeCli(prefix, packageName, version, name) {
  const packageRoot = path.join(prefix, "lib", "node_modules", ...packageName.split("/"));
  await writeFixtureFile(packageRoot, "package.json", json({ name: packageName, version }));
  const script = await writeFixtureFile(
    packageRoot,
    `bin/${name}`,
    `#!/bin/sh\necho "{\\"ok\\":true,\\"args\\":\\"$*\\",\\"dnt\\":\\"$DO_NOT_TRACK\\",\\"home\\":\\"$HOME\\"}"\necho "warning: token=ZZ9cliOutputSecret77 from $HOME" >&2\nexit 0\n`,
  );
  await chmod(script, 0o755);
  await mkdir(path.join(prefix, "bin"), { recursive: true });
  await symlink(script, path.join(prefix, "bin", name));
  return path.join(prefix, "bin");
}

export async function createUpdatesHome(home) {
  const library = path.join(home, ".agents", "skills");
  const localHashes = {};
  localHashes["fresh-skill"] = await writeSkill(library, "fresh-skill", UPSTREAM["fresh-skill"]);
  localHashes["old-skill"] = await writeSkill(library, "old-skill", { "SKILL.md": skill("old-skill") });
  localHashes["edited-skill"] = await writeSkill(library, "edited-skill", { "SKILL.md": skill("edited-skill", "my edit") });
  localHashes["both-skill"] = await writeSkill(library, "both-skill", { "SKILL.md": skill("both-skill", "my edit") });
  localHashes["drift-skill"] = await writeSkill(library, "drift-skill", UPSTREAM["drift-skill"]);
  const oldOld = await localTreeSha(library + "/old-skill");
  const lockEntry = (name, hash) => ({
    source: "acme/skills",
    sourceType: "github",
    sourceUrl: "https://github.com/acme/skills.git",
    skillPath: `skills/${name}/SKILL.md`,
    skillFolderHash: hash,
    installedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  // Lock baselines: what was installed. both/edited were installed at the old upstream.
  const v1Both = gitBlobSha(Buffer.from(skill("both-skill"))).toString("hex");
  const baselineBoth = treeShaFromListing([{ path: "SKILL.md", mode: "100644", type: "blob", sha: v1Both }], "");
  const v1Drift = treeShaFromListing([{ path: "SKILL.md", mode: "100644", type: "blob", sha: gitBlobSha(Buffer.from(skill("drift-skill"))).toString("hex") }], "");
  await writeFixtureFile(home, ".agents/.skill-lock.json", json({
    version: 3,
    skills: {
      "fresh-skill": lockEntry("fresh-skill", upstreamSha("fresh-skill")),
      "old-skill": lockEntry("old-skill", oldOld),
      "edited-skill": lockEntry("edited-skill", upstreamSha("edited-skill")),
      "both-skill": lockEntry("both-skill", baselineBoth),
      "drift-skill": lockEntry("drift-skill", v1Drift),
      "lark-doc": { source: "open.feishu.cn", sourceType: "well-known", sourceUrl: "https://open.feishu.cn/.well-known/skills/lark-doc/SKILL.md", skillFolderHash: "", installedAt: "x", updatedAt: "x" },
    },
    dismissed: {},
  }));
  await writeSkill(library, "lark-doc", { "SKILL.md": skill("lark-doc") });
  // Claude sees old-skill through a link: one physical copy, two Agents.
  await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  await symlink(path.join(library, "old-skill"), path.join(home, ".claude", "skills", "old-skill"));

  // lark-cli 1.0.66 on the path, Hermes' own 1.0.56.
  const binDir = await fakeCli(path.join(home, "npm"), "@larksuite/cli", "1.0.66", "lark-cli");
  await fakeCli(path.join(home, ".hermes", "node"), "@larksuite/cli", "1.0.56", "lark-cli");
  await writeFixtureFile(home, ".lark-cli/update-state.json", json({ latest_version: "1.0.90", checked_at: 1 }));
  await writeFixtureFile(home, ".lark-cli/skills-state.json", json({ version: "1.0.66", official_skills: ["lark-doc"] }));

  // Claude Code plugins.
  await writeFixtureFile(home, ".claude/plugins/installed_plugins.json", json({
    version: 2,
    plugins: {
      "ecc@ecc-market": [{ scope: "user", installPath: path.join(home, ".claude/plugins/cache/ecc-market/ecc/1.9.0"), version: "1.9.0", gitCommitSha: "a".repeat(40) }],
      "warp@warp-market": [{ scope: "user", installPath: path.join(home, ".claude/plugins/cache/warp-market/warp/2.2.0"), version: "2.2.0", gitCommitSha: "b".repeat(40) }],
      "nover@acme-market": [{ scope: "user", installPath: path.join(home, ".claude/plugins/cache/acme-market/nover/c1c1c1c1c1c1"), version: "c1c1c1c1c1c1", gitCommitSha: "c1c1c1c1c1c1".padEnd(40, "0") }],
      "old-name@acme-market": [{ scope: "user", installPath: "x", version: "1.0.0", gitCommitSha: "2".repeat(40) }],
      "pinned@acme-market": [{ scope: "user", installPath: "x", version: "0.5.0", gitCommitSha: "3".repeat(40) }],
    },
  }));
  await writeFixtureFile(home, ".claude/plugins/known_marketplaces.json", json({
    "ecc-market": { source: { source: "github", repo: "affaan-m/everything-claude-code" }, installLocation: "x", lastUpdated: "x" },
    "warp-market": { source: { source: "github", repo: "warpdotdev/claude-code-warp" }, installLocation: "x", lastUpdated: "x" },
    "acme-market": { source: { source: "github", repo: "acme/plugins" }, installLocation: path.join(home, ".claude/plugins/marketplaces/acme-market"), lastUpdated: "x" },
  }));

  await writeFixtureFile(home, ".claude/plugins/marketplaces/acme-market/.claude-plugin/marketplace.json", json({ plugins: [{ name: "old-name", source: "./tools/old" }] }));

  // Codex: one git marketplace, one remote plugin compared with Codex's own catalog.
  await writeFixtureFile(home, ".codex/config.toml", `[marketplaces.chatcut-inc]\nsource_type = "git"\nsource = "https://github.com/ChatCut-Inc/agent-plugin.git"\nref = "main"\nlast_revision = "${"d".repeat(40)}"\n`);
  await writeFixtureFile(home, ".codex/plugins/cache/openai-curated-remote/gmail/.codex-remote-plugin-install.json", json({ schema_version: 1, remote_plugin_id: "plugin_gmail" }));
  await mkdir(path.join(home, ".codex/plugins/cache/openai-curated-remote/gmail/0.1.9"), { recursive: true });
  await writeFixtureFile(home, ".codex/cache/remote_plugin_catalog/c.json", json({ schema_version: 1, plugins: [{ id: "plugin_gmail", name: "gmail", release: { version: "0.1.10" } }] }));

  // WorkBuddy: a zip marketplace and a SkillHub skill.
  await writeFixtureFile(home, ".workbuddy/plugins/marketplaces/official/.zip-metadata.json", json({ url: "https://download.codebuddy.cn/plugin-marketplace/official.zip", etag: '"etag-1"', lastModified: "x" }));
  await writeSkill(path.join(home, ".workbuddy", "skills"), "hub-skill__skillhub", { "SKILL.md": skill("hub-skill"), "_skillhub_meta.json": json({ slug: "hub-skill", version: "1.0.0", installedContentHash: "sha256:x" }) });

  // OpenClaw: ClawHub skills, one from an unsupported registry, one ambiguous slug.
  const ocSkills = path.join(home, ".openclaw", "skills");
  await writeFixtureFile(home, ".openclaw/openclaw.json", "{}\n");
  for (const [name, registry] of [["claw-skill", "https://clawhub.ai"], ["other-registry", "https://registry.example.test"], ["ambiguous", "https://clawhub.ai"]]) {
    await writeSkill(ocSkills, name, { "SKILL.md": skill(name), ".clawhub/origin.json": json({ version: 1, registry, slug: name, installedVersion: "1.0.0" }) });
  }

  // git checkouts: gstack (guide only) and a plain repo (git pull --ff-only).
  for (const [dir, url, commit] of [
    [path.join(home, ".claude", "skills", "gstack"), "https://github.com/garrytan/gstack", "e".repeat(40)],
    [path.join(home, ".claude", "skills", "tooling"), "https://github.com/acme/tooling.git", "f".repeat(40)],
  ]) {
    await writeFixtureFile(dir, "SKILL.md", skill(path.basename(dir)));
    await writeFixtureFile(dir, ".git/HEAD", "ref: refs/heads/main\n");
    await writeFixtureFile(dir, ".git/refs/heads/main", `${commit}\n`);
    await writeFixtureFile(dir, ".git/config", `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  }
  // A skill with a GitHub homepage only: a possible source, never bound automatically.
  await writeFixtureFile(home, ".claude/skills/homepage-skill/SKILL.md", "---\nname: homepage-skill\ndescription: x\nhomepage: https://github.com/someone/homepage-skill\n---\n# x\n");
  return { binDir, localHashes };
}

const response = (body, { status = 200, headers = {} } = {}) =>
  new Response(body === null ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers });

/** Mock fetch + ls-remote; `calls` records every request (url, method, auth header). */
export function createMockNetwork({ offline = false, rateLimited = false, tampered = false } = {}) {
  const calls = [];
  const listing = upstreamListing();
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", auth: init.headers?.authorization || null });
    if (offline) throw new TypeError("fetch failed");
    const { hostname, pathname } = new URL(url);
    if (hostname === "api.github.com") {
      const limits = { "x-ratelimit-remaining": rateLimited ? "0" : "55", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) };
      if (rateLimited) return response({ message: "API rate limit exceeded" }, { status: 403, headers: limits });
      if (pathname === `/repos/acme/skills/git/trees/${HEAD}`) return response({ sha: HEAD, tree: listing, truncated: false }, { headers: limits });
      if (pathname === "/repos/acme/skills/commits") return response([{ sha: "9".repeat(40), commit: { message: "Update old-skill\n\nbody api_key=ZZ9commitBody01", committer: { date: "2026-10-01T00:00:00Z" } } }], { headers: limits });
      return response({ message: "Not Found" }, { status: 404, headers: limits });
    }
    if (hostname === "raw.githubusercontent.com") {
      if (pathname === "/affaan-m/everything-claude-code/HEAD/.claude-plugin/marketplace.json") return response({ plugins: [{ name: "ecc", source: "./", version: "2.2.3" }] });
      if (pathname === "/warpdotdev/claude-code-warp/HEAD/.claude-plugin/marketplace.json") return response({ plugins: [{ name: "warp", source: "./plugins/warp" }] });
      if (pathname === "/warpdotdev/claude-code-warp/HEAD/plugins/warp/.claude-plugin/plugin.json") return response({ name: "warp", version: "2.2.0" });
      if (pathname === "/acme/plugins/HEAD/.claude-plugin/marketplace.json") {
        return response({
          plugins: [
            { name: "nover", source: "./nover" },
            { name: "new-name", source: "./tools/old", version: "1.1.0" },
            { name: "pinned", source: { source: "url", url: "https://github.com/acme/pinned.git", sha: "4".repeat(40) } },
          ],
        });
      }
      const match = pathname.match(/^\/acme\/skills\/([a-f0-9]{40})\/skills\/([\w-]+)\/(.+)$/u);
      if (match && match[1] === HEAD) {
        const content = UPSTREAM[match[2]]?.[decodeURIComponent(match[3])];
        if (content !== undefined) return response(tampered ? `${content}tampered` : content);
      }
      return response("Not Found", { status: 404 });
    }
    if (url === "https://registry.npmjs.org/@larksuite/cli/latest") return response({ name: "@larksuite/cli", version: "1.0.97" });
    if (url === "https://open.feishu.cn/.well-known/skills/index.json") return response({ skills: [{ name: "lark-doc" }, { name: "lark-meeting" }] });
    if (hostname === "api.skillhub.cn") return response({ latestVersion: { version: "1.2.0", changelog: "Fixes. token: ZZ9changelogSecret02" } });
    if (hostname === "clawhub.ai") {
      if (pathname.endsWith("/ambiguous")) return response({ code: "AMBIGUOUS_SKILL_SLUG", message: "multiple", matches: [] });
      return response({ skill: { slug: "claw-skill" }, latestVersion: { version: "1.1.0", changelog: "New things" } });
    }
    if (hostname === "download.codebuddy.cn") return response(null, { status: init.headers?.["if-none-match"] === '"etag-1"' ? 304 : 200, headers: { etag: '"etag-1"' } });
    return response("unexpected", { status: 500 });
  };
  const remotes = {
    "https://github.com/acme/skills.git HEAD": HEAD,
    "https://github.com/ChatCut-Inc/agent-plugin.git refs/heads/main": "d".repeat(40),
    "https://github.com/garrytan/gstack refs/heads/main": "7".repeat(40),
    "https://github.com/acme/tooling.git refs/heads/main": "8".repeat(40),
    "https://github.com/acme/plugins.git HEAD": "c1c1c1c1c1c1".padEnd(40, "0"),
  };
  const lsRemoteImpl = async (url, ref) => {
    calls.push({ url, method: "ls-remote", ref });
    if (offline) {
      const { TransportError } = await import("../../server/update-transport.mjs");
      throw new TransportError("offline", "无法连接仓库。");
    }
    const sha = remotes[`${url} ${ref}`];
    if (!sha) throw new Error(`unexpected ls-remote ${url} ${ref}`);
    return sha;
  };
  return { fetchImpl, lsRemoteImpl, calls };
}

export const testAgents = (home) => {
  const agent = (id, paths) => ({ id, name: id, shortName: id.slice(0, 2), color: "#8fc9ef", paths });
  return [
    agent("codex", [path.join(home, ".agents", "skills"), path.join(home, ".codex", "skills")]),
    agent("claude", [path.join(home, ".claude", "skills")]),
    agent("workbuddy", [path.join(home, ".workbuddy", "skills")]),
    agent("openclaw", [path.join(home, ".openclaw", "skills")]),
  ];
};
