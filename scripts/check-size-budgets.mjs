#!/usr/bin/env node
// Fails when a hotspot grows past its budget. Counts non-blank, non-comment
// lines only: cutting comments is not a way to meet the budget.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const configPath = path.join(root, "tools", "size-budgets.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const update = process.argv.includes("--update");
const allowRaise = process.argv.includes("--allow-raise");

function codeLines(file) {
  const text = fs.readFileSync(file, "utf8");
  let inBlock = false;
  let count = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("*/")) continue;
    count += 1;
  }
  return count;
}

const SOURCE_EXTENSIONS = new Set([".rs", ".ts", ".tsx", ".js", ".mjs", ".css"]);

function sourceFiles(target) {
  const info = fs.statSync(target);
  if (info.isFile()) return [target];
  if (!info.isDirectory()) return [];
  const files = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(child));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(child);
  }
  return files.sort();
}

let failed = false;
const measured = {};
for (const [rel, entry] of Object.entries(config)) {
  if (rel.startsWith("_")) continue;
  const budget = typeof entry === "number" ? entry : entry.budget;
  const optional = typeof entry === "object" && entry.optional === true;
  if (!Number.isInteger(budget) || budget < 1) {
    console.error(`budget: ${rel} has an invalid budget: ${JSON.stringify(entry)}`);
    failed = true;
    continue;
  }
  if (typeof entry === "object" && entry.previous !== undefined) {
    if (!Number.isInteger(entry.previous) || entry.previous < 1) {
      console.error(`budget: ${rel} has an invalid previous budget: ${JSON.stringify(entry.previous)}`);
      failed = true;
      continue;
    }
    if (!entry.reason || typeof entry.reason !== "string") {
      console.error(`budget: ${rel} records a previous budget but no reason.`);
      failed = true;
      continue;
    }
    if (budget > entry.previous && !entry.reason.includes("split")) {
      console.error(`budget: ${rel} may only exceed its previous value for a pure split; say "split" in reason.`);
      failed = true;
      continue;
    }
  }
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    if (optional) {
      console.log(`budget: skip ${rel} (optional, missing)`);
      continue;
    }
    console.error(`budget: ${rel} is missing. Move its budget to the file that now owns the code.`);
    failed = true;
    continue;
  }
  const files = sourceFiles(file);
  if (!files.length) {
    console.error(`budget: ${rel} contains no source files to measure.`);
    failed = true;
    continue;
  }
  const count = files.reduce((total, source) => total + codeLines(source), 0);
  measured[rel] = count;
  if (update) {
    if (count > budget && !allowRaise) {
      console.error(`budget: refusing to raise ${rel} from ${budget} to ${count}; move a concern out first (or pass --allow-raise with a reason).`);
      failed = true;
    } else {
      console.log(`budget: ${rel}: ${budget} -> ${count}`);
    }
    continue;
  }
  if (count > budget) {
    console.error(`budget: ${rel} is ${count} code lines, over its budget of ${budget}.`);
    console.error("        Move a concern out first, or lower the budget in the split PR. Comments are not counted.");
    failed = true;
  } else {
    console.log(`budget: ok ${rel}: ${count} <= ${budget}`);
  }
}

if (update && !failed) {
  for (const [rel, count] of Object.entries(measured)) {
    const existing = config[rel];
    config[rel] = typeof existing === "object" && existing !== null ? { ...existing, budget: count } : count;
  }
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`budget: wrote ${path.relative(root, configPath)}`);
}
if (failed) process.exit(1);
