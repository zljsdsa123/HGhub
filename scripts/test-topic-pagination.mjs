// Topic detail pagination regression: all pages load, duplicates collapse, errors retry,
// and a stale topic response cannot overwrite the selected topic.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "topic-pagination", new Date().toISOString().replace(/[:.]/g, "-"));
const report = {
  transport: "local browser fixture; Tauri IPC mocked",
  passed: [],
  external: [],
  pageErrors: [],
};

await mkdir(output, { recursive: true });
let vite;
let browser;
let page;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (new URL(url).origin === new URL(origin).origin) return route.continue();
    report.external.push(url);
    return route.abort();
  });

  await page.goto(`${origin}tests/topic-pagination.html`);
  await page.waitForFunction(() => window.topicPaginationFixture.history.length === 1);
  const request = (slug, pageNumber, action = "resolve") =>
    page.evaluate(({ slug: value, pageNumber: number, action: operation }) => {
      window.topicPaginationFixture[operation](value, number);
    }, { slug, pageNumber, action });
  const requestCount = (slug, pageNumber) => page.evaluate(({ slug: value, pageNumber: number }) =>
    window.topicPaginationFixture.history.filter((entry) => entry.slug === value && entry.page === number).length,
  { slug, pageNumber });
  const titles = () => page.locator("[data-ui='media-grid'] .ios-poster-title").allInnerTexts();
  const loadMore = page.getByRole("button", { name: /加载更多/ });

  // Start a request for A, then select B before A resolves. A's late response must be ignored.
  await page.locator("#topic-b").click();
  await page.waitForFunction(() => window.topicPaginationFixture.history.length === 2);
  assert.deepEqual(await page.evaluate(() => window.topicPaginationFixture.history.slice(0, 2)), [
    { slug: "hot-aiduanju", page: 1, size: 20 },
    { slug: "luanlun-aiduanju", page: 1, size: 20 },
  ]);
  await request("hot-aiduanju", 1);
  await page.waitForTimeout(100);
  assert.equal(await page.locator("[data-ui='media-grid']").count(), 0, "Stale topic A data must not render after selecting B");
  await request("luanlun-aiduanju", 1);
  await page.waitForFunction(() => document.querySelectorAll("[data-ui='media-grid'] .ios-poster-title").length === 20);
  assert.equal(await page.getByRole("heading", { name: "第二专题", exact: true }).count(), 1);
  assert.equal((await titles())[0], "专题影片 1");
  report.passed.push("TopicPage: a stale response from the previous topic cannot replace the selected topic");

  await page.getByText(/已加载 20 \/ 81 部/).waitFor();
  await loadMore.click();
  await page.waitForFunction(() => window.topicPaginationFixture.history.length === 3);
  await request("luanlun-aiduanju", 2);
  await page.waitForFunction(() => document.querySelectorAll("[data-ui='media-grid'] .ios-poster-title").length === 39);
  assert.equal((await titles()).filter((title) => title === "专题影片 20").length, 1, "A page-boundary duplicate must render once");
  await page.getByText(/已加载 39 \/ 81 部/).waitFor();
  report.passed.push("TopicPage: page 2 appends and a repeated card id is de-duplicated");

  await loadMore.click();
  await page.waitForFunction(() => window.topicPaginationFixture.history.length === 4);
  await request("luanlun-aiduanju", 3, "reject");
  await page.getByText("加载更多失败：第 3 页暂时不可用", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-ui='media-grid'] .ios-poster-title").count(), 39, "A failed page must preserve loaded cards");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.waitForFunction(() => window.topicPaginationFixture.history.length === 5);
  assert.equal(await requestCount("luanlun-aiduanju", 3), 2, "Retry must request the same failed page");
  await request("luanlun-aiduanju", 3);
  await page.waitForFunction(() => document.querySelectorAll("[data-ui='media-grid'] .ios-poster-title").length === 59);
  report.passed.push("TopicPage: failed page keeps existing cards and retries the same page");

  await loadMore.click();
  await page.waitForFunction(() => window.topicPaginationFixture.history.length === 6);
  await request("luanlun-aiduanju", 4);
  await page.waitForFunction(() => document.querySelectorAll("[data-ui='media-grid'] .ios-poster-title").length === 79);
  await loadMore.click();
  await page.waitForFunction(() => window.topicPaginationFixture.history.length === 7);
  await request("luanlun-aiduanju", 5);
  await page.waitForFunction(() => document.querySelectorAll("[data-ui='media-grid'] .ios-poster-title").length === 81);
  await page.getByText(/已加载 81 \/ 81 部/).waitFor();
  await page.getByText("已加载全部 81 部", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /加载更多/ }).count(), 0, "All five pages must terminate pagination");
  assert.deepEqual(
    await page.evaluate(() => window.topicPaginationFixture.history.slice(1).map(({ page: pageNumber, size }) => ({ page: pageNumber, size }))),
    [{ page: 1, size: 20 }, { page: 2, size: 20 }, { page: 3, size: 20 }, { page: 3, size: 20 }, { page: 4, size: 20 }, { page: 5, size: 20 }],
  );
  report.passed.push("TopicPage: 81 cards across five pages load through an explicit, terminating load-more path");

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
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await vite?.close();
  console.log(`Artifacts: ${output}`);
}
