// Run the focused current-code regression checks.
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "test-results", "round-review");
let browserExecutable = process.env.BROWSER_EXECUTABLE;
if (!browserExecutable) {
  for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (await access(candidate).then(() => true, () => false)) { browserExecutable = candidate; break; }
  }
}
if (!browserExecutable) browserExecutable = chromium.executablePath();
const scripts = [
  "test-inplace-search-back.mjs",
  "test-network-settings.mjs",
];
await mkdir(output, { recursive: true });
const report = { checks: [] };
async function run(command, cwd) {
  const result = await new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: { ...process.env, ...(browserExecutable ? { BROWSER_EXECUTABLE: browserExecutable } : {}) },
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

report.passed = report.checks.filter((check) => check.exit === 0).length;
report.failed = report.checks.length - report.passed;
await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Round review checks: ${report.passed} passed, ${report.failed} failed.`);
process.exitCode = report.failed ? 1 : 0;
