#!/usr/bin/env node
/** Generate the iOS square artwork from the unmasked source before every build. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import zlib from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src-tauri", "icons", "ios", "source.svg");
const target = join(root, "src-tauri", "icons", "ios");
const catalog = JSON.parse(readFileSync(join(root, "scripts", "fixtures", "ios-appicon-contents.json"), "utf8"));
const slots = catalog.images;

function pngInfo(data) {
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("not a PNG");
  let offset = 8;
  const chunks = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const kind = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    chunks.push([kind, body]);
    offset += length + 12;
  }
  const ihdr = chunks.find(([kind]) => kind === "IHDR")?.[1];
  if (!ihdr) throw new Error("missing IHDR");
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  const depth = ihdr[8], colorType = ihdr[9], interlace = ihdr[12];
  if (depth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) throw new Error("unsupported PNG encoding");
  const channels = colorType === 6 ? 4 : 3, stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter(([kind]) => kind === "IDAT").map(([, body]) => body)));
  if (raw.length !== (stride + 1) * height) throw new Error("invalid PNG scanline length");
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const above = previous[x];
      const corner = x >= channels ? previous[x - channels] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = above;
      else if (filter === 3) prediction = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const p = left + above - corner;
        const pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - corner);
        prediction = pa <= pb && pa <= pc ? left : pb <= pc ? above : corner;
      } else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      row[x] = (row[x] + prediction) & 255;
    }
    if (colorType === 6) {
      for (let x = 3; x < stride; x += 4) if (row[x] !== 255) throw new Error("iOS artwork must be fully opaque");
    }
    previous = row;
  }
  return { width, height };
}

if (!existsSync(source)) throw new Error(`Missing iOS source: ${source}`);
const sourceSvg = readFileSync(source, "utf8");
if (/\brx\s*=|\bstroke\s*=/.test(sourceSvg.split("<g", 1)[0])) {
  throw new Error("iOS background must be square and unmasked; remove background rx/stroke");
}

const temp = mkdtempSync(join(tmpdir(), "hghubx-ios-icons-"));
try {
  // Invoke the installed Tauri CLI through the current Node process. Spawning
  // A package-manager wrapper from a Tauri beforeBuildCommand returns EINVAL on Windows runners.
  const tauriCli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  execFileSync(process.execPath, [tauriCli, "icon", "--output", temp, source], { cwd: root, stdio: "inherit" });
  const generated = join(temp, "ios");
  const generatedNames = readdirSync(generated).filter(name => name.endsWith(".png")).sort();
  const expectedNames = slots.map(slot => slot.filename).sort();
  if (JSON.stringify(generatedNames) !== JSON.stringify(expectedNames)) throw new Error("Tauri generated iOS slots differ from Contents.json");
  for (const slot of slots) {
    const [width, height] = slot.size.split("x").map(value => Number(value) * Number(slot.scale[0]));
    const sourcePng = join(generated, slot.filename);
    const info = pngInfo(readFileSync(sourcePng));
    if (info.width !== width || info.height !== height) throw new Error(`Wrong dimensions for ${slot.filename}`);
    copyFileSync(sourcePng, join(target, slot.filename));
  }
  console.log(`[icons] generated and verified iOS artwork: ${slots.length} opaque slots`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
