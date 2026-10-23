import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import yaml from "js-yaml";
import { parseMacManifest, pickMacZip } from "../desktop/app-update-core.mjs";
import { splitReleaseNotes } from "../scripts/release-notes.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(ROOT, relative), "utf8");
const sha512 = (text) => createHash("sha512").update(text).digest("base64");

test("splitReleaseNotes reads the prerelease flag and strips the front matter", () => {
  assert.deepEqual(splitReleaseNotes("---\nprerelease: true\n---\n\n# Skill Control v0.2.0\n"), {
    prerelease: true,
    body: "# Skill Control v0.2.0",
  });
  assert.deepEqual(splitReleaseNotes("﻿---\r\nprerelease: false\r\n---\r\nBody"), { prerelease: false, body: "Body" });
  assert.deepEqual(splitReleaseNotes("# No front matter\n\n---\nnot front matter"), {
    prerelease: false,
    body: "# No front matter\n\n---\nnot front matter",
  });
  assert.deepEqual(splitReleaseNotes("---\n---\nBody"), { prerelease: false, body: "Body" });
  assert.throws(() => splitReleaseNotes("---\nprerelease: yes\n---\nBody"), /true or false/u);
  assert.throws(() => splitReleaseNotes("---\nprerelase: true\n---\nBody"), /Unknown/u, "typos fail the release");
  assert.throws(() => splitReleaseNotes("---\nprerelease: true\nBody"), /not closed/u);
});

test("release-notes.mjs writes the body and $GITHUB_OUTPUT lines", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sc-notes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notes = path.join(directory, "v9.9.9.md");
  const body = path.join(directory, "body.md");
  await writeFile(notes, "---\nprerelease: true\n---\n\n## Notes\n");
  const { stdout } = await run(process.execPath, [path.join(ROOT, "scripts/release-notes.mjs"), notes, body]);
  assert.equal(stdout, "found=true\nprerelease=true\n");
  assert.equal(await readFile(body, "utf8"), "## Notes\n");
  const missing = await run(process.execPath, [path.join(ROOT, "scripts/release-notes.mjs"), path.join(directory, "none.md"), body]);
  assert.equal(missing.stdout, "found=false\nprerelease=false\n");
});

test("merge-mac-update-manifests.mjs merges the arm64 and x64 manifests", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sc-manifests-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = (arch) =>
    [
      "version: 0.2.0",
      "files:",
      `  - url: Skill-Control-0.2.0-mac-${arch}.zip`,
      `    sha512: ${sha512(`${arch} zip`)}`,
      "    size: 123456",
      "    blockMapSize: 1234",
      `  - url: Skill-Control-0.2.0-mac-${arch}.dmg`,
      `    sha512: ${sha512(`${arch} dmg`)}`,
      "    size: 223456",
      `path: Skill-Control-0.2.0-mac-${arch}.zip`,
      `sha512: ${sha512(`${arch} zip`)}`,
      `releaseDate: '2026-10-24T0${arch === "x64" ? 9 : 8}:00:00.000Z'`,
      "",
    ].join("\n");
  await writeFile(path.join(directory, "latest-mac-arm64.yml"), manifest("arm64"));
  await writeFile(path.join(directory, "latest-mac-x64.yml"), manifest("x64"));
  const output = path.join(directory, "out", "latest-mac.yml");
  await run(process.execPath, [path.join(ROOT, "scripts/merge-mac-update-manifests.mjs"), directory, output]);
  const text = await readFile(output, "utf8");
  const merged = parseMacManifest(text);
  assert.equal(merged.files.length, 4);
  assert.equal(pickMacZip(merged, "arm64").sha512, sha512("arm64 zip"));
  assert.equal(pickMacZip(merged, "x64").size, 123456);
  const raw = yaml.load(text);
  assert.equal(raw.path, "Skill-Control-0.2.0-mac-x64.zip");
  assert.equal(raw.releaseDate, "2026-10-24T09:00:00.000Z");
  assert.equal(raw.files.find((file) => file.url.endsWith("-arm64.zip")).blockMapSize, 1234, "extra keys survive");

  await rm(path.join(directory, "latest-mac-x64.yml"));
  await assert.rejects(run(process.execPath, [path.join(ROOT, "scripts/merge-mac-update-manifests.mjs"), directory, output]));
});

test("the release workflow uploads update metadata, merges macOS manifests and publishes from one job", async () => {
  const workflow = yaml.load(await read(".github/workflows/release.yml"));
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const jobs = workflow.jobs;
  for (const [name, job] of Object.entries(jobs)) {
    if (name === "publish") assert.deepEqual(job.permissions, { contents: "write" });
    else assert.equal(job.permissions, undefined, `${name} keeps the read-only default`);
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u, `${step.uses} is pinned to a commit`);
    }
  }
  const upload = jobs.build.steps.find((step) => step.name === "Upload platform artifacts");
  for (const pattern of ["release/latest*.yml", "release/*.blockmap", "!release/latest-mac-*.yml"]) {
    assert.ok(upload.with.path.includes(pattern), pattern);
  }
  assert.deepEqual(jobs["update-manifests"].needs, "build");
  assert.ok(jobs.publish.needs.includes("update-manifests"));
  const publish = jobs.publish.steps.find((step) => step.name === "Publish release");
  assert.match(publish.run, /--prerelease/u);
  assert.match(publish.run, /--verify-tag/u);
  const ci = yaml.load(await read(".github/workflows/ci.yml"));
  assert.ok(ci.jobs.quality.steps.some((step) => /electron-builder .*--publish never/u.test(step.run || "")));
});

test("electron-builder writes GitHub update metadata while every build script stays --publish never", async () => {
  const config = yaml.load(await read("electron-builder.yml"));
  assert.deepEqual(config.publish, [{ provider: "github", owner: "zifeixu85", repo: "skill-control" }]);
  assert.equal(config.appId, "dev.skillcontrol.desktop");
  assert.match(config.artifactName, /\$\{os\}-\$\{arch\}/u, "the mac updater picks zips by -mac-<arch>.zip");
  const pkg = JSON.parse(await read("package.json"));
  for (const [name, script] of Object.entries(pkg.scripts)) {
    if (/electron-builder(?! --dir)/u.test(script) && !script.includes("--dir")) {
      assert.match(script, /--publish never/u, name);
    }
  }
});

test("the current version has release notes the workflow can read", async () => {
  const { version } = JSON.parse(await read("package.json"));
  const notes = splitReleaseNotes(await read(`docs/releases/v${version}.md`));
  assert.ok(notes.body.length > 200);
  assert.equal(typeof notes.prerelease, "boolean");
});
