// Focused layout regression: real Category + shared shortcut cards, mocked IPC.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = resolve(process.env.CATEGORY_LINKS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const expectWrapped = process.argv.includes("--expect-wrapped");
const output = join(root, "test-results", "category-links", new Date().toISOString().replace(/[:.]/g, "-"));
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1";
const android = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const cases = expectWrapped ? [{ width: 375, height: 812, theme: "light", platform: "ios" }] : [
  { width: 320, height: 694, theme: "light", platform: "ios" },
  { width: 375, height: 812, theme: "dark", platform: "android" },
  { width: 390, height: 844, theme: "dark", platform: "ios" },
  { width: 430, height: 932, theme: "light", platform: "android" },
  { width: 844, height: 390, theme: "dark", platform: "ios" },
  { width: 375, height: 812, theme: "light", platform: "ios", minimumFontSize: 24 },
];
const report = { environment: "Actual App/Category/CollectionLink in Chromium; mobile UA; mocked Tauri IPC/posters; no native WebView claim", mode: expectWrapped ? "baseline" : "modified", cases: [], errors: [], external: [] };
let vite, browser;
await mkdir(output, { recursive: true });
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0 } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  for (const scenario of cases) {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || "/usr/bin/google-chrome",
      ...(scenario.minimumFontSize ? { args: [`--blink-settings=minimumFontSize=${scenario.minimumFontSize},minimumLogicalFontSize=${scenario.minimumFontSize}`] } : {}) });
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
      userAgent: scenario.platform === "android" ? android : iphone, isMobile: true, hasTouch: true,
      colorScheme: scenario.theme, reducedMotion: "reduce" });
    await context.addInitScript(installFixture, { theme: scenario.theme, titles: ["城市与晚风", "星河旅人"] });
    const page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(origin).origin) return route.continue();
      if (url.pathname === "/img") return route.fulfill({ contentType: "image/svg+xml", headers: { "Access-Control-Allow-Origin": "*" },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="210"><rect width="160" height="210" fill="#637c91"/></svg>' });
      report.external.push(url.href); return route.abort();
    });
    await page.goto(origin);
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "分类", exact: true }).click();
    const links = page.locator(".ios-collection-links").filter({ has: page.getByRole("button", { name: "专题", exact: true }) });
    await links.waitFor();
    await links.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const geometry = await links.evaluate(group => {
      const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, group: box(group), cards: [...group.querySelectorAll(":scope > button")].map(card => {
        const copy = card.querySelector(".ios-collection-copy");
        const title = card.querySelector(".ios-collection-title") || copy.children[0];
        const subtitle = card.querySelector(".ios-collection-subtitle") || copy.children[1];
        const icon = card.querySelector(".ios-collection-icon") || card.children[0];
        const arrow = card.querySelector(".ios-collection-chevron") || card.lastElementChild;
        const range = document.createRange(); range.selectNodeContents(subtitle);
        const lineTops = [...new Set([...range.getClientRects()].map(rect => Math.round(rect.top)))];
        return { title: title.textContent, subtitle: subtitle.textContent, card: box(card), icon: box(icon), titleBox: box(title), subtitleBox: box(subtitle), arrow: box(arrow),
          subtitleLines: lineTops.length, cardScrollWidth: card.scrollWidth, cardClientWidth: card.clientWidth };
      }) };
    });
    const result = { ...scenario, geometry }; report.cases.push(result);
    assert.equal(geometry.cards.length, 2);
    assert.deepEqual(geometry.cards.map(card => card.subtitle), ["精选专辑合集", "按题材找片"]);
    if (expectWrapped) {
      assert(geometry.cards.some(card => card.subtitleLines > 1), "Baseline must reproduce narrow-column subtitle wrapping");
    } else {
      assert(geometry.pageWidth <= geometry.viewport + 1, "Category must not overflow the viewport");
      for (const entry of geometry.cards) {
        assert(entry.cardScrollWidth <= entry.cardClientWidth + 1, `${entry.title}: card must not overflow`);
        assert(entry.subtitleBox.x >= entry.card.x && entry.subtitleBox.right <= entry.card.right + 1, `${entry.title}: full subtitle stays inside card`);
        assert(entry.subtitleBox.bottom <= entry.card.bottom + 1, `${entry.title}: expanded text stays inside card`);
        if (!scenario.minimumFontSize) assert.equal(entry.subtitleLines, 1, `${entry.title}: normal-size subtitle stays on one line`);
        if (scenario.width < 560) {
          assert(entry.subtitleBox.y >= Math.max(entry.icon.bottom, entry.titleBox.bottom, entry.arrow.bottom) - 1, `${entry.title}: subtitle occupies a separate row`);
        }
      }
      if (scenario.width < 560) assert(Math.abs(geometry.cards[0].subtitleBox.y - geometry.cards[1].subtitleBox.y) < 1, "Both subtitle rows align");
      assert(Math.abs(geometry.cards[0].card.height - geometry.cards[1].card.height) < 1, "Paired shortcut cards keep equal height");
    }
    result.screenshot = `${scenario.width}x${scenario.height}-${scenario.platform}-${scenario.theme}${scenario.minimumFontSize ? `-font${scenario.minimumFontSize}` : ""}.png`;
    await page.screenshot({ path: join(output, result.screenshot), animations: "disabled" });
    await browser.close(); browser = undefined;
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.external, []);
  console.log(expectWrapped ? "BASELINE: mobile category subtitles wrap in narrow columns; reproduced at 375px" : `PASS: ${report.cases.length} category shortcut layouts; aligned subtitles, no overflow, large text reflows`);
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close(); await vite?.close();
  console.log(`Artifacts: ${output}`);
}
