#!/usr/bin/env node
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? resolve(process.argv[2]) : join(here, "..");
// Tauri CLI 2.10.1 templates/mobile/ios/Assets.xcassets/AppIcon.appiconset/Contents.json.
const contents = readFileSync(join(here, "fixtures", "ios-appicon-contents.json"));
const manifest = JSON.parse(contents);
const temp = mkdtempSync(join(tmpdir(), "hghubx-ios-icons-"));

try {
  const script = join(root, "scripts", "sync-ios-icons.mjs");
  assert(existsSync(script), "iOS icon sync missing; generated projects keep Tauri template icons");
  const config = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  assert(config.build.beforeBuildCommand.includes("node scripts/generate-ios-icons.mjs"), "Normal Tauri builds must generate square iOS artwork");
  assert(config.build.beforeBuildCommand.includes("node scripts/sync-ios-icons.mjs"), "Normal Tauri builds must sync iOS icons");
  const sourceSvg = readFileSync(join(root, "src-tauri", "icons", "ios", "source.svg"), "utf8");
  assert(!/<rect[^>]*\brx\s*=|<rect[^>]*\bstroke\s*=/.test(sourceSvg), "iOS source must not pre-mask its full-bleed background");
  assert(readdirSync(join(root, "src-tauri", "icons", "ios")).includes("source.svg"), "Tracked iOS source is missing");
  const generator = readFileSync(join(root, "scripts", "generate-ios-icons.mjs"), "utf8");
  assert.match(generator, /execFileSync\(process\.execPath/,
    "iOS icon generation must invoke the installed CLI through Node on Windows");
  assert.doesNotMatch(generator, /pnpm\.cmd/,
    "iOS icon generation must not spawn pnpm.cmd from beforeBuildCommand");
  const build = readFileSync(join(root, "scripts", "build-ios-unsigned.sh"), "utf8");
  const generateIndex = build.indexOf("node scripts/generate-ios-icons.mjs");
  const syncIndex = build.indexOf("node scripts/sync-ios-icons.mjs --required");
  assert(generateIndex >= 0 && generateIndex < build.indexOf("pnpm tauri ios build"), "Unsigned builds must generate artwork before starting Tauri/Xcode");
  assert(syncIndex >= 0 && syncIndex < build.indexOf("pnpm tauri ios build"), "Unsigned builds must sync before starting Tauri/Xcode");
  console.log("PASS: standard and unsigned build hooks");

  for (const slot of manifest.images) {
    const [width, height] = slot.size.split("x").map(value => Number(value) * Number(slot.scale[0]));
    const image = readFileSync(join(root, "src-tauri", "icons", "ios", slot.filename));
    assert(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${slot.filename} is not PNG`);
    assert.equal(image.readUInt32BE(16), width, `${slot.filename} width`);
    assert.equal(image.readUInt32BE(20), height, `${slot.filename} height`);
  }
  console.log("PASS: tracked iOS artwork has all 18 expected dimensions");

  mkdirSync(join(temp, "scripts"), { recursive: true });
  cpSync(script, join(temp, "scripts", "sync-ios-icons.mjs"));
  const invoke = (...args) => spawnSync(process.execPath, [join(temp, "scripts", "sync-ios-icons.mjs"), ...args], { encoding: "utf8" });
  const expectFailure = (pattern, ...args) => {
    const result = invoke(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
  };
  const skipped = invoke();
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /skipped/);
  expectFailure(/Apple project missing/, "--required");
  console.log("PASS: desktop skip and required Apple project");

  const apple = join(temp, "src-tauri", "gen", "apple");
  const catalog = join(apple, "Assets.xcassets", "AppIcon.appiconset");
  mkdirSync(catalog, { recursive: true });
  expectFailure(/Contents.json/);
  writeFileSync(join(catalog, "Contents.json"), contents);
  const source = join(temp, "src-tauri", "icons", "ios");
  cpSync(join(root, "src-tauri", "icons", "ios"), source, { recursive: true });
  const seed = () => {
    for (const { filename } of manifest.images) writeFileSync(join(catalog, filename), "template icon");
  };
  const assertSeeded = () => {
    for (const { filename } of manifest.images) assert.equal(readFileSync(join(catalog, filename), "utf8"), "template icon");
  };
  seed();
  const last = manifest.images.at(-1).filename;
  const artwork = readFileSync(join(source, last));
  rmSync(join(source, last));
  expectFailure(new RegExp(last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assertSeeded();
  writeFileSync(join(source, last), artwork);
  const wrongSize = Buffer.from(artwork);
  wrongSize.writeUInt32BE(1, 16);
  writeFileSync(join(source, last), wrongSize);
  expectFailure(/Wrong dimensions/);
  assertSeeded();
  writeFileSync(join(source, last), artwork);
  console.log("PASS: missing manifest, missing artwork and wrong dimensions fail before copying");

  for (const bad of [{ images: [] }, { images: [{ filename: "../outside.png", size: "20x20", scale: "1x" }] }]) {
    writeFileSync(join(catalog, "Contents.json"), JSON.stringify(bad));
    expectFailure(/no image slots|no valid PNG filename/);
    assertSeeded();
  }
  writeFileSync(join(catalog, "Contents.json"), contents);
  console.log("PASS: malformed icon catalog is rejected");

  for (let pass = 0; pass < 2; pass++) {
    const result = invoke("--required");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /synced and verified: 18 slots/);
    for (const { filename } of manifest.images) {
      assert.deepEqual(readFileSync(join(catalog, filename)), readFileSync(join(source, filename)), filename);
    }
    assert.deepEqual(readFileSync(join(catalog, "Contents.json")), contents);
  }
  console.log("PASS: all 18 iPhone/iPad/marketing slots match tracked artwork; manifest preserved; repeat run unchanged");
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
