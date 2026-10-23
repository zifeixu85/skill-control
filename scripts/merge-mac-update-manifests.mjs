import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { mergeMacManifests, parseMacManifest } from "../desktop/app-update-core.mjs";

/**
 * Release workflow helper. The arm64 and x64 macOS builds each write their own
 * latest-mac.yml (renamed latest-mac-<arch>.yml in CI); the release needs one file that
 * lists both zips, which is what the in-app updater and electron-updater read.
 *
 * Usage: node scripts/merge-mac-update-manifests.mjs <input-dir> <output-file>
 */

const [inputDirectory, outputFile] = process.argv.slice(2);

async function main() {
  if (!inputDirectory || !outputFile) {
    throw new Error("Usage: node scripts/merge-mac-update-manifests.mjs <input-dir> <output-file>");
  }
  const names = (await readdir(inputDirectory)).filter((name) => /^latest-mac-(arm64|x64)\.yml$/u.test(name)).sort();
  if (names.length !== 2) throw new Error(`Expected latest-mac-arm64.yml and latest-mac-x64.yml, found: ${names.join(", ") || "none"}`);
  const manifests = [];
  for (const name of names) {
    const text = await readFile(path.join(inputDirectory, name), "utf8");
    parseMacManifest(text);
    manifests.push(yaml.load(text, { schema: yaml.CORE_SCHEMA }));
  }
  const merged = yaml.dump(mergeMacManifests(manifests), { lineWidth: -1, noRefs: true });
  const check = parseMacManifest(merged);
  for (const arch of ["arm64", "x64"]) {
    if (!check.files.some((file) => file.url.endsWith(`-mac-${arch}.zip`))) throw new Error(`Merged manifest has no ${arch} zip.`);
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, merged, "utf8");
  console.info(`[merge-mac-update-manifests] ${names.join(" + ")} → ${outputFile} (${check.files.length} files, ${check.version})`);
}

main().catch((error) => {
  console.error(`[merge-mac-update-manifests] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
