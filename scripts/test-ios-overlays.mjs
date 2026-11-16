// Exercise the real overlay/back components in StrictMode without Tauri or upstream traffic.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "ios-overlays", new Date().toISOString().replace(/[:.]/g, "-"));
const report = {
  environment: "Real Modal/Sheet/controls/back in React StrictMode; Chromium behavior fixture; not native WebView verification",
  passed: [], pageErrors: [], external: [],
};
await mkdir(output, { recursive: true });
let vite, browser, page;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage();
  page.on("pageerror", error => report.pageErrors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
    report.external.push(route.request().url());
    return route.abort();
  });
  const url = `${origin}scripts/fixtures/ios-overlays.html`;
  const active = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("aria-label"));
  const waitActive = id => page.waitForFunction(id =>
    (document.activeElement?.id || document.activeElement?.getAttribute("aria-label")) === id, id);
  const load = async (query = "") => {
    await page.goto(`${url}${query}`);
    await page.waitForFunction(() => !!window.iosOverlayFixture);
  };
  const openParent = async () => { await page.locator("#opener").click(); await waitActive("first"); };
  const openChild = async () => { await page.locator("#first").click(); await waitActive("child-first"); };
  const waitNoOverlays = () => page.waitForFunction(() => document.querySelectorAll(".ios-overlay").length === 0);

  await load();
  await openParent();
  assert(await page.locator("#background").evaluate(el => el.inert), "Modal background must be inert");
  assert(await page.locator("#pre-inert").evaluate(el => el.inert));
  await page.keyboard.press("Shift+Tab"); assert.equal(await active(), "last");
  await page.keyboard.press("Tab"); assert.equal(await active(), "first");
  await page.keyboard.press("Tab"); assert.equal(await active(), "custom", "Skip negative tabindex but include custom controls");
  await page.keyboard.press("Tab"); assert.equal(await active(), "last");
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "late"; button.textContent = "Late background";
    document.body.append(button); button.focus();
  });
  assert.notEqual(await active(), "late", "Programmatic focus must stay in the dialog");
  await page.waitForFunction(() => document.getElementById("late").inert);
  await page.keyboard.press("Escape"); await waitActive("opener");
  await waitNoOverlays();
  assert(!(await page.locator("#background").evaluate(el => el.inert)));
  assert(!(await page.locator("#late").evaluate(el => el.inert)));
  assert(await page.locator("#pre-inert").evaluate(el => el.inert), "Pre-existing inert must survive close");
  report.passed.push("Native autoFocus restores its opener; Tab wraps through custom controls; escaped focus and late background nodes stay isolated; original inert values are restored");

  await load();
  await openParent(); await openChild();
  assert(await page.getByRole("dialog", { name: "Parent", includeHidden: true }).evaluate(el => !!el.closest("[inert]")));
  await page.keyboard.press("Shift+Tab"); assert.equal(await active(), "child-last");
  await page.keyboard.press("Tab"); assert.equal(await active(), "child-first");
  await page.keyboard.press("Escape"); await waitActive("first");
  assert(!(await page.getByRole("dialog", { name: "Parent" }).evaluate(el => !!el.closest("[inert]"))));
  await page.keyboard.press("Escape"); await waitActive("opener");
  assert.deepEqual(await page.evaluate(() => window.iosOverlayFixture.events), { closed: ["child", "parent"], escapedToPage: 0 });
  report.passed.push("Escape closes only the top nested dialog, restores parent focus, then restores the page opener without reaching page navigation");

  await load();
  await openParent(); await openChild();
  assert(await page.evaluate(() => window.iosOverlayFixture.runBack())); await waitActive("first");
  assert(await page.evaluate(() => window.iosOverlayFixture.runBack())); await waitActive("opener");
  assert.deepEqual(await page.evaluate(() => window.iosOverlayFixture.events.closed), ["child", "parent"]);
  report.passed.push("Hardware-back dispatch closes child then parent, restoring focus one layer at a time");

  await load();
  await page.locator("#empty-opener").click(); await waitActive("Empty");
  await page.keyboard.press("Tab"); assert.equal(await active(), "Empty");
  await page.keyboard.press("Shift+Tab"); assert.equal(await active(), "Empty");
  await page.keyboard.press("Escape"); await waitActive("empty-opener");
  report.passed.push("A dialog without interactive controls receives and retains focus until Escape restores its opener");

  await load();
  await openParent(); await openChild();
  await page.evaluate(() => window.iosOverlayFixture.setParent(false));
  assert.equal(await active(), "child-first", "Closing a background layer must not steal child focus");
  await page.getByRole("dialog", { name: "Child", includeHidden: true }).waitFor({ state: "detached" });
  await waitActive("opener");
  report.passed.push("Closing a parent while its child remains mounted preserves child focus and passes the original opener through final unmount");

  await load("?nested=1"); await waitActive("child-first");
  const nesting = await page.locator(".ios-overlay.is-open").evaluateAll(elements => elements.map(element => ({
    name: element.querySelector('[role="dialog"]').getAttribute("aria-label"), inert: element.inert,
    z: Number(getComputedStyle(element).zIndex),
  })));
  const parent = nesting.find(layer => layer.name === "Parent"), child = nesting.find(layer => layer.name === "Child");
  assert(parent.inert && !child.inert && child.z > parent.z, "Initially mounted child must be the interactive and visual top layer");
  assert(await page.evaluate(() => window.iosOverlayFixture.runBack())); await waitActive("first");
  await page.keyboard.press("Escape"); await waitNoOverlays();
  report.passed.push("Initially open nested dialogs preserve child-above-parent order despite StrictMode and child-first layout effects");

  await load();
  const back = await page.evaluate(() => {
    const { registerOverlayBack: register, runBack, setBackHandler } = window.iosOverlayFixture;
    const calls = [];
    setBackHandler(() => { calls.push("page"); return true; });
    const shared = () => { calls.push("shared"); return true; };
    const offFirst = register(shared), offSecond = register(shared);
    offFirst(); offFirst(); runBack(); offSecond();
    const offLower = register(() => { calls.push("lower"); return false; });
    const offMiddle = register(() => { calls.push("removed-middle"); return false; });
    const offTop = register(() => { calls.push("top"); offMiddle(); return false; });
    runBack(); offTop(); offLower();
    let offNew;
    const offOpening = register(() => { calls.push("opening"); offNew = register(() => { calls.push("new"); return true; }); return false; });
    runBack(); offOpening(); runBack(); offNew();
    const offError = register(() => { throw Error("fixture: close failed"); });
    const failedConsumed = runBack(); offError();
    setBackHandler(null);
    return { calls, failedConsumed, empty: runBack() };
  });
  assert.deepEqual(back, { calls: ["shared", "top", "lower", "page", "opening", "page", "new"], failedConsumed: true, empty: false });
  report.passed.push("Back registration cleanup is idempotent; mutation cannot repeat handlers or dismiss a newly opened layer; close failures cannot navigate the page underneath");

  assert.deepEqual(report.pageErrors, [], "Fixture must have no uncaught browser errors");
  assert.deepEqual(report.external, [], "Overlay interaction tests must not require external traffic");
  console.log(`PASS: ${report.passed.length} iOS overlay regressions (React StrictMode)`);
  console.log(`Report: ${join(output, "report.json")}`);
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await vite?.close();
}
