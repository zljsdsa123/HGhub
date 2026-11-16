#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] || new URL("..", import.meta.url).pathname);
const css = readFileSync(join(root, "src", "styles", "ios.css"), "utf8");
const cards = readFileSync(join(root, "src", "components", "cards.tsx"), "utf8");

assert.match(cards, /ios-poster-art[\s\S]*ScoreBadge/, "MediaCard must render the score badge inside the cover layer");
assert.match(css, /\.ios-score-badge\s*\{[^}]*position:absolute[^}]*top:9px[^}]*right:9px/s,
  "The shared score badge must use the cover's top-right inset");
assert.doesNotMatch(css, /\.ios-poster-art\.has-poster-badge>\.ios-score-badge\s*\{[^}]*top:42px/s,
  "A status badge must not push the score into the middle of the cover");
console.log("PASS: shared MediaCard score stays in the cover top-right corner across desktop, Android, and iOS shells");
