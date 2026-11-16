// Run only the focused checks for the merged-fix review in GitHub Actions.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "test-results", "round-review");
if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Run this review only in GitHub Actions.");
const baseline = "455f3ab744ba360b50f7af80803e91d2eaee15be";
const scripts = [
  "test-inplace-search-back.mjs",
  "test-inplace-search-focus.mjs",
  "test-clear-history-confirm.mjs",
  "test-account-sync-empty-state.mjs",
  "test-topic-pagination.mjs",
  "test-post-detail-hot.mjs",
];
await mkdir(output, { recursive: true });
const report = { baseline, checks: [] };
async function run(command, cwd) {
  const result = await new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: { ...process.env, BROWSER_EXECUTABLE: process.env.BROWSER_EXECUTABLE || chromium.executablePath() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });
    child.on("error", (error) => resolve({ exit: 1, output: `${output}\n${error.message}` }));
    child.on("close", (code) => resolve({ exit: code ?? 1, output }));
  });
  return { command, cwd, ...result };
}
for (const script of scripts) {
  const command = [process.execPath, join(root, "scripts", script)];
  const result = await run(command, root);
  report.checks.push({ script, command, ...result });
}

// Reproduce one concrete regression before/after, and exercise the rollback on
// an extracted copy. Never reset the checked-out feature branch.
const evidence = join(output, "evidence");
await mkdir(evidence, { recursive: true });
execFileSync("git", ["fetch", "--depth=1", "origin", baseline], { cwd: root, stdio: "pipe" });
execFileSync("git", ["archive", "--format=tar", `--output=${join(evidence, "BASELINE.tar")}`, baseline], { cwd: root });
execFileSync("git", ["archive", "--format=tar.gz", `--output=${join(evidence, "MODIFIED_FILE.tar.gz")}`, "HEAD"], { cwd: root });
const patch = execFileSync("git", ["diff", "--binary", baseline, "HEAD"], { cwd: root });
await writeFile(join(evidence, "DIFF_FILE.patch"), patch);
const rollback = `#!/usr/bin/env bash
set -euo pipefail
target="\${1:?Pass an isolated checkout directory}"
artifact_dir="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
git -C "$target" apply --reverse "$artifact_dir/DIFF_FILE.patch"
printf 'Restored baseline source ${baseline}\\n'
`;
await writeFile(join(evidence, "ROLLBACK.sh"), rollback);
await chmod(join(evidence, "ROLLBACK.sh"), 0o755);
const prepare = async (name, archive) => {
  const target = join(output, name);
  await mkdir(target, { recursive: true });
  execFileSync("tar", ["-xf", join(evidence, archive), "-C", target]);
  execFileSync("git", ["init", "--quiet", target]);
  await symlink(join(root, "node_modules"), join(target, "node_modules"), "dir");
  return target;
};
const baselineCopy = await prepare("baseline-copy", "BASELINE.tar");
const rollbackCopy = await prepare("rollback-copy", "MODIFIED_FILE.tar.gz");
const accountScript = "scripts/test-account-sync-empty-state.mjs";
await copyFile(join(root, accountScript), join(baselineCopy, accountScript));
report.before = await run([process.execPath, accountScript], baselineCopy);
report.rollback = await run(["bash", join(evidence, "ROLLBACK.sh"), rollbackCopy], root);
// The same new regression check must detect the restored old behavior.
await copyFile(join(root, accountScript), join(rollbackCopy, accountScript));
report.restoredBehavior = await run([process.execPath, accountScript], rollbackCopy);
const expectedRegression = result => result.exit !== 0 && result.output.includes("还没有收藏");
const rollbackOkay = report.rollback.exit === 0 && expectedRegression(report.before) && expectedRegression(report.restoredBehavior);
report.checks.push({ script: "baseline and isolated rollback", exit: rollbackOkay ? 0 : 1 });
report.passed = report.checks.filter((check) => check.exit === 0).length;
report.failed = report.checks.length - report.passed;
await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
const digest = data => createHash("sha256").update(data).digest("hex");
const details = {
  changed: ["HLS fatal/manual retry and hidden-page queue", "media configuration generation", "favoritesKnown", "search key event propagation", "topic loaded count wording"],
  paths: ["MODIFIED_FILE.tar.gz", "DIFF_FILE.patch", "VERIFICATION.txt", "ROLLBACK.sh"].map(file => join(evidence, file)),
  baselineCommit: baseline,
  baselineArchiveSha256: digest(await readFile(join(evidence, "BASELINE.tar"))),
  modifiedCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  BASELINE: report.before,
  MODIFIED: report.checks,
  ROLLBACK: report.rollback,
  restoredBehavior: report.restoredBehavior,
  result: { passed: report.passed, failed: report.failed, originalCheckoutRemainsModified: true },
};
await writeFile(join(evidence, "VERIFICATION.txt"), `${JSON.stringify(details, null, 2)}\n`);
// Reopen every deliverable before upload.
for (const file of details.paths) await readFile(file);
console.log(`Round review checks: ${report.passed} passed, ${report.failed} failed.`);
process.exitCode = report.failed ? 1 : 0;
