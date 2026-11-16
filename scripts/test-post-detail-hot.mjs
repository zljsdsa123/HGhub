// Post detail hot-count regression: a null detail.hot must use counts.hot, while
// the detail page must render the normalized value instead of calling fmt(null).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let vite;
let browser;
try {
  const postsSource = await readFile(join(root, "src", "pages", "Posts.tsx"), "utf8");
  assert.match(postsSource, /fmt\(postHot\(currentPost\)\)/, "PostDetail must render the normalized hot count");
  assert.doesNotMatch(postsSource, /fmt\(currentPost\.hot\)/, "PostDetail must not format a nullable hot value directly");

  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage();
  const external = [];
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (new URL(url).origin === new URL(origin).origin) return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.goto(`${origin}tests/post-detail-hot.html`);
  await page.waitForFunction(() => window.postDetailHotFixture);
  const result = await page.evaluate(() => window.postDetailHotFixture.results);
  assert.deepEqual(result, {
    detailNullUsesCount: 4321,
    detailPresentWins: 21,
    missingCountsFallsBackToZero: 0,
    absentPostFallsBackToZero: 0,
  });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(external, []);
  console.log("PASS: PostDetail hot uses hot ?? counts.hot ?? 0");
} finally {
  await browser?.close();
  await vite?.close();
}
