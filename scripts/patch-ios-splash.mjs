#!/usr/bin/env node
/**
 * 给生成的 iOS 工程补上「启动屏背景色」，消除启动时的白/黑屏闪烁。
 *
 * iOS 启动屏背景走 Info.plist 的 UILaunchScreen → UIColorName，颜色本身要放在
 * Assets.xcassets 里。这里生成 LaunchBackground.colorset，build-ios-unsigned.sh
 * 会在 xcodebuild 前用 PlistBuddy 把 UILaunchScreen 指向它。
 *
 * 颜色固定为深色品牌色 #071218，与 src/styles/launch.css 的 --launch-bg、
 * index.html 首帧背景一致。
 *
 * 用法：
 *   node scripts/patch-ios-splash.mjs
 *   （由 scripts/build-ios-unsigned.sh 在构建前调用）
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apple = join(root, "src-tauri", "gen", "apple");

if (!existsSync(apple)) {
  console.log("[splash] iOS 跳过：gen/apple 还没生成");
  process.exit(0);
}

// #071218 的 sRGB 分量
const color = {
  "color-space": "srgb",
  components: { alpha: "1.000", blue: "0x18", green: "0x12", red: "0x07" },
};

const colorsetDir = join(apple, "Assets.xcassets", "LaunchBackground.colorset");
mkdirSync(colorsetDir, { recursive: true });
writeFileSync(
  join(colorsetDir, "Contents.json"),
  JSON.stringify(
    {
      colors: [{ color, idiom: "universal" }],
      info: { author: "xcode", version: 1 },
    },
    null,
    2,
  ) + "\n",
);

console.log("[splash] iOS 启动屏颜色资源已写入 → #071218");