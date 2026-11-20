#!/usr/bin/env node
// Runs the stable browser fixtures that do not need ffmpeg, a real Tauri app,
// or upstream network access. Full playback stays in its own workflow.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tests = [
  ["api-loading", "scripts/test-api-loading.mjs"],
  ["storage-migration", "scripts/test-storage-migration.mjs"],
  ["line-selection", "scripts/test-line-selection.mjs"],
  ["diagnostic-copy", "scripts/test-diagnostic-copy.mjs"],
  ["ui-feedback", "scripts/test-ui-feedback.mjs"],
  ["home-controls", "tests/test-home-controls.mjs"],
  ["account-sync", "scripts/test-account-sync-empty-state.mjs"],
];

const failed = [];
for (const [name, script] of tests) {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(process.execPath, [resolve(root, script)], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    timeout: 8 * 60 * 1000,
    killSignal: "SIGKILL",
  });
  if (result.error) {
    console.error(`FAIL ${name}: ${result.error.message}`);
    failed.push(name);
    break;
  }
  if (result.status !== 0) {
    console.error(`FAIL ${name}: exit ${result.status ?? "signal"}${result.signal ? ` (${result.signal})` : ""}`);
    failed.push(name);
    break;
  }
  console.log(`PASS ${name}`);
}

if (failed.length) {
  console.error(`\nsmoke: ${failed.length} of ${tests.length} failed (${failed.join(", ")})`);
  process.exit(1);
}
console.log(`\nsmoke: ${tests.length}/${tests.length} passed`);
