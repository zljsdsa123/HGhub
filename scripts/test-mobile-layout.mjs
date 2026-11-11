// Exercise the real App and its mobile navigation; only Tauri IPC is replaced.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "mobile-layout", new Date().toISOString().replace(/[:.]/g, "-"));
const userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";
const viewports = [{ width: 320, height: 694 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }];
const tabs = ["首页", "搜索", "分类", "我的"];
const report = {
  environment: { browser: "Chromium with iPhone UA", transport: "real App; Tauri IPC mocked; no upstream traffic", limitation: "Does not replace native iOS/WKWebView verification", userAgent },
  cases: [], external: [], pageErrors: [],
};
await mkdir(output, { recursive: true });
let vite, browser, page;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({ userAgent, isMobile: true, hasTouch: true, viewport: viewports[0] });
  await context.addInitScript(() => {
    const fixture = { calls: [], unexpected: [] };
    const emptyPage = { items: [], pagination: { page: 1, pages: 1, size: 8, total: 0 } };
    Object.assign(window, {
      mobileLayoutFixture: fixture,
      __TAURI_INTERNALS__: { invoke(cmd, args = {}) {
        fixture.calls.push({ cmd, args });
        if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid", strict_security: true });
        if (cmd === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
        if (cmd === "debug_log") return Promise.resolve();
        if (cmd === "line_auto") return Promise.resolve({ base: "https://fixture.invalid", previous: "https://fixture.invalid", switched: false, pick: { tier: "main", ms: 1, reason: "fixture", candidates: [] } });
        if (["api_feed", "api_category", "api_posts", "api_search_hot"].includes(cmd)) return Promise.resolve(emptyPage);
        // App's development-only playback self-test must not fetch media upstream.
        if (cmd === "api_play") return Promise.reject("Layout fixture has no playback media");
        fixture.unexpected.push(cmd);
        return Promise.reject(`Unexpected IPC: ${cmd}`);
      } },
    });
  });
  page = await context.newPage();
  page.on("pageerror", error => report.pageErrors.push(error.message));
  await page.route("**/*", route => {
    const url = route.request().url();
    if (new URL(url).origin === new URL(origin).origin) return route.continue();
    report.external.push(url);
    return route.abort();
  });
  await page.goto(origin);
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.waitFor({ state: "visible" });
  assert(await page.locator(".plat-ios").count() > 0, "The real App must select its iOS mobile shell");
  assert.equal(await page.locator(".win-titlebar").count(), 0, "Mobile navigation must not be rendered inside a desktop shell");

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const result = { viewport, tabs: [] };
    report.cases.push(result);
    for (const [index, name] of tabs.entries()) {
      await nav.getByRole("button", { name, exact: true }).click();
      await page.waitForFunction(label => document.querySelector('.hg-tabbar button[aria-current="page"]')?.textContent === label, name);
      // Keep the production transition enabled and measure its final position.
      await page.locator(".hg-drop").evaluate(async el => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(el.getAnimations().map(animation => animation.finished));
      });
      const geometry = await nav.evaluate(el => {
        const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, center: r.left + r.width / 2 }; };
        return { drop: rect(el.querySelector(".hg-drop")), button: rect(el.querySelector('button[aria-current="page"]')), bar: rect(el.querySelector(".hg-glass")) };
      });
      const centerDelta = Math.abs(geometry.drop.center - geometry.button.center);
      const screenshot = `${viewport.width}x${viewport.height}-tab-${index}.png`;
      await nav.screenshot({ path: join(output, screenshot) });
      result.tabs.push({ name, centerDelta, geometry, screenshot });
      assert(centerDelta < 1, `${viewport.width}px ${name}: highlight is ${centerDelta.toFixed(2)}px off center`);
      assert(geometry.drop.left >= geometry.bar.left && geometry.drop.right <= geometry.bar.right, "Highlight must remain inside the glass bar");
    }
    result.screenshot = `${viewport.width}x${viewport.height}-full.png`;
    await page.screenshot({ path: join(output, result.screenshot), fullPage: true });
  }
  report.ipc = await page.evaluate(() => ({ calls: window.mobileLayoutFixture.calls.map(call => call.cmd), unexpected: window.mobileLayoutFixture.unexpected }));
  assert.deepEqual(report.ipc.unexpected, [], "No unexpected Tauri calls");
  assert.deepEqual(report.pageErrors, [], "No page errors");
  assert.deepEqual(report.external, [], "No upstream traffic");
  report.passed = true;
  console.log(`Passed: ${report.cases.length * tabs.length} mobile navigation alignment checks`);
} catch (error) {
  report.error = String(error.stack || error);
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  const escape = text => String(text).replace(/[&<>\"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  await writeFile(join(output, "report.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>HGhub mobile navigation layout</title><style>body{margin:24px;font:16px system-ui;background:#151515;color:#eee}h2{margin-top:32px}.tabs{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(250px,1fr));max-width:1050px}figure{margin:0;padding:12px;background:#252525;border-radius:12px}img{display:block;max-width:100%;height:auto;margin-top:8px}a{color:#79cfff}pre{white-space:pre-wrap}</style><h1>HGhub mobile navigation layout: ${report.passed ? "PASS" : "FAIL"}</h1><p>${escape(report.environment.transport)}. ${escape(report.environment.limitation)}.</p>${report.error ? `<pre>${escape(report.error)}</pre>` : ""}${report.cases.map(result => `<h2>${result.viewport.width} × ${result.viewport.height}</h2><a href="${result.screenshot || "failure.png"}">Full viewport screenshot</a><div class="tabs">${result.tabs.map(tab => `<figure><figcaption>${escape(tab.name)} — center error ${tab.centerDelta.toFixed(3)} px</figcaption><img src="${tab.screenshot}" alt="${escape(tab.name)} navigation highlight"></figure>`).join("")}</div>`).join("")}<p><a href="report.json">JSON measurements</a></p></html>`);
  await browser?.close();
  await vite?.close();
  console.log(`Artifacts: ${output}`);
}
