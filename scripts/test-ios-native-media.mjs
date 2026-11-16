import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://127.0.0.1:34789/fixture-capability";
const UPSTREAM = "https://media.fixture.invalid/play?id=7&u=https%3A%2F%2Fother.fixture.invalid%2Fmovie";
const local = platform => platform === "ios" || platform === "macos" ? "hg://localhost"
  : platform === "linux" ? "http://127.0.0.1:17650" : "http://hg.localhost";
const agents = {
  ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Version/15.0 Mobile Safari/604.1",
  macos: "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 Version/16.0 Safari/605.1.15",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
  android: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36",
};
let vite, browser;
let passed = 0;
const pageErrors = [];

try {
  // The parent playback runner can have its own Vite server alive with real hls.js.
  // Keep this mocked dependency graph out of that server's optimized-dependency cache.
  vite = await createServer({ root, cacheDir: join(root, "node_modules/.vite-ios-native"), resolve: { alias: [{ find: /^hls\.js$/, replacement: join(root, "tests/ios-native-hls.ts") }] }, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  let executablePath = process.env.BROWSER_EXECUTABLE;
  if (!executablePath) {
    for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
      if (await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
    }
  }
  browser = await chromium.launch({ headless: true, executablePath });

  async function open(component, { platform = "ios", supported = false, src = UPSTREAM, hold = false, fail = false, autoPlay = true } = {}) {
    const context = await browser.newContext({ userAgent: agents[platform] });
    const page = await context.newPage();
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
    await page.addInitScript(({ component, supported, src, hold, fail, autoPlay, ORIGIN }) => {
      const fixture = {
        config: { component, src, active: true, muted: true, mounted: true, autoPlay }, ready: false, render: null,
        supported, hls: [], origins: 0, hold, fail, waiters: [], errors: [], assignments: [], plays: [], loads: 0,
      };
      const media = HTMLMediaElement.prototype;
      const source = Object.getOwnPropertyDescriptor(media, "src");
      Object.defineProperty(media, "src", {
        configurable: true, get() { return source.get.call(this); },
        set(value) { fixture.assignments.push(value); this.setAttribute("src", value); },
      });
      media.load = function () { fixture.loads++; };
      media.pause = function () {};
      media.play = function () {
        const src = this.getAttribute("src");
        fixture.plays.push(src);
        return src ? Promise.resolve() : Promise.reject(new DOMException("No source yet", "NotSupportedError"));
      };
      Object.assign(window, {
        nativeMediaFixture: fixture,
        __TAURI_INTERNALS__: { async invoke(command) {
          if (command === "media_http_origin") {
            fixture.origins++;
            if (fixture.hold) return new Promise((resolve, reject) => fixture.waiters.push({ resolve, reject }));
            if (fixture.fail) throw new Error("fixture server start failure");
            return ORIGIN;
          }
          if (command === "debug_log" || command === "playback_log_write") return;
          throw new Error(`Unexpected IPC: ${command}`);
        } },
      });
    }, { component, supported, src, hold, fail, autoPlay, ORIGIN });
    await page.goto(`${origin}tests/ios-native-media.html`);
    await page.waitForFunction(() => window.nativeMediaFixture.ready);
    return { context, page };
  }
  const snapshot = page => page.evaluate(() => {
    const fixture = window.nativeMediaFixture;
    return { src: document.querySelector("video")?.getAttribute("src") ?? null, assignments: fixture.assignments, origins: fixture.origins, hls: fixture.hls, errors: fixture.errors, plays: fixture.plays };
  });
  const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function render(page, change) { await page.evaluate(change => window.nativeMediaFixture.render(change), change); await settle(page); }
  async function resolveOrigin(page, index, value = ORIGIN) { await page.evaluate(({ index, value }) => window.nativeMediaFixture.waiters[index].resolve(value), { index, value }); await settle(page); }

  for (const component of ["surface", "player"]) {
    // First assertion intentionally checks old components' behavior too: baseline needs no new helper import.
    {
      const { context, page } = await open(component);
      await settle(page);
      const state = await snapshot(page);
      assert.equal(state.src, `${ORIGIN}/hls?u=${encodeURIComponent(UPSTREAM)}`, `${component}: iOS native uses HTTP capability transport, preserving extensionless upstream URL and its ?u=`);
      assert.equal(state.origins, 1);
      assert.equal(state.hls.length, 0);
      assert.ok(!state.assignments.some(url => url.startsWith("hg:")));
      passed++; await context.close();
    }
    for (const supported of [false, true]) {
      for (const route of ["hls", "seg"]) {
        const src = `${local("ios")}/${route}?u=${encodeURIComponent(UPSTREAM)}&fixture=kept`;
        const { context, page } = await open(component, { supported, src });
        await settle(page);
        const state = await snapshot(page);
        const hls = supported && route === "hls";
        assert.equal(state.origins, hls ? 0 : 1);
        assert.equal(state.hls.length, hls ? 1 : 0);
        assert.equal(hls ? state.hls[0].source : state.src, hls ? src : src.replace(local("ios"), ORIGIN), `${component}: preserve pre-proxied /${route} and use actual engine selection`);
        if (hls) {
          await render(page, { muted: false, active: false });
          await render(page, { active: true });
          assert.equal((await snapshot(page)).hls.length, 1, "ordinary render/activity changes retain HLS instance");
        }
        passed++; await context.close();
      }
    }
    {
      const { context, page } = await open(component, { supported: true });
      await settle(page);
      const state = await snapshot(page);
      assert.equal(state.origins, 0, "HLS engine does not start the native transport even with an older iOS UA");
      assert.equal(state.hls[0].source, `${local("ios")}/hls?u=${encodeURIComponent(UPSTREAM)}`, "extensionless upstream and its own ?u= remain intact on the HLS path");
      passed++; await context.close();
    }
    for (const platform of ["windows", "android", "macos", "linux"]) {
      for (const supported of [false, true]) {
        const { context, page } = await open(component, { platform, supported });
        await settle(page);
        const state = await snapshot(page);
        assert.equal(state.origins, 0, `${component}: ${platform} must not start iOS HTTP transport`);
        assert.equal(supported ? state.hls[0].source : state.src, `${local(platform)}/hls?u=${encodeURIComponent(UPSTREAM)}`);
        passed++; await context.close();
      }
    }
    {
      const { context, page } = await open(component, { hold: true });
      await page.waitForFunction(() => window.nativeMediaFixture.waiters.length === 1);
      assert.equal((await snapshot(page)).src, null);
      const next = "https://media.fixture.invalid/next-extensionless";
      await render(page, { src: next });
      await page.waitForFunction(() => window.nativeMediaFixture.waiters.length === 2);
      await resolveOrigin(page, 1);
      await resolveOrigin(page, 0, "http://127.0.0.1:34789/stale-capability");
      assert.equal((await snapshot(page)).src, `${ORIGIN}/hls?u=${encodeURIComponent(next)}`, "old origin resolution cannot overwrite current source");
      await render(page, { src: "https://media.fixture.invalid/unmounted" });
      await page.waitForFunction(() => window.nativeMediaFixture.waiters.length === 3);
      await render(page, { mounted: false });
      const before = await snapshot(page);
      await resolveOrigin(page, 2);
      const after = await snapshot(page);
      assert.deepEqual(after.assignments, before.assignments, "late origin resolution cannot attach after unmount");
      assert.deepEqual(after.plays, before.plays, "late origin resolution cannot autoplay after unmount");
      passed++; await context.close();
    }
    {
      const { context, page } = await open(component, { hold: true, autoPlay: false });
      await page.waitForFunction(() => window.nativeMediaFixture.waiters.length === 1);
      assert.deepEqual((await snapshot(page)).plays, [], "autoPlay=false waits for user intent");
      const play = component === "player"
        ? page.getByRole("group", { name: "播放控制", exact: true }).getByRole("button", { name: "播放", exact: true })
        : page.getByRole("button", { name: "播放", exact: true });
      await play.click();
      assert.deepEqual((await snapshot(page)).plays, [null], "manual play attempts the pending source and records playback intent");
      await resolveOrigin(page, 0);
      assert.deepEqual((await snapshot(page)).plays, [null, `${ORIGIN}/hls?u=${encodeURIComponent(UPSTREAM)}`], "manual playback resumes after async native origin resolves even when autoPlay=false");
      passed++; await context.close();
    }
    {
      const { context, page } = await open(component, { hold: true });
      await page.waitForFunction(() => window.nativeMediaFixture.waiters.length === 1);
      await render(page, { active: false });
      await resolveOrigin(page, 0);
      assert.deepEqual((await snapshot(page)).plays, [], "origin resolution respects the latest page activity");
      await render(page, { src: "" });
      assert.equal((await snapshot(page)).src, null, "empty source releases native transport");
      passed++; await context.close();
    }
    {
      const { context, page } = await open(component, { fail: true });
      if (component === "surface") await page.waitForFunction(() => window.nativeMediaFixture.errors.length === 1);
      else await page.getByText("本地媒体服务启动失败，请切换视频或重试", { exact: true }).waitFor();
      const failed = await snapshot(page);
      assert.equal(failed.src, null, "transport failure must never fall back to hg:// native playback");
      assert.equal(failed.assignments.length, 0);
      await page.evaluate(() => { window.nativeMediaFixture.fail = false; window.dispatchEvent(new Event("hg:proxy-changed")); });
      await page.waitForFunction(() => window.nativeMediaFixture.origins === 2 && document.querySelector("video")?.getAttribute("src")?.startsWith("http://127.0.0.1:"));
      assert.equal((await snapshot(page)).src, `${ORIGIN}/hls?u=${encodeURIComponent(UPSTREAM)}`, "proxy recovery retries failed transport initialization");
      await page.evaluate(() => { window.nativeMediaFixture.fail = true; });
      await render(page, { src: "https://media.fixture.invalid/failed-again" });
      assert.equal((await snapshot(page)).src, null);
      await page.evaluate(() => { window.nativeMediaFixture.fail = false; });
      const recovered = "https://media.fixture.invalid/recovered";
      await render(page, { src: recovered });
      assert.equal((await snapshot(page)).src, `${ORIGIN}/hls?u=${encodeURIComponent(recovered)}`, "new source retries failed transport initialization");
      passed++; await context.close();
    }
  }
  assert.deepEqual(pageErrors, [], "no browser runtime errors");
  console.log(`PASS ios-native-media: ${passed} cases (mock IPC/HLS, real Player/VideoSurface; native device decoding not exercised)`);
} finally {
  await browser?.close();
  await vite?.close();
}
