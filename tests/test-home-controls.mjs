import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "test-results");
const vite = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await mkdir(output, { recursive: true });
  const origin = vite.resolvedUrls.local[0];
  await page.goto(new URL("/tests/home-controls.html", origin).href, { waitUntil: "networkidle" });
  await page.locator(".mobile-playback-dock").waitFor();
  const probe = name => page.evaluate(key => window.homeControlsProbe[key](), name);
  const cdp = await context.newCDPSession(page);

  const swipe = async (locator, startX, dx, dy = 0) => {
    const box = await locator.boundingBox();
    assert.ok(box);
    const y = box.y + Math.min(40, box.height / 3);
    await page.mouse.move(box.x + startX, y);
    await page.mouse.down();
    await page.mouse.move(box.x + startX + dx, y + dy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  };

  const touchSwipe = async (locator, startX, dx, dy = 0) => {
    const box = await locator.boundingBox();
    assert.ok(box);
    const x = box.x + startX;
    const y = box.y + Math.min(40, box.height / 3);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    for (let step = 1; step <= 6; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + dx * step / 6, y: y + dy * step / 6, id: 1 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(200);
  };

  const railOrder = await page.locator(".mobile-video-action-rail>button").evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label")));
  assert.deepEqual(railOrder, ["点赞", "收藏", "评论 89 条", "更多播放设置"]);
  assert.equal(await page.locator(".mobile-playback-episodes").innerText(), "选集 · 全109集");
  assert.equal(await page.locator(".feed-current-quality").innerText(), "HD");
  assert.equal(await page.locator(".mobile-episode-indicator").count(), 0);
  assert.equal(await page.locator(".mobile-video-episode").innerText(), "第1集");
  assert.equal(await page.locator(".feed-mobile-top-tools button").count(), 0);
  assert.deepEqual(await page.locator(".mobile-playback-quick").evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label"))), ["取消静音", "关闭上下划切集"]);
  assert.equal(await page.getByRole("button", { name: "搜索", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "视频详情", exact: true }).count(), 0);
  await page.evaluate(() => window.homeControlsProbe.setContextSearch(true));
  assert.equal(await page.locator(".feed-context-search").innerText(), "搜短剧");
  await page.getByRole("button", { name: "搜短剧" }).click();
  assert.equal(await probe("openedTag"), "search");
  await page.evaluate(() => window.homeControlsProbe.setContextSearch(false));
  const portraitMore = await page.getByRole("button", { name: "更多播放设置" }).boundingBox();
  const portraitDock = await page.locator(".mobile-playback-dock").boundingBox();
  assert.ok(portraitMore && portraitDock && portraitMore.y + portraitMore.height < portraitDock.y);
  await page.screenshot({ path: path.join(output, "home-portrait.png") });
  console.log("✓ portrait rail, real episode total, HD badge, bottom quick controls, and one panel entry");

  await page.evaluate(() => window.homeControlsProbe.setClean(true));
  const cleanLock = page.locator(".mobile-clean-lock");
  await cleanLock.waitFor();
  const cleanLockBox = await cleanLock.boundingBox();
  assert.ok(cleanLockBox && cleanLockBox.x > 390 / 2);
  assert.equal(await page.locator(".feed-current-quality").count(), 0);
  await page.screenshot({ path: path.join(output, "home-clean.png") });
  await page.getByRole("button", { name: "屏幕锁定", exact: true }).click();
  assert.equal(await probe("locked"), true);
  await page.evaluate(() => { window.homeControlsProbe.setLocked(false); window.homeControlsProbe.setClean(false); });
  console.log("✓ clean-screen playback shows a right-center screen-lock control");

  await page.getByRole("button", { name: "取消静音" }).click();
  assert.equal(await probe("muted"), false);
  await page.getByRole("button", { name: "关闭上下划切集" }).click();
  assert.equal(await probe("swipeEp"), false);
  console.log("✓ mute and episode-swipe are one-tap controls in the bottom thumb zone");

  await page.locator(".mobile-playback-episodes").click();
  assert.equal(await probe("panel"), "episodes");
  const panelBody = page.locator(".video-details-sheet-body");
  await panelBody.waitFor();
  await touchSwipe(panelBody, 24, 110);
  assert.equal(await probe("panel"), "detail");
  assert.equal(await page.getByTestId("detail-content").count(), 1);
  await touchSwipe(panelBody, 130, -110);
  assert.equal(await probe("panel"), "episodes");
  await swipe(panelBody, 24, 110);
  assert.equal(await probe("panel"), "detail");

  const related = page.getByTestId("related-scroll");
  await related.scrollIntoViewIfNeeded();
  const relatedBox = await related.boundingBox();
  assert.ok(relatedBox);
  await page.mouse.move(relatedBox.x + 20, relatedBox.y + relatedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(relatedBox.x + 160, relatedBox.y + relatedBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  assert.equal(await probe("panel"), "detail");
  await touchSwipe(related, 20, 140);
  assert.equal(await probe("panel"), "detail");
  console.log("✓ related-content carousel keeps its horizontal swipe without changing tabs");

  await page.getByRole("button", { name: "选集", exact: true }).click();
  assert.equal(await probe("panel"), "episodes");
  await touchSwipe(panelBody, 24, 0, 160);
  assert.equal(await probe("panel"), null);
  console.log("✓ panel tabs switch with touch and mouse swipes, and a touch pull-down closes the sheet");

  await page.getByRole("button", { name: "全屏", exact: true }).click();
  assert.equal(await probe("fullscreen"), false);
  const exitFullscreen = page.locator(".mobile-fs-controls .mobile-fs-exit");
  await exitFullscreen.waitFor();
  const exitBox = await exitFullscreen.boundingBox();
  assert.ok(exitBox && exitBox.x >= 329 && exitBox.x + exitBox.width <= 390 - 10);
  assert.ok(exitBox.y > 844 - 60);
  assert.equal(await page.getByRole("button", { name: "退出全屏" }).count(), 1);
  const fullscreenQuality = await page.locator(".feed-current-quality").boundingBox();
  assert.ok(fullscreenQuality && fullscreenQuality.x + fullscreenQuality.width >= 370);
  assert.equal(await page.locator(".mobile-fs-controls [aria-label*='静音']").count(), 0);
  assert.equal(await page.locator(".mobile-fs-controls [aria-label*='切集']").count(), 0);
  assert.equal(await page.locator(".mobile-fs-controls [aria-label*='下集']").count(), 0);
  const fullscreenTime = page.locator(".mobile-fs-time");
  await fullscreenTime.waitFor();
  assert.match(await fullscreenTime.innerText(), /^00:00 \/ 02:00$/);
  assert.equal(await page.locator(".mobile-fs-duration").count(), 0);
  await page.evaluate(() => {
    window.homeControlsProbe.setClean(true);
    window.homeControlsProbe.setFsIdle(true);
  });
  await page.waitForTimeout(150);
  assert.equal(await page.locator(".feed-current-quality").count(), 0);
  assert.equal(await page.locator(".mobile-fs-controls").count(), 0);
  const fullscreenCleanLock = await page.locator(".mobile-clean-lock").boundingBox();
  assert.ok(fullscreenCleanLock && fullscreenCleanLock.x + fullscreenCleanLock.width >= 370 && Math.abs(fullscreenCleanLock.y + fullscreenCleanLock.height / 2 - 422) < 4);
  await page.evaluate(() => {
    window.homeControlsProbe.setClean(false);
    window.homeControlsProbe.setFsIdle(false);
  });
  await page.waitForTimeout(150);
  const fullscreenSwipes = await page.evaluate(() => {
    const fn = window.homeControlsProbe.fullscreenEpisodeSwipe;
    return { up: fn(50, 109, -90), down: fn(50, 109, 90), first: fn(1, 109, -90), last: fn(109, 109, 90) };
  });
  assert.deepEqual(fullscreenSwipes, {
    up: { target: 49 },
    down: { target: 51 },
    first: { message: "当前已是第一集" },
    last: { message: "当前已是最后一集" },
  });
  await page.screenshot({ path: path.join(output, "home-fullscreen.png") });
  await exitFullscreen.click();
  await page.locator(".mobile-fs-controls").waitFor({ state: "detached" });
  console.log("✓ fullscreen uses a bottom-right exit, combined time, bounded episode swipes, and a clean-state right-center lock");

  await page.getByRole("button", { name: "查看标签 都市，长按可屏蔽" }).click();
  assert.equal(await probe("openedTag"), "都市");
  const sweetTag = page.getByRole("button", { name: "查看标签 甜宠，长按可屏蔽" });
  await sweetTag.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, buttons: 1 });
  await page.waitForTimeout(600);
  await sweetTag.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, buttons: 0 });
  await page.locator(".content-tag-menu").waitFor();
  assert.equal(await page.getByRole("button", { name: "甜宠", exact: true }).getAttribute("data-selected"), "true");
  assert.deepEqual(await probe("tagSelection"), ["甜宠"]);
  await page.locator(".content-tag-menu-header button").click();
  console.log("✓ tap opens the tag page and long press preselects the held tag");

  await page.getByRole("button", { name: "更多播放设置" }).click();
  await page.locator(".playback-settings-sheet").waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(output, "home-settings-portrait.png") });
  const hdToggle = page.locator(".playback-setting-row").filter({ hasText: "优先高清" }).getByRole("switch");
  assert.equal(await hdToggle.getAttribute("aria-checked"), "true");
  await hdToggle.click();
  assert.equal(await probe("preferHevc"), false);
  assert.equal(await page.locator(".feed-current-quality").innerText(), "SD");
  await page.getByRole("button", { name: "倍速 1.5 倍", exact: true }).click();
  assert.equal(await probe("rate"), 1.5);
  await page.getByRole("button", { name: "铺满", exact: true }).click();
  assert.equal(await probe("portraitFit"), "cover");
  assert.equal(await page.locator(".playback-settings-row").filter({ hasText: "上下划切集" }).count(), 0);
  assert.equal(await page.locator(".playback-settings-row").filter({ hasText: "静音" }).count(), 0);
  assert.equal(await page.locator(".playback-setting-action").count(), 0);
  await page.getByRole("button", { name: "关闭播放设置" }).click();
  console.log("✓ quality, rate, and fit remain in settings; primary playback actions stay in the dock");

  await page.locator(".mobile-playback-episodes").click();
  await page.getByRole("button", { name: "详情", exact: true }).click();
  const detailTag = page.getByRole("button", { name: "查看标签 都市", exact: true });
  await detailTag.scrollIntoViewIfNeeded();
  await detailTag.dispatchEvent("contextmenu", { button: 2 });
  await page.locator(".content-tag-menu").waitFor();
  assert.deepEqual(await probe("tagSelection"), ["都市"]);
  await page.locator(".content-tag-menu-header button").click();
  console.log("✓ detail-panel tags block the right-clicked tag and close the sheet");

  await page.evaluate(() => {
    window.homeControlsProbe.setRate(1);
    window.homeControlsProbe.setPreferHevc(true);
    window.homeControlsProbe.setPortraitFit("contain");
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(150);
  const positions = await page.locator(".mobile-video-action-rail>button").evaluateAll(buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect();
    return { label: button.getAttribute("aria-label"), x: rect.x, y: rect.y };
  }));
  assert.ok(positions.every(position => Math.abs(position.x - positions[0].x) < 1));
  assert.ok(positions[0].y < positions[1].y && positions[1].y < positions[2].y && positions[2].y < positions[3].y);
  assert.ok(Math.abs(positions[3].y - positions[2].y) > 30);
  const landscapeMore = await page.getByRole("button", { name: "更多播放设置" }).boundingBox();
  const landscapeDock = await page.locator(".mobile-playback-dock").boundingBox();
  assert.ok(landscapeMore && landscapeDock && landscapeMore.y + landscapeMore.height < landscapeDock.y);
  await page.screenshot({ path: path.join(output, "home-landscape.png") });
  await page.getByRole("button", { name: "更多播放设置" }).click();
  const drawer = await page.locator(".playback-settings-overlay .ios-dialog").boundingBox();
  assert.ok(drawer && drawer.x > 400 && drawer.width <= 381 && Math.abs(drawer.height - 390) < 2);
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(output, "home-settings-landscape.png") });
  const landscapeRates = await page.locator(".playback-setting-rates .ios-segmented-items>.ios-button").evaluateAll(buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect();
    return { label: button.getAttribute("aria-label"), bottom: rect.bottom };
  }));
  assert.equal(landscapeRates.length, 6);
  assert.ok(landscapeRates.every(rate => rate.bottom <= 390));
  await page.getByRole("button", { name: "关闭播放设置" }).click();
  console.log("✓ landscape keeps social actions in one column and opens playback settings as a right drawer");

  await page.locator(".mobile-playback-fullscreen").click();
  await page.locator(".mobile-fs-controls").waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(output, "home-fullscreen-landscape.png") });
  await page.locator(".mobile-fs-controls .mobile-fs-exit").click();
  await page.locator(".mobile-fs-controls").waitFor({ state: "detached" });
  await page.evaluate(() => window.homeControlsProbe.setClean(true));
  await page.locator(".mobile-clean-lock").waitFor();
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(output, "home-clean-landscape.png") });
  await page.evaluate(() => window.homeControlsProbe.setClean(false));
  await page.locator(".mobile-video-action-rail").waitFor();
  await page.waitForTimeout(150);

  await page.getByRole("button", { name: "查看标签 都市，长按可屏蔽" }).dispatchEvent("contextmenu", { button: 2 });
  await page.locator(".content-preference-overlay .ios-dialog").waitFor();
  const tagDrawer = await page.locator(".content-preference-overlay .ios-dialog").boundingBox();
  assert.ok(tagDrawer && tagDrawer.x > 400 && tagDrawer.width <= 381 && Math.abs(tagDrawer.height - 390) < 2);
  assert.equal(await page.getByRole("button", { name: "都市", exact: true }).getAttribute("data-selected"), "true");
  console.log("✓ landscape tag blocking also uses a right drawer with the current tag selected");

  assert.deepEqual(errors, []);
  console.log("Home controls browser tests passed.");
} finally {
  if (browser) await browser.close();
  await vite.close();
}
