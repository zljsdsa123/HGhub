/** Real application smoke coverage for the iOS material UI. No live account or media is used.
 * Run: BROWSER_EXECUTABLE=/opt/google/chrome/chrome node scripts/test-ios-ui.mjs
 * Screenshots and a machine-readable report are written below test-results/ios-ui/.
 */
import assert from "node:assert/strict";
import { installFixture } from "./fixtures/app-ui.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL(`../test-results/ios-ui/${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url);
await mkdir(output, { recursive: true });
const report = {
  environment: "Real App in Chromium; mocked Tauri IPC and poster images. Android back event exercises the real App listener; native WebViews and media playback are not covered.",
  cases: [], errors: [], external: [],
};
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1";
const android = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const cases = [
  { width: 1440, height: 960, mobile: false, theme: "dark" },
  { width: 900, height: 740, mobile: false, theme: "light" },
  { width: 390, height: 844, mobile: true, theme: "dark" },
  { width: 320, height: 694, mobile: true, theme: "light", reduced: true },
  { width: 844, height: 390, mobile: true, theme: "dark", reduced: true },
  { width: 390, height: 844, mobile: true, theme: "light", android: true },
  { width: 375, height: 812, mobile: true, theme: "light" },
  { width: 375, height: 812, mobile: true, theme: "dark", minimumFontSize: 20 },
];
const caseName = test => `${test.width}x${test.height}-${test.theme}${test.android ? "-android" : ""}${test.minimumFontSize ? `-font${test.minimumFontSize}` : ""}`;
const selectedCases = process.env.IOS_UI_CASE ? cases.filter(test => caseName(test) === process.env.IOS_UI_CASE) : cases;
assert(selectedCases.length, "IOS_UI_CASE must match one of the defined scenarios");
const titles = ["城市与晚风", "重逢在夏日以后", "星河旅人", "无声的答案", "我的奇妙假期", "晴天来信"];
const titlePattern = new RegExp(`^(${titles.join("|")})$`);
let vite, browser;

