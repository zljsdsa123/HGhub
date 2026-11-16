import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/clear-history-confirm/", import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: "Real App in Chromium with mocked Tauri IPC", checks: [], errors: [] };
let vite, browser;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 14282, strictPort: true } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || "/usr/bin/google-chrome" });

  const openProfile = async (loggedIn) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(installFixture, { theme: "light", titles: ["城市与晚风", "重逢在夏日以后", "星河旅人"] });
    await context.addInitScript(loggedIn => {
      localStorage.setItem("hghubx_usage_agreement", JSON.stringify({
        version: "2026-11-15-v1", accepted: true, acceptedAt: "2026-11-15T00:00:00.000Z",
      }));
      if (!loggedIn) return;
      const original = window.__TAURI_INTERNALS__.invoke;
      const user = {
        id: 9, username: "fixture", nickname: "示例用户", avatar: "", avatar_color: "#63748b",
        counts: { like: 2, collect: 3, following: 4 },
        interactions: { favorite_video_ids: [1, 2, 3], like_video_ids: [1] },
      };
      window.__CLEAR_HISTORY_DELETE_CALLS__ = [];
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (command === "app_boot") return { user, logged_in: true, base: "https://fixture.invalid", strict_security: true };
        if (command === "api_me") return { user, interactions: user.interactions, origin: "https://fixture.invalid" };
        if (command === "api_account_history") return {
          items: [{ id: 1, video_id: 1, target_type: "video", last_ep: 3, updated_at: "2026-11-15 00:00:00" }],
          pagination: { page: 1, pages: 1, size: 100, total: 1 },
        };
        if (command === "api_account_history_delete") {
          window.__CLEAR_HISTORY_DELETE_CALLS__.push(args.ids);
          return null;
        }
        return original(command, args);
      };
    }, loggedIn);
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
    const { context, page } = await openProfile(false);
    await page.getByRole("button", { name: "观看历史", exact: true }).click();
    const clear = page.getByRole("button", { name: "清空观看历史", exact: true });
    await clear.waitFor();
    const before = await page.evaluate(() => localStorage.getItem("hghubx_app_v1"));
    await clear.click();
    const dialog = page.getByRole("dialog", { name: "清空观看历史", exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole("heading", { name: "清空观看历史" }).isVisible(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem("hghubx_app_v1")), before, "Opening confirmation must not delete guest history");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => localStorage.getItem("hghubx_app_v1")), before, "Cancel must preserve guest history");
    assert.equal(await clear.isVisible(), true, "Guest history remains after cancel");
    report.checks.push("guest clear action opens confirmation and cancel preserves history");
    await context.close();
  }

  {
    const { context, page } = await openProfile(true);
    await page.getByRole("button", { name: "观看历史", exact: true }).click();
    const clear = page.getByRole("button", { name: "清空观看历史", exact: true });
    await clear.waitFor({ timeout: 10000 });
    await clear.click();
    const dialog = page.getByRole("dialog", { name: "清空观看历史", exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getByText(/当前账号的云端观看历史与本机缓存都会被清除/).isVisible(), true);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => window.__CLEAR_HISTORY_DELETE_CALLS__), [], "Cancel must not call account history deletion");
    assert.equal(await clear.isVisible(), true, "Account history remains after cancel");
    report.checks.push("logged-in clear action requires confirmation and cancel makes no account deletion request");
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
