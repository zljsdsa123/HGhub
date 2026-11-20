import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture, unlockCalculator } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/inplace-search-back/", import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: "Real App in Chromium with Android UA and mocked Tauri IPC", checks: [], errors: [] };
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
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(installFixture, { theme: "light", titles: ["城市与晚风", "重逢在夏日以后", "星河旅人"] });
  await context.addInitScript(() => localStorage.setItem("hghubx_usage_agreement", JSON.stringify({
    version: "2026-11-15-v1", accepted: true, acceptedAt: "2026-11-15T00:00:00.000Z",
  })));
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });

  await page.goto(origin);
  await unlockCalculator(page);
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.waitFor();
  await page.waitForFunction(() => window.__IOS_UI_FIXTURE__.hasHardwareBack());
  await nav.getByRole("button", { name: "分类", exact: true }).click();
  await page.getByRole("button").filter({ has: page.getByText("专题", { exact: true }) }).click();
  await page.getByRole("heading", { name: "专题", exact: true }).waitFor();

  const searchButton = page.getByRole("button", { name: "搜索短剧", exact: true });
  await searchButton.click();
  const field = page.getByRole("textbox", { name: "短剧搜索关键词", exact: true });
  await field.waitFor();
  await field.fill("都市");
  await field.press("Enter");
  const result = page.getByRole("button").filter({ hasText: "城市与晚风" }).first();
  await result.waitFor();
  await result.click();
  await page.locator(".feed-position-pill").first().waitFor();

  await page.evaluate(() => window.__IOS_UI_FIXTURE__.hardwareBack());
  await page.waitForTimeout(150);
  assert.equal(await field.isVisible(), true, "Back from a pushed video leaves the covered search mounted and visible after returning");
  report.checks.push("hidden search does not consume back from a pushed video");

  await page.evaluate(() => window.__IOS_UI_FIXTURE__.hardwareBack());
  await page.waitForTimeout(150);
  assert.equal(await field.count(), 0, "First back in the topic closes only the in-place search");
  assert.equal(await page.getByRole("heading", { name: "专题", exact: true }).isVisible(), true, "Topic page remains after closing search");
  report.checks.push("first back closes search and keeps the topic page");

  await page.evaluate(() => window.__IOS_UI_FIXTURE__.hardwareBack());
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole("heading", { name: "专题", exact: true }).count(), 0, "Second back leaves the topic page");
  assert.equal(await page.getByRole("heading", { name: "分类", exact: true }).isVisible(), true, "Second back returns to the category tab");
  report.checks.push("second back follows the normal page stack");

  // Focus/inert contract merged from the retired test-inplace-search-focus.mjs
  // (same component, mobile context): modal focus, inert background, shortcut
  // containment, Tab wrap, and trigger-focus restore on close.
  // The stack pop returned to the category tab; re-enter the topic page where
  // the in-place search trigger lives.
  await page.getByRole("button").filter({ has: page.getByText("专题", { exact: true }) }).click();
  await page.getByRole("heading", { name: "专题", exact: true }).waitFor();
  await searchButton.click();
  const dialog = page.getByRole("dialog", { name: "短剧搜索", exact: true });
  await dialog.waitFor();
  await field.waitFor();
  assert.equal(await field.evaluate(element => element === document.activeElement), true, "Search input receives initial focus");
  assert.equal(await dialog.getAttribute("aria-modal"), "true");
  assert.equal(await page.getByRole("heading", { name: "专题", exact: true }).evaluate(element => !!element.closest("[inert]")), true,
    "Page content behind the in-place search is inert");
  report.checks.push("search is a modal dialog, receives focus, and makes the covered page inert");

  await dialog.getByRole("button", { name: "退出搜索", exact: true }).focus();
  for (const key of ["/", "1", "2", "3", "4"]) {
    await page.keyboard.press(key);
    assert.equal(await dialog.count(), 1, `${key} must not switch tabs or discard the search page`);
    assert.equal(await field.isVisible(), true, `${key} keeps the search field visible`);
  }
  await field.focus();
  report.checks.push("shell slash and number shortcuts stay inside search without navigating away");

  const activeInside = () => page.evaluate(() => {
    const dialogElement = document.querySelector(".ios-inplace-search");
    return !!dialogElement && !!document.activeElement && dialogElement.contains(document.activeElement);
  });
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    assert.equal(await activeInside(), true, `Tab ${index + 1} stays inside the search dialog`);
  }
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Shift+Tab");
    assert.equal(await activeInside(), true, `Shift+Tab ${index + 1} stays inside the search dialog`);
  }
  report.checks.push("Tab and Shift+Tab wrap without reaching the inert page");

  await field.fill("都市");
  await field.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await searchButton.evaluate(element => element === document.activeElement), true, "Closing search restores focus to its trigger");
  report.checks.push("Escape closes only the search and restores focus");
  report.passed = true;
  await page.screenshot({ path: fileURLToPath(new URL("final.png", output)), animations: "disabled" });
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
