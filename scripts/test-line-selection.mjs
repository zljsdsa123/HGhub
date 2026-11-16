import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "line-selection", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "Real Settings, LinePicker, store and autoLine in Chromium; mocked Tauri IPC; not native network verification", passed: [], external: [] };
const MAIN = "https://main.fixture.invalid";
const MIRROR = "https://mirror-one.fixture.invalid";
const NEW_KEY = "hghubx_auto_line";
let vite, browser, page;
const errors = [];

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  let executablePath = process.env.BROWSER_EXECUTABLE;
  if (!executablePath) {
    for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
      if (await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
    }
  }
  browser = await chromium.launch({ headless: true, executablePath });

  async function open(seed = {}, mobile = false) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 },
      ...(mobile ? { userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36" } : {}),
    });
    page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
      report.external.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(({ seed, MAIN, MIRROR }) => {
      if (!sessionStorage.getItem("line-fixture-seeded")) {
        localStorage.clear();
        for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
        sessionStorage.setItem("line-fixture-seeded", "1");
      }
      const fixture = { base: MAIN, calls: [], lineChanged: 0, failSet: false, failMirrors: false, autoMode: "success", loggedIn: true, generation: 0, holdAuto: false, autoFinished: 0, autoCancelled: 0, autoWaiters: [] };
      window.addEventListener("hg:line-changed", () => fixture.lineChanged++);
      Object.assign(window, {
        isTauri: true,
        lineSelectionFixture: fixture,
        __TAURI_INTERNALS__: { async invoke(command, args = {}) {
          fixture.calls.push({ command, args });
          if (command === "app_boot") return { strict_security: true, base: fixture.base, user: fixture.loggedIn ? { id: 17, username: "fixture-user" } : null };
          if (command === "debug_log" || command === "playback_log_write") return;
          if (command === "playback_log_status") return { enabled: false, path: "fixture.log", error: null };
          if (command === "proxy_state") return { mode: "system", url: "", effective: null, system_proxy: false, env_proxy: false };
          if (command === "line_state") return { base: fixture.base, default: MAIN, fixed: [
            { name: "固定线路 1", url: MAIN }, { name: "固定线路 2", url: "https://secondary.fixture.invalid" },
          ] };
          if (command === "line_mirrors") {
            if (fixture.failMirrors) throw "fixture: mirror publisher unavailable";
            return { source: "fixture publisher", recommended: [{ host: "recommended.fixture.invalid", url: "https://recommended.fixture.invalid" }], items: [{ host: "mirror-one.fixture.invalid", url: MIRROR }] };
          }
          if (command === "line_set") {
            fixture.generation++;
            if (fixture.failSet) throw "fixture: line rejected";
            fixture.base = args.url;
            fixture.loggedIn = false;
            return fixture.base;
          }
          if (command === "line_cancel") { fixture.generation++; return; }
          if (command === "line_probe") return args.urls.map(url => ({ url, ok: true, status: 200, ms: 42 }));
          if (command === "line_health") return { base: fixture.base, ok: true, ms: 4, status: 200 };
          if (command === "line_try_main") return { previous: fixture.base, base: fixture.base, switched: false, probe: { ok: false, base: MAIN, tier: "main", ms: 5, status: null } };
          if (command === "line_auto") {
            const generation = ++fixture.generation;
            const mode = fixture.autoMode;
            if (fixture.holdAuto) await new Promise(resolve => fixture.autoWaiters.push(resolve));
            const previous = fixture.base;
            const cancelled = generation !== fixture.generation;
            fixture.autoFinished++;
            if (cancelled) {
              fixture.autoCancelled++;
              return { previous, base: previous, switched: false, cancelled: true, pick: { base: MIRROR, tier: "mirror", ms: 34, reason: "mirror-fallback", candidates: [] } };
            }
            if (mode === "all-down") return { previous, base: previous, switched: false, cancelled: false, pick: { base: previous, tier: "none", ms: 0, reason: "all-down", candidates: [] } };
            fixture.base = MIRROR;
            fixture.loggedIn = false;
            return { previous, base: MIRROR, switched: previous !== MIRROR, cancelled: false, pick: { base: MIRROR, tier: "mirror", ms: 34, reason: "mirror-fallback", candidates: [{ tier: "mirror", url: MIRROR, ok: true, reachable: true, ms: 34, status: 200 }] } };
          }
          throw new Error(`Unexpected IPC: ${command}`);
        } },
      });
    }, { seed, MAIN, MIRROR });
    await page.goto(`${origin}tests/line-selection.html`);
    await page.waitForFunction(() => window.lineSelectionSnapshot?.ready);
    return { context, page };
  }

  const calls = (page, command) => page.evaluate(command => window.lineSelectionFixture.calls.filter(call => call.command === command), command);
  const sourceButton = page => page.getByRole("button").filter({ has: page.getByText("播放源", { exact: true }) });

  {
    const { context, page } = await open({ "hg.autoLine": "off" });
    assert.equal(await page.evaluate(() => window.lineSelectionControls.autoLineEnabled()), false);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), NEW_KEY), "off");
    assert.equal(await page.evaluate(() => localStorage.getItem("hg.autoLine")), null);
    assert.equal((await calls(page, "line_auto")).length, 0);
    await page.evaluate(async () => {
      await window.lineSelectionControls.pickLine("fixture-disabled", true);
      window.dispatchEvent(new Event("online"));
    });
    assert.equal((await calls(page, "line_auto")).length, 0);
    await page.reload();
    await page.waitForFunction(() => window.lineSelectionSnapshot?.ready);
    assert.equal(await page.evaluate(() => window.lineSelectionControls.autoLineEnabled()), false);
    assert.equal((await calls(page, "line_auto")).length, 0);
    report.passed.push("Legacy automatic-line opt-out migrates to HGhubX storage, survives reload and suppresses boot/manual/online auto selection");
    await context.close();
  }

  {
    const { context, page } = await open({ "hg.autoLine": "on", [NEW_KEY]: "off" });
    assert.equal(await page.evaluate(() => window.lineSelectionControls.autoLineEnabled()), false);
    assert.equal((await calls(page, "line_auto")).length, 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("hg.autoLine")), null);
    report.passed.push("The HGhubX preference takes precedence over conflicting legacy storage");
    await context.close();
  }

  for (const mobile of [false, true]) {
    const { context, page } = await open({ [NEW_KEY]: "off" }, mobile);
    await sourceButton(page).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.getByText("固定线路 2", { exact: true }).waitFor();
    await dialog.getByText("mirror-one.fixture.invalid", { exact: true }).waitFor();
    await dialog.getByText("recommended.fixture.invalid", { exact: true }).waitFor();
    assert.equal((await calls(page, "line_mirrors")).length, 1);
    await dialog.getByRole("button").filter({ hasText: "mirror-one.fixture.invalid" }).click();
    await page.waitForFunction(() => window.lineSelectionFixture.base === "https://mirror-one.fixture.invalid" && window.lineSelectionSnapshot.lineEpoch === 1);
    assert.equal(await page.evaluate(() => window.lineSelectionFixture.lineChanged), 1);
    assert.equal(await page.evaluate(() => window.lineSelectionSnapshot.user), null);
    assert.deepEqual((await calls(page, "line_set")).map(call => call.args), [{ url: MIRROR }]);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await sourceButton(page).getByText("mirror-one.fixture.invalid", { exact: true }).waitFor();
    await sourceButton(page).click();
    await dialog.waitFor();
    assert.equal((await calls(page, "line_mirrors")).length, 1);
    await page.screenshot({ path: join(output, mobile ? "line-picker-android.png" : "line-picker-desktop.png"), fullPage: true, animations: "disabled" });
    report.passed.push(`${mobile ? "Android-sized sheet" : "Desktop dialog"}: Settings opens the real picker; fixed/recommended/mirror rows load; successful selection updates current line, store epoch and settings host and clears stale user UI`);
    await context.close();
  }

  {
    const { context, page } = await open({ [NEW_KEY]: "off" });
    await sourceButton(page).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("mirror-one.fixture.invalid", { exact: true }).waitFor();
    await page.evaluate(() => { window.lineSelectionFixture.failSet = true; });
    await dialog.getByRole("button").filter({ hasText: "mirror-one.fixture.invalid" }).click();
    await page.getByText("fixture: line rejected", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.lineSelectionFixture.base), MAIN);
    assert.equal(await page.evaluate(() => window.lineSelectionFixture.lineChanged), 0);
    assert.equal(await page.evaluate(() => window.lineSelectionSnapshot.lineEpoch), 0);
    assert.equal(await page.evaluate(() => window.lineSelectionSnapshot.user?.id), 17);
    report.passed.push("Rejected manual selection retains line, login UI and content epoch without emitting line-changed");
    await context.close();
  }

  {
    const { context, page } = await open({ [NEW_KEY]: "off" });
    const toggle = page.getByRole("switch", { name: "自动选择线路", exact: true });
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await toggle.click();
    await page.waitForFunction(() => window.lineSelectionFixture.base === "https://mirror-one.fixture.invalid");
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    assert.equal(await page.evaluate(key => localStorage.getItem(key), NEW_KEY), "on");
    await sourceButton(page).getByText("mirror-one.fixture.invalid", { exact: true }).waitFor();
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    assert.equal(await page.evaluate(key => localStorage.getItem(key), NEW_KEY), "off");
    const before = (await calls(page, "line_auto")).length;
    await page.evaluate(async () => { window.dispatchEvent(new Event("online")); await window.lineSelectionControls.pickLine("disabled-after-enable", true); });
    assert.equal((await calls(page, "line_auto")).length, before);
    report.passed.push("The real automatic-line switch persists its state, selects on enable, refreshes settings host and prevents later selection after disable");
    await context.close();
  }

  {
    const { context, page } = await open({ [NEW_KEY]: "on" });
    await page.waitForFunction(() => window.lineSelectionFixture.base === "https://mirror-one.fixture.invalid" && window.lineSelectionSnapshot.ready);
    await page.evaluate(() => { window.lineSelectionFixture.autoMode = "all-down"; });
    const before = await page.evaluate(() => ({ base: window.lineSelectionFixture.base, changes: window.lineSelectionFixture.lineChanged, epoch: window.lineSelectionSnapshot.lineEpoch }));
    await page.evaluate(() => window.lineSelectionControls.pickLine("fixture-all-down", true));
    const after = await page.evaluate(() => ({ base: window.lineSelectionFixture.base, changes: window.lineSelectionFixture.lineChanged, epoch: window.lineSelectionSnapshot.lineEpoch }));
    assert.deepEqual(after, before);
    await page.getByText("线路全部不可用，请检查网络或代理", { exact: true }).waitFor();
    report.passed.push("All-down automatic selection keeps the existing line and content epoch and reports failure instead of a successful switch");
    await context.close();
  }

  {
    const { context, page } = await open({ [NEW_KEY]: "off" });
    const toggle = page.getByRole("switch", { name: "自动选择线路", exact: true });
    await page.evaluate(() => { window.lineSelectionFixture.holdAuto = true; });
    await toggle.click();
    await page.waitForFunction(() => window.lineSelectionFixture.autoWaiters.length === 1);
    await toggle.click();
    await page.waitForFunction(() => window.lineSelectionFixture.calls.some(call => call.command === "line_cancel"));
    await page.evaluate(() => { window.lineSelectionFixture.autoWaiters.splice(0).forEach(resolve => resolve()); });
    await page.waitForFunction(() => window.lineSelectionFixture.autoFinished === 1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.lineSelectionFixture.base), MAIN);
    assert.equal(await page.evaluate(() => window.lineSelectionFixture.autoCancelled), 1);
    assert.equal(await page.evaluate(() => window.lineSelectionFixture.lineChanged), 0);
    assert.equal(await page.evaluate(() => window.lineSelectionSnapshot.lineEpoch), 0);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), NEW_KEY), "off");
    const sequence = (await page.evaluate(() => window.lineSelectionFixture.calls)).map(call => call.command);
    assert(sequence.indexOf("line_cancel") > sequence.indexOf("line_auto"));
    report.passed.push("Disabling auto selection while its IPC request is pending invokes cancellation; a delayed cancelled response cannot switch lines or emit line-changed (generation-aware IPC fixture)");
    await context.close();
  }

  {
    const { context, page } = await open({ [NEW_KEY]: "off" });
    const toggle = page.getByRole("switch", { name: "自动选择线路", exact: true });
    await page.evaluate(() => { window.lineSelectionFixture.holdAuto = true; });
    await toggle.click();
    await page.waitForFunction(() => window.lineSelectionFixture.autoWaiters.length === 1);
    await sourceButton(page).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("固定线路 2", { exact: true }).waitFor();
    await dialog.getByRole("button").filter({ hasText: "固定线路 2" }).click();
    await page.waitForFunction(() => window.lineSelectionFixture.base === "https://secondary.fixture.invalid" && window.lineSelectionSnapshot.lineEpoch === 1);
    await page.evaluate(() => { window.lineSelectionFixture.autoWaiters.splice(0).forEach(resolve => resolve()); });
    await page.waitForFunction(() => window.lineSelectionFixture.autoFinished === 1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.lineSelectionFixture.base), "https://secondary.fixture.invalid");
    assert.equal(await page.evaluate(() => window.lineSelectionFixture.autoCancelled), 1);
    assert.equal(await page.evaluate(() => window.lineSelectionFixture.lineChanged), 1);
    assert.equal(await page.evaluate(() => window.lineSelectionSnapshot.lineEpoch), 1);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), NEW_KEY), "off");
    const sequence = (await page.evaluate(() => window.lineSelectionFixture.calls)).map(call => call.command);
    assert(sequence.indexOf("line_cancel") > sequence.indexOf("line_auto"));
    assert(sequence.indexOf("line_set") > sequence.indexOf("line_cancel"));
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await sourceButton(page).getByText("secondary.fixture.invalid", { exact: true }).waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    report.passed.push("Manual selection cancels the pending automatic request before line_set, pauses auto mode and remains selected when stale auto results arrive (generation-aware IPC fixture)");
    await context.close();
  }

  assert.deepEqual(errors, []);
  assert.deepEqual(report.external, []);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = String(error.stack || error);
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
  console.log(`Artifacts: ${output}`);
}
