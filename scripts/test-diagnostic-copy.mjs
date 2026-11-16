import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "diagnostic-copy", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "Real Settings and clipboard helper; mocked Tauri IPC; not native iOS verification", passed: [], external: [] };
let vite, browser, page;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
    report.external.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript(() => {
    const fixture = { delay: 0, failDiag: false, failCopy: false, emptyLog: false, failRead: false, diagCalls: 0, nativeCopies: [], webCopies: 0, calls: [] };
    Object.assign(window, {
      isTauri: true,
      diagnosticCopyFixture: fixture,
      __TAURI_INTERNALS__: { async invoke(command, args = {}) {
        fixture.calls.push(command);
        if (command === "app_boot") return { strict_security: true, base: "https://fixture.invalid" };
        if (command === "line_state") return { base: "https://fixture.invalid", fixed: [] };
        if (command === "proxy_state") return { mode: "custom", url: "http://127.0.0.1:7897", effective: "http://127.0.0.1:7897" };
        if (command === "playback_log_status") return { enabled: false, path: "playback.log", error: null };
        if (command === "playback_log_write" || command === "debug_log") return;
        if (command === "net_diag") {
          fixture.diagCalls++;
          await new Promise(done => setTimeout(done, fixture.delay));
          if (fixture.failDiag) throw "fixture: diagnostic unavailable";
          return { verdict: "ok_proxy", summary: "应用 HTTP 请求已成功", host: "fixture.invalid", base: "https://fixture.invalid", dns: { count: 1 }, tcp: { ok: false, timeout: true, proxy_bypassed: true, family: "IPv6" }, http: { status: 200, proxy_configured: true }, env: { app_proxy_mode: "custom", app_proxy: "http://127.0.0.1:7897" }, runtime: { os: "linux", ver: "fixture" } };
        }
        if (command === "playback_log_read") {
          await new Promise(done => setTimeout(done, 30));
          if (fixture.failRead) throw new Error("fixture: log unavailable");
          return fixture.emptyLog ? "" : '{"event":"fixture.playback","data":{"unicode":"诊断日志"}}\n';
        }
        if (command === "plugin:clipboard-manager|write_text") {
          if (fixture.failCopy) throw "fixture: clipboard unavailable";
          fixture.nativeCopies.push(args.text);
          return;
        }
        throw new Error(`Unexpected IPC: ${command}`);
      } },
    });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async () => { fixture.webCopies++; throw new DOMException("The request is not allowed by the user agent", "NotAllowedError"); },
    } });
  });
  const load = async () => {
    await page.goto(`${origin}tests/diagnostic-copy.html`);
    await page.waitForFunction(() => !document.querySelector('[aria-label="播放诊断日志"]').disabled);
  };
  const networkButton = () => page.getByRole("button").filter({ has: page.getByText("网络诊断", { exact: true }) });

  await load();
  await page.evaluate(() => { window.diagnosticCopyFixture.delay = 5500; });
  await networkButton().click();
  await page.waitForFunction(() => window.diagnosticCopyFixture.nativeCopies.length === 1);
  const first = await page.evaluate(() => window.diagnosticCopyFixture);
  assert.equal(first.webCopies, 0);
  assert(first.nativeCopies[0].includes("【HGhubX 网络诊断】") && first.nativeCopies[0].includes('"status": 200'));
  assert(first.nativeCopies[0].includes("直连探测（绕过应用 HTTP 代理） · IPv6 · 超时"));
  assert(first.nativeCopies[0].includes("检测到匹配的应用 HTTP 代理配置"));
  assert(first.nativeCopies[0].includes("── 应用代理") && first.nativeCopies[0].includes("自定义代理"));
  await page.getByText(/诊断已复制/).waitFor();
  report.passed.push("After 5.5 seconds of async diagnostics, copy the complete report through native IPC while web clipboard writes reject");

  await load();
  await page.evaluate(() => { window.diagnosticCopyFixture.failCopy = true; });
  await networkButton().click();
  const saved = page.getByRole("textbox", { name: "网络诊断报告" });
  await saved.waitFor();
  assert((await saved.inputValue()).includes("应用 HTTP 请求已成功"));
  assert.equal(await page.getByText(/网络诊断失败：/).count(), 0);
  await page.screenshot({ path: join(output, "report-fallback.png"), fullPage: true, animations: "disabled" });
  await page.evaluate(() => { window.diagnosticCopyFixture.failCopy = false; });
  await page.getByRole("button", { name: "复制报告", exact: true }).click();
  await page.waitForFunction(() => window.diagnosticCopyFixture.nativeCopies.length === 1);
  assert.equal(await page.evaluate(() => window.diagnosticCopyFixture.diagCalls), 1);
  await page.getByText("网络诊断报告已复制", { exact: true }).waitFor();
  report.passed.push("Clipboard failure retains the report; retry copies it without running diagnostics again");

  await load();
  await page.evaluate(() => { window.diagnosticCopyFixture.failDiag = true; });
  await networkButton().click();
  await page.getByText("网络诊断失败：fixture: diagnostic unavailable", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.diagnosticCopyFixture.nativeCopies.length), 0);
  assert.equal(await page.getByRole("textbox", { name: "网络诊断报告" }).count(), 0);
  report.passed.push("Diagnostic failure is distinct from clipboard failure and never reports a successful copy");

  await load();
  await page.getByRole("button").filter({ has: page.getByText("复制播放诊断日志", { exact: true }) }).click();
  await page.waitForFunction(() => window.diagnosticCopyFixture.nativeCopies.length === 1);
  assert.equal(await page.evaluate(() => window.diagnosticCopyFixture.nativeCopies[0]), '{"event":"fixture.playback","data":{"unicode":"诊断日志"}}\n');
  assert.equal(await page.evaluate(() => window.diagnosticCopyFixture.webCopies), 0);
  report.passed.push("Playback logs use the same native copy path after async reading, preserving Unicode and newlines");

  for (const failure of ["emptyLog", "failRead"]) {
    await load();
    await page.evaluate(key => { window.diagnosticCopyFixture[key] = true; }, failure);
    await page.getByRole("button").filter({ has: page.getByText("复制播放诊断日志", { exact: true }) }).click();
    await page.getByText(failure === "emptyLog" ? "尚无诊断日志，请开启后复现问题" : "fixture: log unavailable", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.diagnosticCopyFixture.nativeCopies.length), 0);
  }
  report.passed.push("Empty or unreadable logs are not copied");

  await load();
  await page.evaluate(() => { window.diagnosticCopyFixture.failCopy = true; });
  await page.getByRole("button").filter({ has: page.getByText("复制播放诊断日志", { exact: true }) }).click();
  await page.getByText("复制日志失败", { exact: true }).waitFor();
  assert.equal(await page.getByText("播放诊断日志已复制", { exact: true }).count(), 0);
  report.passed.push("Native playback log copy failure displays failure rather than a success message");

  await load();
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }); });
  await networkButton().click();
  await page.waitForFunction(() => window.diagnosticCopyFixture.nativeCopies.length === 1);
  const unsupported = await page.evaluate(async () => {
    window.isTauri = false;
    try { await window.copyFixtureText("unavailable"); return "unexpected success"; }
    catch (error) { return error.message; }
  });
  assert.equal(unsupported, "当前环境不支持复制，请在应用中重试");
  report.passed.push("Native copy works without navigator.clipboard; browser-only absence rejects instead of claiming success");

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
