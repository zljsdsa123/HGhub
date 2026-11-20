#!/usr/bin/env node
// Release gates read different version fields. Keep package.json,
// tauri.conf.json, Cargo.toml and Cargo.lock on one version before a tag.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json"));
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargo = read("src-tauri/Cargo.toml");
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] ?? "";
const lock = read("src-tauri/Cargo.lock");
const hghubxBlock = lock.split("[[package]]").find((block) => /^\s*name\s*=\s*"hghubx"\s*$/m.test(block));
const lockVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(hghubxBlock ?? "")?.[1] ?? "";

const versions = {
  "package.json": pkg.version,
  "src-tauri/tauri.conf.json": tauri.version,
  "src-tauri/Cargo.toml": cargoVersion,
  "src-tauri/Cargo.lock (hghubx)": lockVersion,
};
for (const [file, version] of Object.entries(versions)) console.log(`${file}: ${version || "<missing>"}`);

const unique = new Set(Object.values(versions));
if (unique.size !== 1 || [...unique].some((value) => !value)) {
  console.error("release-check: version fields disagree; run scripts/set-version.mjs with the release version.");
  process.exit(1);
}
const versionCode = tauri.bundle?.android?.versionCode;
if (!Number.isInteger(versionCode) || versionCode < 1) {
  console.error("release-check: src-tauri/tauri.conf.json has no bundle.android.versionCode.");
  process.exit(1);
}
const parsed = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(pkg.version ?? "");
if (!parsed) {
  console.error(`release-check: invalid version format "${pkg.version}".`);
  process.exit(1);
}
const [, major, minor, patch] = parsed.map(Number);
const expectedCode = major * 1_000_000 + minor * 1_000 + patch;
if (versionCode !== expectedCode) {
  console.error(`release-check: bundle.android.versionCode=${versionCode} does not match expected ${expectedCode} for ${pkg.version}; run scripts/set-version.mjs.`);
  process.exit(1);
}
console.log(`release-check: ok ${pkg.version}, android versionCode=${versionCode}`);
