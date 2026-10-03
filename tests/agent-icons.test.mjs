import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { readAgentIcon } from "../server/agent-icons.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const plist = (bundleId, iconFile) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleIconFile</key><string>${iconFile}</string>
</dict></plist>`;

/** A valid solid-colour PNG, built by hand (no image library needed). */
function solidPng(size) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x7f)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

async function setup(context) {
  const home = await mkdtemp(path.join(tmpdir(), "agent-icons-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const applications = path.join(home, "Applications");
  await writeFixtureFile(applications, "Codex.app/Contents/Info.plist", plist("com.openai.codex", "electron.icns"));
  await writeFixtureFile(applications, "Codex.app/Contents/Resources/electron.icns", solidPng(256));
  await writeFixtureFile(applications, "Claude.app/Contents/Info.plist", plist("com.example.impostor", "icon.icns"));
  await writeFixtureFile(applications, "Claude.app/Contents/Resources/icon.icns", solidPng(16));
  await writeFixtureFile(applications, "Cursor.app/Contents/Info.plist", plist("com.todesktop.230313mzl4w4u92", "../../../../escape.icns"));
  return { home, applications, cacheDirectory: path.join(home, ".agent-skill-manager", "icons") };
}

test("converts an installed app icon once and serves it from the cache", async (context) => {
  const { home, applications, cacheDirectory } = await setup(context);
  let conversions = 0;
  const convert = async (source, destination) => {
    conversions += 1;
    await writeFile(destination, solidPng(128));
  };
  const options = { homeDirectory: home, applicationDirectories: [applications], cacheDirectory, platform: "darwin", convert };
  const icon = await readAgentIcon("codex", options);
  assert.equal(icon.mimeType, "image/png");
  assert.equal(icon.buffer.subarray(1, 4).toString(), "PNG");
  await readAgentIcon("codex", options);
  assert.equal(conversions, 1, "second request is served from the cache");
  assert.deepEqual((await readdir(cacheDirectory)).filter((name) => !name.startsWith(".")).length, 1);

  assert.equal(await readAgentIcon("claude", options), null, "a bundle with another id is not trusted");
  assert.equal(await readAgentIcon("cursor", options), null, "an icon path outside the bundle is refused");
  assert.equal(await readAgentIcon("unknown-agent", options), null);
  assert.equal(await readAgentIcon("codex", { ...options, platform: "linux" }), null);
  const bad = await readAgentIcon("codex", {
    ...options,
    cacheDirectory: path.join(home, "other-cache"),
    convert: async (source, destination) => writeFile(destination, "<svg/>"),
  });
  assert.equal(bad, null, "only PNG output is served");
});

test("converts with sips on macOS", { skip: process.platform !== "darwin" }, async (context) => {
  const { home, applications, cacheDirectory } = await setup(context);
  const icon = await readAgentIcon("codex", { homeDirectory: home, applicationDirectories: [applications], cacheDirectory });
  assert.ok(icon);
  assert.equal(icon.buffer.readUInt32BE(16), 128, "scaled to 128 px");
});
