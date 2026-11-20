import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture, unlockCalculator } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/account-sync-empty-state/", import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: "Real App in Chromium with delayed mocked Tauri IPC", checks: [], errors: [] };
let vite, browser;

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

  const openProfile = async ({ favoriteIds = [], delaySync = false, rejectFirstSync = false, rejectHistory = false, omitFavorites = false, rejectWith401 = false, seedCredential = false, credentialPassword = "fixture-pass", firstEpisodeCount, holdFirstCollect = false } = {}) => {
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
      let activeUser = user;
      window.__ALLOW_SYNC_SUCCESS__ = !(options.rejectFirstSync || options.rejectWith401);
      window.__API_ME_CALLS__ = 0;
      window.__API_LOGIN_CALLS__ = 0;
      window.__COLLECT_CALLS__ = [];
      window.__FAVORITE_EPISODE_COUNT__ = options.firstEpisodeCount;
      if (options.seedCredential) localStorage.setItem("hghubx_credential_v1", JSON.stringify({
        username: "fixture", password: options.credentialPassword, userId: user.id, origin: "https://fixture.invalid",
      }));
      window.__ACCOUNT_SYNC_GATE__ = options.delaySync
        ? new Promise(resolve => { window.__releaseAccountSync__ = resolve; })
        : Promise.resolve();
      window.__switchAccount__ = () => {
        activeUser = {
          id: 10, username: "fixture-next", nickname: "切换后的用户", avatar: "", avatar_color: "#63748b",
          counts: { like: 0, collect: options.favoriteIds.length, following: 0 },
        };
        window.dispatchEvent(new Event("hg:line-changed"));
      };
      let firstCollectHeld = false;
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (command === "app_boot") return { user: activeUser, logged_in: true, base: "https://fixture.invalid", strict_security: true };
        if (command === "api_video" && args.id === 1 && window.__FAVORITE_EPISODE_COUNT__) {
          const count = window.__FAVORITE_EPISODE_COUNT__;
          return { ...await original(command, args), is_finished: false, episode_count: count, total_episodes: count,
            episodes: Array.from({ length: count }, (_, index) => ({ id: index + 1, ep_num: index + 1 })) };
        }
        if (command === "api_me") {
          await window.__ACCOUNT_SYNC_GATE__;
          window.__API_ME_CALLS__ += 1;
          if (!window.__ALLOW_SYNC_SUCCESS__) throw options.rejectWith401 ? "401" : new Error("模拟账号同步失败");
          return { user: activeUser, interactions: options.omitFavorites ? {} : { favorite_video_ids: options.favoriteIds }, origin: "https://fixture.invalid" };
        }
        if (command === "api_login") {
          if (args.expectedUserId !== activeUser.id || args.expectedOrigin !== "https://fixture.invalid"
            || args.credentialOrigin !== "https://fixture.invalid") throw new Error("自动登录必须绑定账号与线路");
          window.__API_LOGIN_CALLS__ += 1;
          if (args.password === "fixture-pass") {
            window.__ALLOW_SYNC_SUCCESS__ = true;
            return { user: activeUser, origin: "https://fixture.invalid" };
          }
          throw "账号或密码不正确";
        }
        if (command === "api_collect") {
          window.__COLLECT_CALLS__.push({
            id: args.id, on: args.on, expectedUserId: args.expectedUserId, expectedOrigin: args.expectedOrigin,
          });
          if (options.holdFirstCollect && !args.on && !firstCollectHeld) {
            firstCollectHeld = true;
            await new Promise(resolve => { window.__releaseFirstCollect__ = resolve; });
          }
          return { ok: true };
        }
        if (command === "api_account_history") {
          await window.__ACCOUNT_SYNC_GATE__;
          if (options.rejectHistory) throw "模拟历史读取失败";
          if (options.rejectWith401 && !window.__ALLOW_SYNC_SUCCESS__) throw "401";
          return { items: [], pagination: { page: 1, pages: 1, size: 100, total: 0 } };
        }
        return original(command, args);
      };
    }, { favoriteIds, delaySync, rejectFirstSync, rejectHistory, omitFavorites, rejectWith401, seedCredential, credentialPassword, firstEpisodeCount, holdFirstCollect });
    const page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(origin).origin) return route.continue();
      return route.abort();
    });
    await page.goto(origin);
    await unlockCalculator(page);
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

  {
    const { context, page } = await openProfile({ rejectWith401: true, seedCredential: true });
    await page.getByText("还没有收藏", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__API_LOGIN_CALLS__), 1,
      "A 401 sync must silently re-login once on the current line");
    assert.equal(await page.getByRole("alert").count(), 0,
      "A successful silent re-login must not surface a sync error");
    report.checks.push("account 401 triggers one silent re-login and the retried sync confirms favorites");
    await context.close();
  }

  {
    const { context, page } = await openProfile({ rejectWith401: true, seedCredential: true, credentialPassword: "stale-pass" });
    const alert = page.getByRole("alert");
    await alert.waitFor();
    const text = await alert.innerText();
    assert.match(text, /自动重新登录失败/, "Failed silent re-login must explain itself instead of a raw 401");
    assert.match(text, /重新登录/, "The error must tell the user to re-login on this line");
    assert.equal(await page.evaluate(() => localStorage.getItem("hghubx_credential_v1")), null,
      "A rejected credential must not be kept for further automatic logins");
    assert.equal(await page.getByRole("button", { name: "重试同步" }).count(), 1,
      "The session stays usable and manual retry remains available");
    const loginCalls = await page.evaluate(() => window.__API_LOGIN_CALLS__);
    const meBefore = await page.evaluate(() => window.__API_ME_CALLS__);
    await page.getByRole("button", { name: "重试同步" }).click();
    await page.waitForFunction(calls => window.__API_ME_CALLS__ > calls, meBefore);
    assert.equal(await page.evaluate(() => window.__API_LOGIN_CALLS__), loginCalls,
      "Manual retry must not loop silent re-login after a rejected credential");
    report.checks.push("failed silent re-login keeps the session, clears the stale credential and reports an actionable error");
    await context.close();
  }

  {
    const { context, page } = await openProfile({ favoriteIds: [1], firstEpisodeCount: 12 });
    const card = page.getByRole("button").filter({ hasText: "城市与晚风" }).first();
    await card.getByText("12 集", { exact: true }).waitFor();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("hghubx_accounts_v1") || "{}")
      .accounts?.[JSON.stringify(["https://fixture.invalid", 9])]?.favEpCounts?.[1] === 12);
    const nav = page.getByRole("navigation", { name: "主导航" });
    await nav.getByRole("button", { name: "分类", exact: true }).click();
    await page.getByRole("heading", { name: "我的", exact: true }).waitFor({ state: "hidden" });
    await page.evaluate(() => { window.__FAVORITE_EPISODE_COUNT__ = 13; });
    await nav.getByRole("button", { name: "我的", exact: true }).click();
    await card.getByText("新更 1 集", { exact: true }).waitFor();
    report.checks.push("returning to cached favorites shows a newly added episode");
    await context.close();
  }

  {
    const { context, page } = await openProfile({ favoriteIds: [1, 2], holdFirstCollect: true });
    const firstCard = page.getByRole("button", { name: "城市与晚风", exact: true });
    const secondCard = page.getByRole("button", { name: "选择重逢在夏日以后", exact: true });
    await firstCard.waitFor();
    await firstCard.click({ button: "right" });
    await secondCard.waitFor();
    await secondCard.click({ button: "right" });
    await page.getByRole("region", { name: "批量管理" }).getByText("已选 2 项", { exact: true }).waitFor();
    await page.getByRole("region", { name: "批量管理" }).getByRole("button", { name: "移除", exact: true }).click();
    await page.getByRole("dialog", { name: "批量移除" }).getByRole("button", { name: "确认移除", exact: true }).click();
    await page.waitForFunction(() => window.__COLLECT_CALLS__.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__COLLECT_CALLS__), [{
      id: 1, on: false, expectedUserId: 9, expectedOrigin: "https://fixture.invalid",
    }], "The first batch removal is pending on the initiating account");

    await page.evaluate(() => window.__switchAccount__());
    await page.locator(".ios-account-card").getByText("切换后的用户", { exact: true }).waitFor();
    await page.getByRole("button", { name: "城市与晚风", exact: true }).waitFor();
    await page.getByRole("button", { name: "重逢在夏日以后", exact: true }).waitFor();
    await page.waitForFunction(() => {
      const accounts = JSON.parse(localStorage.getItem("hghubx_accounts_v1") || "{}").accounts || {};
      return JSON.stringify(accounts[JSON.stringify(["https://fixture.invalid", 10])]?.favs || []) === "[1,2]";
    });

    await page.evaluate(() => window.__releaseFirstCollect__());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await page.evaluate(() => window.__COLLECT_CALLS__), [{
      id: 1, on: false, expectedUserId: 9, expectedOrigin: "https://fixture.invalid",
    }], "Switching accounts while the first request is pending must stop the remaining batch items");
    assert.deepEqual(await page.evaluate(() => {
      const accounts = JSON.parse(localStorage.getItem("hghubx_accounts_v1") || "{}").accounts || {};
      return accounts[JSON.stringify(["https://fixture.invalid", 10])]?.favs || [];
    }), [1, 2], "The new account keeps its server-synced favorites after the old request settles");
    assert.equal(await page.getByText("已取消收藏 2 项", { exact: true }).count(), 0,
      "The old batch must not report success after its account has changed");
    report.checks.push("batch favorite removal stops after account switch while its first request is in flight");
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
