// Actual settings/components/store in Chromium; mocked Tauri IPC, no upstream requests.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(process.env.NETWORK_SETTINGS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const expectMissing = process.argv.includes("--expect-missing");
const output = join(root, "test-results", "network-settings", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "Actual Settings/LinePicker/ProxySettings/store, Chromium, mocked IPC", passed: [], errors: [], external: [] };
let vite, browser;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0 } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || "/usr/bin/google-chrome" });
  async function open({ mobile = false, theme = "dark", width = 375, height = 812 } = {}) {
    const context = await browser.newContext({ viewport: mobile ? { width, height } : { width: 1280, height: 900 }, reducedMotion: "reduce",
      ...(mobile ? { userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36" } : {}) });
    const page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
      report.external.push(route.request().url()); return route.abort();
    });
    await page.addInitScript(({ theme }) => {
      localStorage.setItem("hghubx_auto_line", "off");
      localStorage.setItem("hghubx_theme", theme);
      const MAIN = "https://main.fixture.invalid";
      const fixture = { base: MAIN, custom: false, loggedIn: true, calls: [], proxyChanges: 0, lineChanges: 0,
        failState: false, failSave: false, holdTest: false, releaseTest: null,
        proxy: { mode: "system", url: "", effective: null, system_proxy: false, env_proxy: false } };
      window.addEventListener("hg:proxy-changed", () => fixture.proxyChanges++);
      window.addEventListener("hg:line-changed", () => fixture.lineChanges++);
      Object.assign(window, { isTauri: true, networkSettingsFixture: fixture, __TAURI_INTERNALS__: { async invoke(command, args = {}) {
        fixture.calls.push({ command, args });
        if (command === "app_boot") return { strict_security: true, base: fixture.base, user: fixture.loggedIn ? { id: 9, username: "fixture-user" } : null };
        if (command === "debug_log" || command === "playback_log_write" || command === "line_cancel") return;
        if (command === "playback_log_status") return { enabled: false, path: "fixture.log", error: null };
        if (command === "line_state") return { base: fixture.base, custom: fixture.custom, default: MAIN, fixed: [{ name: "固定线路", url: MAIN }] };
        if (command === "line_mirrors") return { source: "fixture", recommended: [], items: [{ url: "https://published.fixture.invalid" }] };
        if (command === "line_custom_set" || command === "line_reset" || command === "line_set") {
          const next = command === "line_reset" ? MAIN : args.url;
          if (next !== fixture.base) fixture.loggedIn = false;
          fixture.base = next; fixture.custom = command === "line_custom_set" && next !== MAIN;
          return command === "line_set" ? fixture.base : { base: fixture.base, custom: fixture.custom };
        }
        if (command === "proxy_state") {
          if (fixture.failState) throw "fixture: 代理读取失败";
          return { ...fixture.proxy };
        }
        if (command === "proxy_set") {
          if (fixture.failSave) throw "fixture: 保存失败，已保持原配置";
          fixture.proxy = { ...fixture.proxy, mode: args.mode, url: args.url || fixture.proxy.url,
            effective: args.mode === "custom" ? "http://127.0.0.1:7890" : null };
          return { ...fixture.proxy };
        }
        if (command === "proxy_test") {
          if (fixture.holdTest) await new Promise(resolve => { fixture.releaseTest = resolve; });
          return { ok: true, status: 200, ms: 42, via: "fixture" };
        }
        throw new Error(`Unexpected IPC: ${command}`);
      } } });
    }, { theme });
    await page.goto(`${origin}tests/line-selection.html`);
    await page.waitForFunction(() => window.lineSelectionSnapshot?.ready);
    return { page, context };
  }
  const calls = (page, command) => page.evaluate(command => window.networkSettingsFixture.calls.filter(row => row.command === command), command);
  const row = (page, name) => page.getByRole("button").filter({ has: page.getByText(name, { exact: true }) });

  if (expectMissing) {
    const { page, context } = await open();
    assert.equal(await row(page, "代理访问").count(), 0);
    await row(page, "播放源").click();
    const dialog = page.getByRole("dialog", { name: "选择播放源" });
    await dialog.getByRole("button").filter({ hasText: "固定线路" }).waitFor();
    assert.equal(await dialog.getByRole("textbox", { name: "镜像地址" }).count(), 0);
    report.passed.push("BASELINE: proxy settings and custom mirror form absent; existing line picker remains usable");
    await context.close();
  } else {
  {
    const { page, context } = await open();
    await row(page, "播放源").click();
    const dialog = page.getByRole("dialog", { name: "选择播放源" });
    const input = dialog.getByRole("textbox", { name: "镜像地址" });
    await input.fill("http://bad.fixture.invalid/path");
    await dialog.getByRole("button", { name: "保存镜像" }).click();
    await dialog.getByRole("alert").waitFor();
    assert.equal((await calls(page, "line_custom_set")).length, 0);
    await input.fill("https://custom.fixture.invalid");
    await dialog.getByRole("button", { name: "保存镜像" }).click();
    await page.waitForFunction(() => window.networkSettingsFixture.custom && window.lineSelectionSnapshot.lineEpoch > 0);
    assert.equal(await page.evaluate(() => window.lineSelectionControls.autoLineEnabled()), false);
    assert.equal(await page.evaluate(() => window.lineSelectionSnapshot.user), null);
    assert.equal(await input.inputValue(), "https://custom.fixture.invalid");
    await dialog.getByRole("button", { name: "恢复主站" }).click();
    await page.waitForFunction(() => window.networkSettingsFixture.base === "https://main.fixture.invalid");
    assert.equal(await input.inputValue(), "");
    assert.equal((await calls(page, "line_reset")).length, 1);
    report.passed.push("Custom HTTPS validation, saved line reflected, manual mode persists, cross-origin user cleared, reset restores main; existing published rows retained");
    await context.close();
  }
  {
    const { page, context } = await open();
    await page.evaluate(() => {
      window.networkSettingsFixture.base = "https://custom.fixture.invalid";
      window.networkSettingsFixture.custom = true;
    });
    await row(page, "播放源").click();
    const dialog = page.getByRole("dialog", { name: "选择播放源" });
    const input = dialog.getByRole("textbox", { name: "镜像地址" });
    await page.waitForFunction(() => document.querySelector("#custom-line-address")?.value === "https://custom.fixture.invalid");
    await dialog.getByRole("button", { name: "保存镜像" }).click();
    await page.waitForFunction(() => window.networkSettingsFixture.lineChanges === 1);
    assert.equal(await page.evaluate(() => window.lineSelectionSnapshot.user?.id), 9);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await row(page, "播放源").click();
    await page.waitForFunction(() => document.querySelector("#custom-line-address")?.value === "https://custom.fixture.invalid");
    assert.equal(await input.inputValue(), "https://custom.fixture.invalid");
    report.passed.push("Saved custom address fills the form after reopen; saving unchanged origin preserves login");
    await context.close();
  }
  {
    const { page, context } = await open();
    await page.evaluate(() => { window.networkSettingsFixture.failState = true; });
    await row(page, "代理访问").click();
    const dialog = page.getByRole("dialog", { name: "代理访问" });
    await dialog.getByRole("alert").waitFor();
    assert.equal(await dialog.getByRole("button", { name: "保存代理" }).isDisabled(), true);
    assert.equal(await dialog.getByRole("button", { name: "测试连接" }).isDisabled(), true);
    await page.evaluate(() => { window.networkSettingsFixture.failState = false; });
    await dialog.getByRole("button", { name: "重新读取" }).click();
    await dialog.getByRole("button", { name: "自定义", exact: true }).click();
    await dialog.getByRole("button", { name: "保存代理" }).click();
    await dialog.getByText("请填写代理地址", { exact: true }).waitFor();
    const input = dialog.getByLabel("代理地址", { exact: true });
    await input.fill("http://fixture-user:fixture-password@127.0.0.1:7890");
    assert.equal(await input.getAttribute("type"), "password");
    await page.evaluate(() => { window.networkSettingsFixture.holdTest = true; });
    await dialog.getByRole("button", { name: "测试连接" }).click();
    await page.waitForFunction(() => !!window.networkSettingsFixture.releaseTest);
    assert.equal(await input.isDisabled(), true);
    assert.equal(await dialog.getByRole("button", { name: "保存代理" }).isDisabled(), true);
    await page.evaluate(() => { window.networkSettingsFixture.releaseTest(); });
    await dialog.getByText("可用 · 42ms", { exact: true }).waitFor();
    await input.fill("http://127.0.0.1:7890");
    assert.equal(await dialog.getByText("可用 · 42ms", { exact: true }).count(), 0);
    await page.evaluate(() => { window.networkSettingsFixture.failSave = true; });
    await dialog.getByRole("button", { name: "保存代理" }).click();
    await dialog.getByText("fixture: 保存失败，已保持原配置", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), "http://127.0.0.1:7890");
    assert.equal(await page.evaluate(() => window.networkSettingsFixture.proxy.mode), "system");
    await page.evaluate(() => { window.networkSettingsFixture.failSave = false; });
    await dialog.getByRole("button", { name: "保存代理" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.networkSettingsFixture.proxyChanges), 1);
    assert.equal(await page.evaluate(() => window.networkSettingsFixture.lineChanges), 0);
    await page.waitForFunction(() => window.lineSelectionSnapshot.lineEpoch > 0);
    assert.equal(await page.evaluate(() => window.lineSelectionSnapshot.user?.id), 9);
    report.passed.push("Proxy load failure blocks actions; retry works; address concealed; test blocks edits/save; edits clear stale result; failed save retains draft; successful save emits proxy-only event and preserves user");
    await row(page, "代理访问").click();
    await dialog.getByLabel("代理地址", { exact: true }).fill("invalid draft");
    await dialog.getByRole("button", { name: "直连", exact: true }).click();
    await dialog.getByRole("button", { name: "保存代理" }).click();
    await dialog.waitFor({ state: "hidden" });
    const saved = (await calls(page, "proxy_set")).at(-1);
    assert.deepEqual(saved.args, { mode: "off", url: "" });
    assert.equal(await page.evaluate(() => window.networkSettingsFixture.proxy.url), "http://127.0.0.1:7890");
    report.passed.push("Switching to direct ignores an invalid unsaved custom draft and retains the previously saved custom address");
    await context.close();
  }
  {
    const { page, context } = await open();
    await row(page, "代理访问").click();
    const dialog = page.getByRole("dialog", { name: "代理访问" });
    await page.evaluate(() => { window.networkSettingsFixture.holdTest = true; });
    await dialog.getByRole("button", { name: "测试连接" }).click();
    await page.waitForFunction(() => !!window.networkSettingsFixture.releaseTest);
    await page.evaluate(() => { window.dispatchEvent(new Event("hg:line-changed")); window.networkSettingsFixture.releaseTest(); });
    await dialog.getByText("线路已更新，请重新检测当前线路", { exact: true }).waitFor();
    assert.equal(await dialog.getByText("可用 · 42ms", { exact: true }).count(), 0);
    report.passed.push("Line changes while proxy test is pending discard the result for the former destination");
    await context.close();
  }
  for (const options of [{ mobile: true, theme: "dark" }, { mobile: true, theme: "light" }, { mobile: true, theme: "dark", width: 812, height: 375 }]) {
    const { page, context } = await open(options);
    await row(page, "代理访问").click();
    const dialog = page.getByRole("dialog", { name: "代理访问" });
    await dialog.getByRole("button", { name: "自定义", exact: true }).click();
    await dialog.getByLabel("代理地址", { exact: true }).fill("https://proxy-with-a-long-host-name.fixture.invalid:8443");
    await dialog.getByRole("button", { name: "显示地址" }).click();
    const widths = await dialog.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
    assert(widths.scroll <= widths.width + 1, JSON.stringify(widths));
    await dialog.getByRole("button", { name: "保存代理" }).scrollIntoViewIfNeeded();
    const box = await dialog.getByRole("button", { name: "保存代理" }).boundingBox();
    assert(box.height >= 44 && box.x >= 0 && box.x + box.width <= (options.width || 375));
    await page.screenshot({ path: join(output, `proxy-${options.theme}-${options.width || 375}.png`), fullPage: true, animations: "disabled" });
    report.passed.push(`Proxy form fits ${options.width || 375}x${options.height || 812} ${options.theme}; long address, reduced motion, scrollable actions and touch targets`);
    await context.close();
  }
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.external, []);
  console.log(expectMissing ? "BASELINE: proxy settings and custom mirror form absent; existing line picker usable; exit=0" : `PASS: ${report.passed.length} network-settings interaction/layout scenarios; no external requests`);
} catch (error) {
  report.error = String(error.stack || error);
  console.error(report.error); process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close(); await vite?.close();
  console.log(`Artifacts: ${output}`);
}