// Passed directly to addInitScript so every reload starts with isolated fixture data.

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0 } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  const browserOptions = { headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined };
  browser = await chromium.launch(browserOptions);
  for (const test of selectedCases) {
    const name = caseName(test);
    const result = { ...test, name, checks: [], screenshots: [], passed: false };
    report.cases.push(result);
    const caseBrowser = test.minimumFontSize ? await chromium.launch({ ...browserOptions,
      args: [`--blink-settings=minimumFontSize=${test.minimumFontSize},minimumLogicalFontSize=${test.minimumFontSize}`],
    }) : browser;
    const context = await caseBrowser.newContext({
      viewport: { width: test.width, height: test.height }, colorScheme: test.theme,
      reducedMotion: test.reduced ? "reduce" : "no-preference",
      ...(test.mobile ? { userAgent: test.android ? android : iphone, isMobile: true, hasTouch: true } : {}),
    });
    await context.addInitScript(installFixture, { theme: test.theme, titles });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on("pageerror", error => report.errors.push({ case: name, message: error.message }));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(origin).origin) return route.continue();
      if (url.pathname === "/img") return route.fulfill({
        contentType: "image/svg+xml", headers: { "Access-Control-Allow-Origin": "*" },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#5b7e94"/><stop offset="1" stop-color="#172e42"/></linearGradient></defs><rect width="360" height="480" fill="url(#g)"/><circle cx="180" cy="150" r="60" fill="#8ca8b5"/><path d="M45 480Q180 100 315 480" fill="#263f50"/></svg>',
      });
      report.external.push({ case: name, url: url.href });
      return route.abort();
    });
    const check = label => result.checks.push(label);
    const shot = async label => {
      // Playwright finishes finite CSS transitions; infinite loaders cannot stall the run.
      const filename = `${name}-${label}.png`;
      await page.screenshot({ path: fileURLToPath(new URL(filename, output)), animations: "disabled" });
      result.screenshots.push(filename);
      const layout = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth <= innerWidth + 1,
        grids: [...document.querySelectorAll(".ios-media-grid")]
          .filter(el => !el.closest("[inert], [aria-hidden=true]") && el.getClientRects().length)
          .every(el => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= innerWidth + 1),
      }));
      assert(layout.document && layout.grids, `${label}: no horizontal page or media-grid overflow`);
    };
    const assertSlider = async (group, count, index, label) => {
      await group.waitFor();
      await group.evaluate(async el => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(el.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity)
          .map(animation => animation.finished.catch(() => undefined)));
      });
      const geometry = await group.evaluate(el => {
        const buttons = [...el.querySelectorAll(".ios-segmented-items > button")];
        const selected = buttons.findIndex(button => button.getAttribute("aria-pressed") === "true");
        const rectangle = element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
        return { count: buttons.length, selected, declaredCount: el.style.getPropertyValue("--segment-count"),
          indicator: rectangle(el.querySelector(".ios-segmented-indicator")), button: selected >= 0 ? rectangle(buttons[selected]) : null };
      });
      (result.segmented ??= []).push({ label, ...geometry });
      assert.equal(geometry.count, count, `${label}: expected option count`);
      assert.equal(geometry.declaredCount, String(count), `${label}: shared control uses the actual option count`);
      assert.equal(geometry.selected, index, `${label}: the requested option is selected`);
      for (const property of ["x", "y", "width", "height"]) assert(Math.abs(geometry.indicator[property] - geometry.button[property]) < 1.1,
        `${label}: slider and selected button align in ${property}`);
    };
    const returnFromOverlay = async () => {
      if (test.android) await page.evaluate(() => window.__IOS_UI_FIXTURE__.hardwareBack());
      else assert.equal(await page.evaluate(async () => (await import("/src/back.ts")).runBack()), true, "Overlay consumes the shared back handler");
    };
    try {
      await page.goto(origin);
      if (test.minimumFontSize) assert(await page.evaluate(minimum => {
        const probe = document.createElement("span"); probe.style.fontSize = "12px"; probe.textContent = "字号";
        document.body.append(probe); const size = parseFloat(getComputedStyle(probe).fontSize); probe.remove();
        return size >= minimum;
      }, test.minimumFontSize), "Chromium applies the enlarged minimum text size");
      const nav = page.getByRole("navigation", { name: "主导航" });
      for (const label of ["首页", "搜索", "分类", "我的"]) await nav.getByRole("button", { name: label, exact: true }).waitFor();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, test.theme);
      if (test.android) await page.waitForFunction(() => window.__IOS_UI_FIXTURE__.hasHardwareBack());
      check("original navigation and persisted appearance");
      if (test.mobile) {
        const videoNav = page.locator('nav[aria-label="主导航"]');
        await videoNav.waitFor();
        const navBackground = await videoNav.evaluate(nav => nav.getAttribute("data-over-video"));
        assert.equal(navBackground, "true", "Home navigation declares its video background");
        await nav.getByRole("button", { name: "首页", exact: true }).click();
        const homeVideoMaterial = await page.evaluate(() => {
          const nav = document.querySelector('nav[aria-label="主导航"]');
          const selected = nav?.querySelector('[aria-current="page"]');
          const unselected = nav?.querySelector('button:not([aria-current="page"])');
          const glass = nav?.querySelector(".hg-glass");
          return { video: nav?.getAttribute("data-over-video"), selected: selected && getComputedStyle(selected).color,
            unselected: unselected && getComputedStyle(unselected).color, background: glass && getComputedStyle(glass).backgroundColor };
        });
        assert.equal(homeVideoMaterial.selected, "rgb(25, 25, 25)", "Home selection uses dark ink over the selected light surface");
        assert.equal(homeVideoMaterial.unselected, "rgb(242, 240, 235)", "Home navigation labels stay bright over dark video");
        assert.equal(homeVideoMaterial.background, "rgba(28, 28, 32, 0.94)", "Home navigation keeps an opaque dark glass surface over black video");
        check("home navigation text contrast on video in both themes");
      }
      await nav.getByRole("button", { name: "搜索", exact: true }).click();

      const hotSearch = page.getByRole("region", { name: "热搜榜", exact: true });
      await hotSearch.getByRole("button", { name: "播放 城市与晚风", exact: true }).waitFor();
      assert.equal(await hotSearch.locator("ol > li").count(), titles.length, "Hot searches retain upstream rank order");
      assert.equal(await hotSearch.locator("ol > li").first().innerText(), "01\n城市与晚风\n550.1w播放量");
      await hotSearch.getByRole("button", { name: "播放 城市与晚风", exact: true }).click();
      const playbackPositionSelector = test.mobile ? ".feed-position-pill" : ".desktop-context-header small";
      await page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(el => {
        const bounds = el.getBoundingClientRect();
        return el.textContent.trim() === "1 / 6" && bounds.width > 0 && bounds.top >= 0 && bounds.bottom <= innerHeight
          && getComputedStyle(el).visibility !== "hidden" && !el.closest("[inert], [aria-hidden=true]");
      }), playbackPositionSelector);
      const activePlaybackPositions = await page.locator(playbackPositionSelector).evaluateAll(elements => elements.filter(el => {
        const bounds = el.getBoundingClientRect();
        return bounds.width > 0 && bounds.top >= 0 && bounds.bottom <= innerHeight
          && getComputedStyle(el).visibility !== "hidden" && !el.closest("[inert], [aria-hidden=true]");
      }).map(el => el.textContent.trim()));
      assert.deepEqual(activePlaybackPositions, ["1 / 6"], "Only the viewport's active playback surface shows its position counter");
      await page.keyboard.press("Escape");
      check("official hot video titles, play counts, rank order, and direct playback");

      const query = page.getByRole("textbox", { name: "搜索短剧、帖子、题材…" });
      await query.fill("都市"); await query.press("Enter");
      await page.getByRole("button", { name: titles[0], exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: titlePattern }).count(), titles.length);
      assert.equal(await page.getByRole("button", { name: titles[0], exact: true }).locator("img").getAttribute("loading"), "eager");
      assert.equal(await page.getByRole("button", { name: titles[0], exact: true }).locator("img").getAttribute("fetchpriority"), "high");
      assert.equal(await page.getByRole("button", { name: titles[2], exact: true }).locator("img").getAttribute("loading"), "lazy");
      await shot("search"); check("search results and responsive poster grid"); check("first-screen covers load eagerly at high priority; remaining covers stay lazy");
      if (test.android) {
        await page.getByRole("button", { name: titles[0], exact: true }).click();
        const position = page.locator(".feed-position-pill").first();
        await position.waitFor();
        const topControls = await position.evaluate(el => {
          const counter = el.getBoundingClientRect();
          const mute = document.querySelector('[aria-label="静音"], [aria-label="取消静音"]')?.getBoundingClientRect();
          return { counter: { left: counter.left, right: counter.right, top: counter.top, bottom: counter.bottom },
            mute: mute ? { left: mute.left, right: mute.right, top: mute.top, bottom: mute.bottom } : null };
        });
        assert(topControls.mute, "Playback mute control is visible");
        assert.equal(topControls.counter.left < topControls.mute.right && topControls.counter.right > topControls.mute.left
          && topControls.counter.top < topControls.mute.bottom && topControls.counter.bottom > topControls.mute.top, false,
        "Playback position and mute control do not overlap");
        await page.keyboard.press("Escape");
        await nav.getByRole("button", { name: "搜索", exact: true }).waitFor();
        check("Android player counter clears the mute control");
      }

      const searchPage = page.locator(".ios-page").filter({ has: query });
      await searchPage.getByRole("button", { name: "排行榜", exact: true }).click();
      const rankSegment = page.getByRole("group", { name: "榜单类型", exact: true });
      for (const [index, label] of ["热播榜", "推荐榜", "潜力榜"].entries()) {
        await rankSegment.getByRole("button", { name: label, exact: true }).click();
        await assertSlider(rankSegment, 3, index, `rank:${label}`);
        await page.locator(".ios-rank-row").first().waitFor();
        assert.equal(await page.locator(".ios-rank-row").count(), titles.length, `${label} shows all ranked fixture videos`);
      }
      await shot("ranks");
      await page.keyboard.press("Escape");
      await query.waitFor();
      check("all three rank choices move the shared indicator into the selected button bounds");

      await nav.getByRole("button", { name: "分类", exact: true }).click();
      await page.getByRole("button").filter({ has: page.getByText("专题", { exact: true }) }).click();
      const topic = page.getByRole("button").filter({ has: page.getByText("本周精选", { exact: true }) });
      await topic.waitFor();
      const topicShape = await topic.evaluate(el => {
        const style = getComputedStyle(el), bounds = el.getBoundingClientRect();
        return { radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius], width: bounds.width, height: bounds.height };
      });
      result.topicShape = topicShape;
      assert.deepEqual(topicShape.radii, ["16px", "16px", "16px", "16px"], "Topic cards keep four 16px corners");
      assert(topicShape.width > 32 && topicShape.height > 32, "A topic card retains a rectangular surface rather than becoming circular");
      await topic.click();
      await page.getByRole("button", { name: titles[0], exact: true }).waitFor();
      assert.equal(await topic.count(), 0, "Covered topic-list controls are removed from the accessibility tree");
      assert.equal(await page.getByRole("button", { name: "返回", exact: true }).count(), 1, "Only the top page's back control is accessible");
      await shot("topic");
      await page.keyboard.press("Escape");
      await topic.waitFor(); // Wait for React to commit before a second Escape.
      await page.keyboard.press("Escape");
      await page.getByRole("button").filter({ has: page.getByText("专题", { exact: true }) }).waitFor();
      check("topic navigation, inert background, and sequential Escape");

      await nav.getByRole("button", { name: "我的", exact: true }).click();
      await page.getByRole("button", { name: titles[0], exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: titlePattern }).count(), titles.length);
      await page.getByRole("button", { name: /未登录/ }).click();
      const profileLogin = page.getByRole("dialog", { name: "登录 HGhubX", exact: true });
      await profileLogin.getByLabel("账号", { exact: true }).fill("profile-fixture");
      await profileLogin.getByLabel("密码", { exact: true }).fill("test-password");
      await profileLogin.getByRole("button", { name: "登录", exact: true }).last().click();
      const profileLinks = page.locator(".ios-profile-links");
      await profileLinks.getByRole("button", { name: /^我的关注/ }).waitFor();
      await profileLinks.getByRole("button", { name: /^我的主页/ }).waitFor();
      await profileLogin.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: titles[0], exact: true }).locator(".ios-score-badge").waitFor();
      assert.equal(await page.getByRole("button", { name: titles[0], exact: true }).locator(".ios-score-badge").innerText(), "8.5");
      assert.equal(await page.getByRole("button", { name: titles[1], exact: true }).locator(".ios-score-badge").count(), 0, "Unrated videos do not show an empty score badge");
      const scorePosition = await page.getByRole("button", { name: titles[0], exact: true }).evaluate(el => {
        const art = el.querySelector(".ios-poster-art");
        const score = el.querySelector(".ios-score-badge");
        if (!art || !score) return null;
        const artBounds = art.getBoundingClientRect();
        const scoreBounds = score.getBoundingClientRect();
        return { top: scoreBounds.top - artBounds.top, right: artBounds.right - scoreBounds.right,
          artWidth: artBounds.width, scoreWidth: scoreBounds.width };
      });
      assert(scorePosition, "Rated poster exposes a positioned score badge");
      assert(Math.abs(scorePosition.top - 9) < 1.1, "Score badge stays in the cover's top corner");
      assert(Math.abs(scorePosition.right - 9) < 1.1, "Score badge stays in the cover's right corner");
      assert(scorePosition.top < scorePosition.artWidth * .25, "Score badge is not vertically centered on the cover");
      result.posterWidth = Math.round(await page.getByRole("button", { name: titles[0], exact: true }).evaluate(el => el.getBoundingClientRect().width));
      await shot("favorites");
      const profileSegment = page.getByRole("group", { name: "我的内容", exact: true });
      await assertSlider(profileSegment, 2, 0, "profile:我的收藏");
      const linkGeometry = () => profileLinks.evaluate(el => {
        const parent = el.getBoundingClientRect();
        return { x: parent.x, width: parent.width, height: parent.height, columns: [...el.children].map(child => {
          const bounds = child.getBoundingClientRect();
          return { left: bounds.x - parent.x, top: bounds.y - parent.y, width: bounds.width, height: bounds.height };
        }) };
      });
      const linksBefore = await linkGeometry();
      assert.equal(linksBefore.columns.length, 2, "Logged-in profile shows both shortcuts");
      const [followingColumn, homepageColumn] = linksBefore.columns;
      assert(followingColumn.width > 0 && Math.abs(followingColumn.width - homepageColumn.width) < 1
        && Math.abs(followingColumn.top - homepageColumn.top) < 1 && homepageColumn.left >= followingColumn.left + followingColumn.width,
      "Following and homepage shortcuts form two equal, adjacent columns");
      const assertStableLinks = async label => {
        const after = await linkGeometry();
        for (const property of ["x", "width", "height"]) assert(Math.abs(after[property] - linksBefore[property]) < 1, `${label}: shortcut group keeps its ${property}`);
        for (const [index, column] of after.columns.entries()) for (const property of ["left", "top", "width", "height"])
          assert(Math.abs(column[property] - linksBefore.columns[index][property]) < 1, `${label}: shortcut ${index + 1} keeps its ${property}`);
        return after;
      };
      await profileSegment.getByRole("button", { name: "观看历史", exact: true }).click();
      await assertSlider(profileSegment, 2, 1, "profile:观看历史");
      await page.getByText("第 3 集 · 0:55", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: titlePattern }).count(), 1);
      const linksHistory = await assertStableLinks("History switch");
      await profileSegment.getByRole("button", { name: "我的收藏", exact: true }).click();
      await assertSlider(profileSegment, 2, 0, "profile:我的收藏 restored");
      await page.getByRole("button", { name: titles[1], exact: true }).waitFor();
      const linksRestored = await assertStableLinks("Collection switch");
      result.profileLinks = { before: linksBefore, history: linksHistory, restored: linksRestored };
      await page.getByRole("button", { name: "退出登录", exact: true }).click();
      await page.getByRole("button", { name: /未登录/ }).waitFor();
      check("local favorites, score badges, preserved playback progress, two-way slider, and stable profile shortcut columns");

      const accountButton = page.getByRole("button", { name: /未登录/ });
      await accountButton.click();
      const dialog = page.getByRole("dialog", { name: "登录 HGhubX", exact: true });
      await dialog.waitFor();
      const username = dialog.getByLabel("账号", { exact: true });
      const password = dialog.getByLabel("密码", { exact: true });
      await username.fill("sample"); await password.fill("test-password");
      await dialog.getByRole("button", { name: "登录", exact: true }).last().click();
      await dialog.getByRole("alert").waitFor();
      assert.equal(await dialog.getByRole("alert").textContent(), "账号或密码不正确");
      assert.equal(await username.inputValue(), "sample", "An unsuccessful login preserves the account input");
      assert.equal(await page.getByRole("button", { name: "观看历史", exact: true }).count(), 0, "The login dialog makes its background inert");
      await dialog.evaluate(el => {
        const items = [...el.querySelectorAll("button:not(:disabled), input:not(:disabled)")].filter(item => item.tabIndex >= 0 && item.getClientRects().length);
        items.at(-1).focus();
      });
      await page.keyboard.press("Tab");
      assert(await dialog.evaluate(el => el.contains(document.activeElement)), "Forward Tab stays in the dialog");
      await page.keyboard.press("Shift+Tab");
      assert(await dialog.evaluate(el => el.contains(document.activeElement)), "Backward Tab stays in the dialog");
      await shot("login");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await page.waitForFunction(el => el === document.activeElement, await accountButton.elementHandle());
      await accountButton.click(); await dialog.waitFor();
      await returnFromOverlay(); await dialog.waitFor({ state: "hidden" });
      await accountButton.waitFor();
      check("visible form labels, login errors, focus trap, Escape, and overlay back");

      await page.getByRole("button", { name: "设置", exact: true }).click();
      const security = page.getByRole("switch", { name: "严格安全模式", exact: true });
      const appearance = page.getByRole("group", { name: "外观模式", exact: true });
      await security.waitFor();
      await page.locator(".ios-setting-group").first().waitFor();
      await page.waitForTimeout(550);
      const controlRadii = await page.evaluate(() => {
        const icon = document.querySelector(".ios-page .ios-icon-button");
        const settingIcon = document.querySelector(".ios-setting-icon");
        const segmented = document.querySelector(".ios-appearance-picker");
        const indicator = segmented?.querySelector(".ios-segmented-indicator");
        return {
          icon: icon && getComputedStyle(icon).borderRadius,
          settingIcon: settingIcon && getComputedStyle(settingIcon).borderRadius,
          segmented: segmented && getComputedStyle(segmented).borderRadius,
          indicator: indicator && getComputedStyle(indicator).borderRadius,
        };
      });
      assert.equal(controlRadii.icon, "50%", "Icon controls render as circles");
      assert.equal(controlRadii.settingIcon, "50%", "Setting symbols render on circular backplates");
      assert.equal(controlRadii.segmented, "999px", "Segmented controls use rounded outer corners");
      assert.equal(controlRadii.indicator, "999px", "Selected segment uses matching rounded corners");
      await assertSlider(appearance, 3, test.theme === "dark" ? 2 : 1, "appearance:initial");
      check("circular icon controls and rounded segmented controls");
      const pageIn = page.locator(".a-page-in");
      if (await pageIn.count()) {
        await pageIn.first().evaluate(async el => {
          await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => undefined)));
        });
      }
      const switches = page.getByRole("switch");
      result.switches = [];
      for (const item of await switches.all()) {
        await item.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const bounds = await item.boundingBox();
        const target = await item.evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight }));
        const visual = await item.evaluate(el => {
          const track = getComputedStyle(el.querySelector(".ios-switch-track"));
          const thumb = getComputedStyle(el.querySelector(".ios-switch-thumb"));
          const rail = el.querySelector(".ios-switch-track").getBoundingClientRect();
          const thumbBounds = el.querySelector(".ios-switch-thumb").getBoundingClientRect();
          const shell = el.closest(".plat-android");
          const activeIndicator = document.querySelector(".ios-mobile-nav .hg-drop .ios-liquid-fill");
          const activeTab = document.querySelector('.ios-mobile-nav-item[aria-current="page"]');
          return { platform: el.dataset.platform, trackWidth: track.width, trackHeight: track.height,
            trackRadius: track.borderRadius, trackBorder: track.borderTopWidth, trackBackground: track.backgroundImage,
            thumbBackground: thumb.backgroundImage, thumbRadius: thumb.borderRadius,
            thumbWidth: thumbBounds.width, thumbLeft: thumbBounds.left - rail.left, thumbRight: rail.right - thumbBounds.right,
            activeIndicator: activeIndicator ? getComputedStyle(activeIndicator).backgroundColor : null,
            activeTabColor: activeTab ? getComputedStyle(activeTab).color : null,
            androidShell: !!shell };
        });
        result.switches.push({ label: await item.getAttribute("aria-label"), width: target.width, height: target.height, visualBounds: bounds, ...visual });
        assert(target.width >= 44 && target.height >= (test.android ? 48 : 44), "Switch touch target meets the platform minimum");
        assert(["true", "false"].includes(await item.getAttribute("aria-checked")), "Switch exposes its state");
        const off = await item.evaluate(el => {
          const rail = el.querySelector(".ios-switch-track").getBoundingClientRect();
          const thumb = el.querySelector(".ios-switch-thumb").getBoundingClientRect();
          return { left: thumb.left - rail.left, right: rail.right - thumb.right };
        });
        if (test.android) {
          assert.equal(visual.platform, "android", "Android selects its platform switch variant");
          assert.equal(visual.trackWidth, "52px", "Android uses the compact Material switch track");
          assert.equal(visual.trackHeight, "18px", "Android uses a slim track");
          assert.equal(visual.trackRadius, "6px", "Android uses a square-edged track rather than the iOS capsule");
          assert.equal(visual.trackBackground, "none", "Android track has a solid material fill");
          assert.equal(visual.thumbRadius, "50%", "Android thumb is circular");
          assert.equal(visual.thumbBackground, "none", "Android thumb uses a solid surface");
          assert.equal(visual.androidShell, true, "Android fixture runs in the Android app shell");
          assert.notEqual(visual.activeIndicator, "rgba(0, 0, 0, 0)", "Android active navigation has a visible selection surface");
          assert.notEqual(visual.activeTabColor, "rgb(255, 255, 255)", "Android active navigation uses the selected ink color");
        } else if (test.mobile) {
          assert.equal(visual.platform, "ios", "iOS keeps its platform switch variant");
          assert.equal(visual.trackRadius, "999px", "iOS keeps its capsule track");
          assert.equal(visual.thumbRadius, "50%", "iOS keeps its circular thumb");
        }
        const initiallyOn = await item.getAttribute("aria-checked") === "true";
        const expectedLeft = initiallyOn ? (test.android ? 25 : 27) : (test.android ? 0 : 3);
        const expectedRight = initiallyOn ? (test.android ? 1 : 3) : (test.android ? 26 : 27);
        assert(Math.abs(off.left - expectedLeft) < 1.1, `${visual.platform} switch thumb reaches the correct left/right endpoint`);
        assert(Math.abs(off.right - expectedRight) < 1.1, `${visual.platform} switch thumb clears the correct track edge`);
        const wasOn = await item.getAttribute("aria-checked") === "true";
        const targetState = !wasOn;
        await item.evaluate((el, on) => { el.dataset.state = on ? "on" : "off"; }, targetState);
        await page.waitForTimeout(360);
        const moved = await item.evaluate(el => {
          const rail = el.querySelector(".ios-switch-track").getBoundingClientRect();
          const thumb = el.querySelector(".ios-switch-thumb").getBoundingClientRect();
          return { left: thumb.left - rail.left, right: rail.right - thumb.right };
        });
        const turnedOn = targetState;
        const movedLeft = turnedOn ? (test.android ? 25 : 27) : (test.android ? 0 : 3);
        const movedRight = turnedOn ? (test.android ? 1 : 3) : (test.android ? 26 : 27);
        assert(Math.abs(moved.left - movedLeft) < 1.1 && Math.abs(moved.right - movedRight) < 1.1,
          `${visual.platform} switch reaches both travel endpoints after activation`);
        const actualState = await item.getAttribute("aria-checked") === "true";
        assert.equal(actualState, wasOn, "Layout probe leaves the application switch state unchanged");
        await item.evaluate((el, on) => { el.dataset.state = on ? "on" : "off"; }, wasOn);
        await page.waitForTimeout(360);
      }
      const switchTravel = await security.evaluate(el => {
        const rail = el.querySelector(".ios-switch-track").getBoundingClientRect();
        const thumb = el.querySelector(".ios-switch-thumb").getBoundingClientRect();
        return { left: thumb.left - rail.left, right: rail.right - thumb.right };
      });
      const strictState = await security.getAttribute("aria-checked") === "true";
      assert.equal(switchTravel.left, strictState ? (test.android ? 25 : 27) : (test.android ? 0 : 3), "Security switch thumb matches its state");
      const androidShell = page.locator(".plat-android").first();
      const material = await page.locator(".ios-setting-group").first().evaluate(el => {
        const root = getComputedStyle(document.documentElement);
        const group = getComputedStyle(el);
        return {
          blur: group.backdropFilter || group.webkitBackdropFilter,
          surface: root.getPropertyValue("--glass-card-bg").trim(),
          background: root.getPropertyValue("--p-bg").trim(),
          text: root.getPropertyValue("--p-on").trim(),
          muted: root.getPropertyValue("--p-mut").trim(),
        };
      });
      assert.match(material.blur, new RegExp(`blur\\(${test.theme === "light" ? 28 : 22}px\\)`), "Glass panels use the theme-specific blur");
      if (test.theme === "light") {
        const contrast = (foreground, background) => {
          const rgb = color => {
            const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color);
            const channels = hex
              ? (hex[1].length === 3 ? [...hex[1]].map(channel => Number.parseInt(channel + channel, 16))
                : hex[1].match(/../g).map(channel => Number.parseInt(channel, 16)))
              : color.match(/[\d.]+/g).slice(0, 3).map(Number);
            return channels.map(channel => channel / 255 <= 0.04045
              ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4);
          };
          const luminance = color => rgb(color).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
          const a = luminance(foreground);
          const b = luminance(background);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        assert(contrast(material.text, material.background) >= 4.5, "Light primary text meets WCAG AA contrast");
        assert(contrast(material.muted, material.background) >= 4.5, "Light secondary text meets WCAG AA contrast");
        assert.match(material.surface, /\/\s*\.8[0-9]/, "Light glass remains dense enough to separate from media");
      }
      await appearance.getByRole("button", { name: test.theme === "dark" ? "浅色" : "深色", exact: true }).click();
      await assertSlider(appearance, 3, test.theme === "dark" ? 1 : 2, "appearance:opposite");
      const oppositeTheme = test.theme === "dark" ? "light" : "dark";
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, oppositeTheme);
      const beforeThemeBounds = test.android ? await androidShell.boundingBox() : null;
      await appearance.getByRole("button", { name: test.theme === "dark" ? "深色" : "浅色", exact: true }).click();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, test.theme);
      if (!test.reduced) assert(await page.locator("html").evaluate(el => el.classList.contains("theme-transitioning")), "Theme swap starts its transition wash");
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const lightBounds = test.android ? await androidShell.boundingBox() : null;
      if (test.android) assert.deepEqual(lightBounds, beforeThemeBounds, "Android page geometry stays stable during theme change");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Theme change does not cause horizontal layout overflow");
      await appearance.getByRole("button", { name: "深色", exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      await assertSlider(appearance, 3, 2, "appearance:深色");
      await appearance.getByRole("button", { name: "跟随", exact: true }).click();
      await assertSlider(appearance, 3, 0, "appearance:跟随");
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      await appearance.getByRole("button", { name: "浅色", exact: true }).scrollIntoViewIfNeeded();
      await appearance.scrollIntoViewIfNeeded();
      await shot("settings");
      const clearCache = page.getByRole("button").filter({ has: page.getByText("清理缓存", { exact: true }) });
      await clearCache.click();
      const confirmation = page.getByRole("dialog");
      await confirmation.waitFor();
      await returnFromOverlay();
      await confirmation.waitFor({ state: "hidden" });
      await security.waitFor();
      await page.waitForFunction(el => el === document.activeElement, await clearCache.elementHandle());
      check("settings state, 44px switches, adaptive appearance, theme motion and stable Android geometry");
      result.passed = true;
      console.log(`PASS ${name}`);
    } catch (error) {
      result.error = String(error.stack || error);
      await page.screenshot({ path: fileURLToPath(new URL(`${name}-failure.png`, output)), animations: "disabled" }).catch(() => {});
      console.error(`FAIL ${name}: ${error.message}`);
    } finally { await context.close(); if (caseBrowser !== browser) await caseBrowser.close(); }
  }
  assert.equal(report.cases.filter(test => !test.passed).length, 0, "All viewport scenarios pass");
  assert.deepEqual(report.errors, [], "No uncaught browser errors");
  assert.deepEqual(report.external, [], "No unexpected requests to live services");
} catch (error) {
  report.error = String(error.stack || error);
  console.error(report.error); process.exitCode = 1;
} finally {
  await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2));
  await browser?.close(); await vite?.close();
  console.log(`Artifacts: ${fileURLToPath(output)}`);
}
