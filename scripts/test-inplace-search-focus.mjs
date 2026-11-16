import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/inplace-search-focus/", import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: "Real App in Chromium with mocked Tauri IPC", checks: [], errors: [] };
let vite, browser;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 14281, strictPort: true } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || "/usr/bin/google-chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", error => report.errors.push(error.message));
  await page.addInitScript(installFixture, { theme: "light", titles: ["城市与晚风", "重逢在夏日以后", "星河旅人"] });
  await page.addInitScript(() => localStorage.setItem("hghubx_usage_agreement", JSON.stringify({
    version: "2026-11-15-v1", accepted: true, acceptedAt: "2026-11-15T00:00:00.000Z",
  })));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });

  await page.goto(origin);
  await page.getByRole("navigation", { name: "主导航" }).waitFor();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "分类", exact: true }).click();
  await page.getByRole("button").filter({ has: page.getByText("专题", { exact: true }) }).click();
  await page.getByRole("heading", { name: "专题", exact: true }).waitFor();

  const trigger = page.getByRole("button", { name: "搜索短剧", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "短剧搜索", exact: true });
  await dialog.waitFor();
  const field = dialog.getByRole("textbox", { name: "短剧搜索关键词", exact: true });
  await field.waitFor();
  assert.equal(await field.evaluate(element => element === document.activeElement), true, "Search input receives initial focus");
  assert.equal(await dialog.getAttribute("aria-modal"), "true");
  assert.equal(await page.getByRole("heading", { name: "专题", exact: true }).evaluate(element => !!element.closest("[inert]")), true,
    "Page content behind the in-place search is inert");
  report.checks.push("search is a modal dialog, receives focus, and makes the covered page inert");

  // Non-input controls must not leak shortcuts to the shell's window listener.
  await dialog.getByRole("button", { name: "退出搜索", exact: true }).focus();
  for (const key of ["/", "1", "2", "3", "4"]) {
    await page.keyboard.press(key);
    assert.equal(await dialog.count(), 1, `${key} must not switch tabs or discard the search page`);
    assert.equal(await field.isVisible(), true, `${key} keeps the search field visible`);
    assert.equal(await page.getByRole("heading", { name: "专题", exact: true, includeHidden: true }).count(), 1,
      `${key} keeps the underlying topic page mounted`);
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

  await page.evaluate(() => {
    const escaped = document.createElement("button");
    escaped.id = "escaped-focus";
    escaped.textContent = "background";
    const pageRoot = document.querySelector(".ios-page:not(.ios-inplace-search)");
    pageRoot?.append(escaped);
    escaped.focus();
  });
  assert.equal(await activeInside(), true, "Programmatic background focus is redirected into the dialog");
  await page.waitForFunction(() => document.getElementById("escaped-focus")?.closest("[inert]"));
  report.checks.push("escaped programmatic focus returns to the search dialog");

  await field.fill("都市");
  await field.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true, "Closing search restores focus to its trigger");
  report.checks.push("Escape closes only the search and restores focus");

  await trigger.click();
  await page.getByRole("dialog", { name: "短剧搜索", exact: true }).waitFor();
  await page.getByRole("textbox", { name: "短剧搜索关键词", exact: true }).fill("都市");
  await page.getByRole("textbox", { name: "短剧搜索关键词", exact: true }).press("Enter");
  await page.getByRole("button").filter({ hasText: "城市与晚风" }).first().waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "短剧搜索", exact: true }).waitFor({ state: "detached" });
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
  report.checks.push("Escape also closes the search from a field/results state");

  await trigger.click();
  const coveredDialog = page.getByRole("dialog", { name: "短剧搜索", exact: true, includeHidden: true });
  await coveredDialog.waitFor();
  await page.getByRole("textbox", { name: "短剧搜索关键词", exact: true }).fill("都市");
  await page.getByRole("textbox", { name: "短剧搜索关键词", exact: true }).press("Enter");
  await page.getByRole("button").filter({ hasText: "城市与晚风" }).first().click();
  await page.locator(".desktop-context-header").first().waitFor();
  assert.equal(await coveredDialog.evaluate(element => !!element.closest("[inert]")), true,
    "Opening a Feed covers and inerts the mounted in-place search");

  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
  await page.keyboard.press("Tab");
  const coveredTabState = await page.evaluate(() => ({
    onBody: document.activeElement === document.body,
    insideSearch: !!document.activeElement?.closest(".ios-inplace-search"),
    insideInert: !!document.activeElement?.closest("[inert]"),
  }));
  assert.deepEqual(coveredTabState, { onBody: false, insideSearch: false, insideInert: false },
    "Tab in a visible Feed is not swallowed by the hidden search");
  report.checks.push("covered search does not intercept Tab in the Feed");

  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await page.keyboard.press("Escape");
  await page.locator(".desktop-context-header").first().waitFor({ state: "detached" });
  assert.equal(await coveredDialog.isVisible(), true, "Escape exits the Feed instead of closing the covered search");
  await page.keyboard.press("Escape");
  await coveredDialog.waitFor({ state: "detached" });
  report.checks.push("covered search does not intercept Escape; returning to it preserves the open search");

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
