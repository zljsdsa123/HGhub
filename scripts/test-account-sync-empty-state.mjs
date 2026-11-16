import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/account-sync-empty-state/", import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: "Real App in Chromium with delayed mocked Tauri IPC", checks: [], errors: [] };
let vite, browser;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 14283, strictPort: true } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || "/usr/bin/google-chrome" });

  const openProfile = async ({ favoriteIds = [], delaySync = false, rejectFirstSync = false, rejectHistory = false, omitFavorites = false } = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(installFixture, { theme: "light", titles: ["城市与晚风", "重逢在夏日以后", "星河旅人"] });
    await context.addInitScript(options => {
      localStorage.setItem("hghubx_usage_agreement", JSON.stringify({
        version: "2026-11-15-v1", accepted: true, acceptedAt: "2026-11-15T00:00:00.000Z",
      }));
      const original = window.__TAURI_INTERNALS__.invoke;
      const user = {
        id: 9, username: "fixture", nickname: "示例用户", avatar: "", avatar_color: "#63748b",
        counts: { like: 2, collect: options.favoriteIds.length, following: 4 },
      };
      window.__ALLOW_SYNC_SUCCESS__ = !options.rejectFirstSync;
      window.__API_ME_CALLS__ = 0;
      window.__ACCOUNT_SYNC_GATE__ = options.delaySync
        ? new Promise(resolve => { window.__releaseAccountSync__ = resolve; })
        : Promise.resolve();
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (command === "app_boot") return { user, logged_in: true, base: "https://fixture.invalid", strict_security: true };
        if (command === "api_me") {
          await window.__ACCOUNT_SYNC_GATE__;
          window.__API_ME_CALLS__ += 1;
          if (!window.__ALLOW_SYNC_SUCCESS__) throw new Error("模拟账号同步失败");
          return { user, interactions: options.omitFavorites ? {} : { favorite_video_ids: options.favoriteIds }, origin: "https://fixture.invalid" };
        }
        if (command === "api_account_history") {
          await window.__ACCOUNT_SYNC_GATE__;
          if (options.rejectHistory) throw "模拟历史读取失败";
          return { items: [], pagination: { page: 1, pages: 1, size: 100, total: 0 } };
        }
        return original(command, args);
      };
    }, { favoriteIds, delaySync, rejectFirstSync, rejectHistory, omitFavorites });
    const page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(origin).origin) return route.continue();
      return route.abort();
    });
    await page.goto(origin);
    await page.getByRole("navigation", { name: "主导航" }).waitFor();
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "我的", exact: true }).click();
    await page.getByRole("heading", { name: "我的", exact: true }).waitFor();
    return { context, page };
  };

  {
    const { context, page } = await openProfile({ favoriteIds: [1], delaySync: true });
    const syncing = page.getByRole("status", { name: "正在同步收藏", exact: true });
    await syncing.waitFor();
    assert.equal(await page.getByText("还没有收藏", { exact: true }).count(), 0,
      "A delayed first account sync must not show the confirmed-empty state");
    await page.evaluate(() => window.__releaseAccountSync__());
    await page.getByRole("button").filter({ hasText: "城市与晚风" }).first().waitFor();
    assert.equal(await syncing.count(), 0, "Sync state clears after the favorite content arrives");
    report.checks.push("delayed sync shows progress instead of an empty state, then renders the favorite card");
    await context.close();
  }

  {
    const { context, page } = await openProfile({ delaySync: true });
    const syncing = page.getByRole("status", { name: "正在同步收藏", exact: true });
    await syncing.waitFor();
    assert.equal(await page.getByText("还没有收藏", { exact: true }).count(), 0,
      "Unknown favorites are not reported as confirmed empty while syncing");
    await page.evaluate(() => window.__releaseAccountSync__());
    await page.getByText("还没有收藏", { exact: true }).waitFor();
    assert.equal(await syncing.count(), 0);
    report.checks.push("after a successful empty sync, the confirmed empty state is shown");
    await context.close();
  }

  {
    const { context, page } = await openProfile({ rejectFirstSync: true });
    const unknown = page.getByText("收藏状态未知", { exact: true });
    await unknown.waitFor();
    assert.equal(await page.getByText("还没有收藏", { exact: true }).count(), 0,
      "A failed first sync must not present favorites as confirmed empty");
    const callsBeforeRetry = await page.evaluate(() => window.__API_ME_CALLS__);
    await page.evaluate(() => { window.__ALLOW_SYNC_SUCCESS__ = true; });
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.getByText("还没有收藏", { exact: true }).waitFor();
    assert.equal(await unknown.count(), 0, "Successful retry replaces the unknown state");
    assert.equal(await page.evaluate(calls => window.__API_ME_CALLS__ > calls, callsBeforeRetry), true,
      "Retry invokes account synchronization again");
    report.checks.push("failed first sync shows unknown with retry, then a successful retry confirms the empty state");
    await context.close();
  }

  {
    const { context, page } = await openProfile({ rejectHistory: true });
    await page.getByText("还没有收藏", { exact: true }).waitFor();
    assert.equal(await page.getByText("收藏状态未知", { exact: true }).count(), 0,
      "An unrelated history failure must not invalidate a successfully loaded empty favorites snapshot");
    assert.equal(await page.getByRole("status", { name: "正在同步收藏", exact: true }).count(), 0);
    report.checks.push("successful favorites remain known even when history synchronization fails");
    await context.close();
  }

  {
    const { context, page } = await openProfile({ omitFavorites: true });
    await page.getByText("收藏状态未知", { exact: true }).waitFor();
    assert.equal(await page.getByText("还没有收藏", { exact: true }).count(), 0,
      "A successful profile without favorite ids must not confirm that favorites are empty");
    report.checks.push("missing favorites data stays unknown instead of becoming a confirmed empty collection");
    await context.close();
  }

  report.passed = true;
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await vite?.close();
  await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(fileURLToPath(output));
}
