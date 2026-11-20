#!/usr/bin/env node
// The optional tauri.tv.conf.json selects the TV frontend and Android package.
// Standard builds do not load this hook. The shared Android workflow copies
// this config to tauri.android.conf.json before it runs `tauri android init`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, VITE_APP_EDITION: "tv" };
const dev = process.argv.includes("--dev");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`[tv] ${command} 被 ${result.signal} 中断`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runFrontend(script) {
  // pnpm invokes the Tauri CLI with npm_execpath pointing at its JavaScript entry.
  // Calling that entry with Node avoids Windows' execFile/spawn pnpm.cmd EINVAL.
  const packageManager = process.env.npm_execpath;
  if (packageManager && existsSync(packageManager) && /\.(?:[cm]?js)$/i.test(packageManager)) {
    run(process.execPath, [packageManager, "run", script]);
  } else if (process.platform === "win32") {
    // Fixed arguments only: let cmd.exe resolve the package-manager shim.
    run("pnpm.cmd", ["run", script], { shell: true });
  } else {
    run("pnpm", ["run", script]);
  }
}

function prepareAndroid() {
  for (const script of [
    "sync-android-icons.mjs",
    "patch-android-splash.mjs",
    "patch-android-tv.mjs",
  ]) {
    run(process.execPath, [join(root, "scripts", script)]);
  }
}

if (dev) {
  // The dev server is long-lived. Prepare the already initialized native
  // project before starting it so `tauri android dev` gets the TV policy too.
  prepareAndroid();
  runFrontend("dev");
} else {
  runFrontend("build");
  prepareAndroid();
}
