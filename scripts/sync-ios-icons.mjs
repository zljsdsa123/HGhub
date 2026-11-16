#!/usr/bin/env node
// tauri ios init writes template icons. Apply the tracked HGhubX artwork before actool runs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apple = join(root, "src-tauri", "gen", "apple");
const source = join(root, "src-tauri", "icons", "ios");
const catalog = join(apple, "Assets.xcassets", "AppIcon.appiconset");
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

try {
  if (!existsSync(apple)) {
    if (process.argv.includes("--required")) throw new Error("Apple project missing; run tauri ios init first");
    console.log("[icons] iOS skipped: Apple project not generated");
  } else {
    const manifest = JSON.parse(readFileSync(join(catalog, "Contents.json"), "utf8"));
    if (!Array.isArray(manifest.images) || !manifest.images.length) {
      throw new Error("AppIcon Contents.json has no image slots");
    }
    // Validate every slot before writing, so missing artwork never leaves a mixed icon set.
    const images = manifest.images.map(({ filename, size, scale }) => {
      if (typeof filename !== "string" || basename(filename) !== filename || !filename.endsWith(".png")) {
        throw new Error("AppIcon slot has no valid PNG filename");
      }
      if (!/^\d+(?:\.\d+)?x\d+(?:\.\d+)?$/.test(size) || !/^[123]x$/.test(scale)) {
        throw new Error(`Invalid size or scale for ${filename}`);
      }
      const [width, height] = size.split("x").map(value => Number(value) * Number(scale[0]));
      const data = readFileSync(join(source, filename));
      if (data.length < 33 || !data.subarray(0, 8).equals(signature) || data.toString("ascii", 12, 16) !== "IHDR") {
        throw new Error(`Invalid PNG: ${filename}`);
      }
      if (data.readUInt32BE(16) !== width || data.readUInt32BE(20) !== height) {
        throw new Error(`Wrong dimensions for ${filename}; expected ${width}x${height}`);
      }
      return { filename, data };
    });
    for (const { filename, data } of images) {
      const destination = join(catalog, filename);
      if (!existsSync(destination) || !readFileSync(destination).equals(data)) writeFileSync(destination, data);
      if (!readFileSync(destination).equals(data)) throw new Error(`Icon verification failed: ${filename}`);
    }
    console.log(`[icons] iOS synced and verified: ${images.length} slots`);
  }
} catch (error) {
  console.error(`[icons] iOS sync failed: ${error.message}`);
  process.exitCode = 1;
}
