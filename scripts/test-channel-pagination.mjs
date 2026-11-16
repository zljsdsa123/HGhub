// ChannelPage pagination regression: page 2 must stay after page 1, and sort must be page-local.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "channel-pagination", new Date().toISOString().replace(/[:.]/g, "-"));
const report = {
  transport: "local browser fixture; Tauri IPC mocked",
  passed: [],
  external: [],
  pageErrors: [],
};
await mkdir(output, { recursive: true });
let vite, browser, page;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", error => report.pageErrors.push(error.message));
  await page.route("**/*", route => {
    const url = route.request().url();
    if (new URL(url).origin === new URL(origin).origin) return route.continue();
    report.external.push(url);
    return route.abort();
  });

  await page.goto(`${origin}tests/channel-pagination.html`);
  await page.waitForFunction(() => window.channelPaginationFixture.history.length === 1);
  await page.evaluate(() => window.channelPaginationFixture.resolveNext("latest", 1));
  await page.waitForFunction(() => document.querySelectorAll(".ios-media-grid .ios-poster-title").length === 20);

  const fixture = await page.evaluate(() => ({
    page1: window.channelPaginationFixture.page1,
    page2: window.channelPaginationFixture.page2,
  }));
  const titles = async () => page.locator(".ios-media-grid .ios-poster-title").allInnerTexts();
  const expectedPage = (list, sort) => {
    const arr = [...list];
    if (sort === "hot_window") arr.sort((a, b) => b.hot - a.hot);
    else if (sort === "random") arr.sort((a, b) => (a.id % 13) - (b.id % 13));
    else arr.sort((a, b) => b.id - a.id);
    return arr.map(v => v.title);
  };
  const scroller = page.locator(".scroll-y").last();
  const before = await titles();
  assert.equal(before.length, 20, "First page must show 20 cards");
  assert.deepEqual(before, expectedPage(fixture.page1, "latest"), "First page must follow server latest order");

  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => window.channelPaginationFixture.history.length === 2);
  const scrollBefore = await scroller.evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, scrollHeight: el.scrollHeight }));
  await page.evaluate(() => window.channelPaginationFixture.resolveNext("latest", 2));
  await page.waitForFunction(() => document.querySelectorAll(".ios-media-grid .ios-poster-title").length === 40);
  await page.waitForTimeout(250);

  const after = await titles();
  const scrollAfter = await scroller.evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, scrollHeight: el.scrollHeight }));
  assert.equal(after.length, 40, "Second page must append all cards");
  assert.deepEqual(after.slice(0, 20), before, "All page 1 cards must remain above page 2 cards");
  assert.deepEqual(after.slice(20), expectedPage(fixture.page2, "latest"), "Page 2 cards must stay in page-local latest order");
  assert(scrollAfter.top > 0 && scrollAfter.top >= scrollBefore.top - 1, "Loading page 2 must not reset scrollTop");
  report.passed.push("ChannelPage: page 2 appended after page 1 and scrollTop preserved");

  await page.getByRole("button", { name: "当前热播", exact: true }).click();
  await page.waitForFunction(() => {
    const h = window.channelPaginationFixture.history;
    return h.length > 0 && h[h.length - 1].args.sort === "hot_window";
  });
  await page.evaluate(() => window.channelPaginationFixture.resolveNext("hot_window", 1));
  await page.waitForFunction(() => document.querySelectorAll(".ios-media-grid .ios-poster-title").length === 20);
  assert.deepEqual(await titles(), expectedPage(fixture.page1, "hot_window"), "当前热播 must follow server hot_window order");
  report.passed.push("ChannelPage: 当前热播 is server-sorted");

  await page.getByRole("button", { name: "精选推荐", exact: true }).click();
  await page.waitForFunction(() => {
    const h = window.channelPaginationFixture.history;
    return h.length > 0 && h[h.length - 1].args.sort === "random";
  });
  await page.evaluate(() => window.channelPaginationFixture.resolveNext("random", 1));
  await page.waitForFunction(() => document.querySelectorAll(".ios-media-grid .ios-poster-title").length === 20);
  assert.deepEqual(await titles(), expectedPage(fixture.page1, "random"), "精选推荐 must follow server random order");
  report.passed.push("ChannelPage: 精选推荐 is server-sorted");

  assert.deepEqual(report.pageErrors, [], "No page errors");
  assert.deepEqual(report.external, [], "No upstream traffic");
  await page.screenshot({ path: join(output, "final.png"), fullPage: true });
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
