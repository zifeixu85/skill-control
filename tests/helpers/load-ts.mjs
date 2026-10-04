// Loads a TypeScript module from app/lib for node:test. Node 22.13 (CI) cannot run
// TypeScript directly, so the module is bundled with esbuild into a temp file first.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function loadTs(relativePath) {
  const directory = await mkdtemp(path.join(tmpdir(), "skill-control-ui-test-"));
  const outfile = path.join(directory, `${path.basename(relativePath, ".ts")}.mjs`);
  try {
    await build({
      entryPoints: [path.join(root, relativePath)],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
