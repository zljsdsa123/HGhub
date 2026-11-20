#!/usr/bin/env node
// Fails on relative Markdown links that no longer resolve after a file move.
// External URLs and in-page anchors are intentionally outside this gate.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function markdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) output.push(full);
  }
  return output;
}

const files = [
  path.join(root, "README.md"),
  path.join(root, "AGENTS.md"),
  path.join(root, "CLAUDE.md"),
  path.join(root, "rules", "README.md"),
  ...markdownFiles(path.join(root, "docs")),
].filter((file) => fs.existsSync(file));

const broken = [];
let links = 0;
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, "");
    if (!target || target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
      continue;
    }
    links += 1;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
      broken.push(`${path.relative(root, file)} -> ${target}`);
    }
  }
}

if (broken.length) {
  console.error(`docs: ${broken.length} broken relative link(s) across ${files.length} files`);
  for (const line of broken) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`docs: ${links} relative links across ${files.length} files resolve`);
