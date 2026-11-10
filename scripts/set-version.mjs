#!/usr/bin/env node
/**
 * 写版本号，并同步算出 Android versionCode。
 *
 * 用法：
 *   node scripts/set-version.mjs 1.2.1+hg.1
 *
 * 为什么要这个脚本：
 *   Tauri 自己推导 versionCode 时会忽略 `+hg.1` 这种后缀，于是
 *   1.2.0 和 1.2.0+hg.1 得到同一个 1002000。同一串号装不上升级感，
 *   Windows 的 NSIS 也认为「版本没变」。所以这里按 major.minor.patch
 *   算出明确的值写进 bundle.android.versionCode，CI 和本地都走同一条路。
 *
 * 公式与 Tauri 内部一致：major * 1_000_000 + minor * 1_000 + patch
 *   1.2.0  -> 1002000
 *   1.2.1  -> 1002001
 *   1.10.3 -> 1010003
 */
import fs from "node:fs";
import path from "node:path";

const raw = (process.argv[2] || "").trim();
if (!raw) {
  console.error("用法: node scripts/set-version.mjs <major.minor.patch[+build]>");
  process.exit(1);
}

const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw);
if (!m) {
  console.error(`版本号格式不对: ${raw}（要 1.2.3 或 1.2.3+hg.1 这种）`);
  process.exit(1);
}

const [, major, minor, patch] = m.map(Number);
if (minor > 999 || patch > 999) {
  console.error("minor / patch 超过 999，versionCode 会撞车，换个号");
  process.exit(1);
}
const versionCode = major * 1_000_000 + minor * 1_000 + patch;

const root = path.resolve(process.cwd());

function update(rel, fn) {
  const p = path.join(root, rel);
  const json = JSON.parse(fs.readFileSync(p, "utf8"));
  fn(json);
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + "\n");
  console.log(`  ${rel} -> ${json.version}${json.bundle?.android?.versionCode ? ` (versionCode ${json.bundle.android.versionCode})` : ""}`);
}

update("package.json", (j) => {
  j.version = raw;
});

update("src-tauri/tauri.conf.json", (j) => {
  j.version = raw;
  j.bundle = j.bundle ?? {};
  j.bundle.android = { ...(j.bundle.android ?? {}), versionCode };
});

/* Cargo 侧也要跟着走：`check_update` 里的「当前版本」读的是 CARGO_PKG_VERSION，
   只改 package.json 会出现「关于页 1.2.1、更新检查 1.2.0」的错位。 */
const CARGO_PKG = "huangguo-client";

function setCargoToml(rel) {
  const p = path.join(root, rel);
  const lines = fs.readFileSync(p, "utf8").split("\n");
  let done = false;
  const out = lines.map((line) => {
    // 只换 [package] 段的第一处裸 version（依赖里的 { version = "1" } 不匹配行首）
    if (!done && /^version\s*=\s*"/.test(line)) {
      done = true;
      return line.replace(/^version\s*=\s*"[^"]*"/, `version = "${raw}"`);
    }
    return line;
  });
  if (!done) throw new Error(`${rel} 里没找到 version = "..."`);
  fs.writeFileSync(p, out.join("\n"));
  console.log(`  ${rel} -> ${raw}`);
}

function setCargoLock(rel, pkgName) {
  const p = path.join(root, rel);
  const blocks = fs.readFileSync(p, "utf8").split("[[package]]");
  let done = false;
  const out = blocks.map((block) => {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block);
    if (!name || name[1] !== pkgName) return block;
    done = true;
    return block.replace(/(^\s*version\s*=\s*)"[^"]*"/m, `$1"${raw}"`);
  });
  if (!done) throw new Error(`${rel} 里没找到 ${pkgName}`);
  fs.writeFileSync(p, out.join("[[package]]"));
  console.log(`  ${rel} -> ${raw} (${pkgName})`);
}

setCargoToml("src-tauri/Cargo.toml");
setCargoLock("src-tauri/Cargo.lock", CARGO_PKG);

console.log(`versionName=${raw}  versionCode=${versionCode}`);
