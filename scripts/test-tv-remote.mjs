// Executed by the existing GitHub Actions playback workflow with scenarios=tv.
// Real TV bootstrap/components/Worker/IndexedDB. All IPC/media remain fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import { chromium } from "playwright-core";
import { installTvFixture } from "../tests/tv-remote-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "tv-remote", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "Chromium actual TV edition; strict mock IPC; generated local MP4; no upstream", cases: [], errors: [], external: [], screenshots: [] };
let vite, browser, mediaDirectory, origin;
const contexts = [];
let activeContext;
const savedEdition = process.env.VITE_APP_EDITION;
async function scenario(name, run) {
  const item = { name, status: "running" }; report.cases.push(item);
  try { item.metrics = await run(); item.status = "passed"; console.log(`PASS TV ${name}`); }
  catch (error) { item.status = "failed"; item.error = String(error.stack || error); throw error; }
  finally {
    if (activeContext) {
      for (const page of activeContext.pages()) {
        const unknown = await page.evaluate(() => window.__tvFixture?.unknown || []).catch(() => []);
        report.errors.push(...unknown.map(command => `Unexpected fixture IPC: ${command}`));
        if (item.status === "failed") await page.screenshot({ path: join(output, `${name}-failed.png`) }).catch(() => {});
      }
      await activeContext.tracing.stop({ path: join(output, `${name}-trace.zip`) }).catch(() => {});
      await activeContext.close();
      contexts.splice(contexts.indexOf(activeContext), 1); activeContext = undefined;
    }
    await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  }
}
async function open({ accepted = true, isolated = false, width = 1280, height = 720, fixture = {}, posterSizes = {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", userAgent: "Mozilla/5.0 (Linux; Android 12; TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" });
  contexts.push(context);
  activeContext = context;
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on("pageerror", error => report.errors.push(error.message));
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin === "http://hg.localhost" && url.pathname === "/img") {
      const id = new URL(url.searchParams.get("u")).pathname.split("/").at(-1);
      const [width, height] = posterSizes[id] || [240, 360];
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 240 360"><rect width="240" height="360" fill="#234960"/><path d="M95 140L160 180L95 220Z" fill="#60cdff"/></svg>` });
    }
    if (url.origin === "http://hg.localhost" && url.pathname === "/seg") {
      const data = await readFile(join(mediaDirectory, "fixture.mp4"));
      const range = route.request().headers().range;
      const match = /^bytes=(\d+)-(\d*)$/.exec(range || "");
      if (match) {
        const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
        return route.fulfill({ status: 206, contentType: "video/mp4", headers: { "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${data.length}` }, body: data.subarray(start, end + 1) });
      }
      return route.fulfill({ status: 200, contentType: "video/mp4", headers: { "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes" }, body: data });
    }
    if (url.protocol === "blob:" || url.protocol === "data:") return route.continue();
    report.external.push(url.href); return route.abort("blockedbyclient");
  });
  await page.addInitScript(installTvFixture, { ...fixture, accepted });
  await page.goto(`${origin}${isolated ? "/tests/tv-remote.html" : "/"}`);
  if (!isolated && accepted) await page.locator('[data-tv-focus="nav-home"]').waitFor();
  return { context, page };
}
const activate = async (page, key) => {
  const element = page.locator(`[data-tv-focus=${JSON.stringify(key)}]`).filter({ visible: true }).first();
  await page.waitForFunction(key => {
    const element = [...document.querySelectorAll("[data-tv-focus]")].find(item => item.getAttribute("data-tv-focus") === key && item.getClientRects().length);
    return !!element && !element.matches(":disabled");
  }, key);
  await element.focus(); await page.keyboard.press("Enter");
};
const calls = (page, command) => page.evaluate(command => window.__tvFixture.calls.filter(call => call.command === command), command);
const activeKey = page => page.evaluate(() => document.activeElement?.getAttribute("data-tv-focus"));
const screenshot = async (page, file) => {
  await page.screenshot({ path: join(output, file), animations: "disabled" });
  report.screenshots.push(file);
};
async function assertShelfWidths(page, state) {
  const sizes = await page.evaluate(() => {
    const shelf = document.querySelector('[data-tv-region="home-继续观看"]');
    return { expected: parseFloat(getComputedStyle(document.documentElement).fontSize) * 8,
      cards: [...shelf.children].map(slot => ({ slot: slot.offsetWidth, card: slot.querySelector(".tv-card").offsetWidth,
        art: slot.querySelector(".tv-card-art").offsetWidth })),
      recommendation: document.querySelector('[data-tv-region="home-推荐"] .tv-card')?.offsetWidth };
  });
  assert(sizes.cards.length > 0, `${state}: history shelf must contain cards`);
  for (const [index, widths] of sizes.cards.entries()) for (const [part, width] of Object.entries(widths)) {
    assert(Math.abs(width - sizes.expected) <= 1, `${state}: history ${index} ${part} width ${width} must equal shelf width ${sizes.expected}`);
  }
  if (sizes.recommendation !== undefined) assert(Math.abs(sizes.recommendation - sizes.expected) <= 1, `${state}: direct recommendation cards use the same width`);
  return sizes;
}
const catalogStatus = page => page.evaluate(async () => {
  const request = indexedDB.open("hghubx-tv-catalog-v1", 1);
  const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const read = db.transaction("checkpoints", "readonly").objectStore("checkpoints").get(window.__tvFixture.base);
  const value = await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); }); db.close(); return value;
});
try {
  process.env.VITE_APP_EDITION = "tv";
  mediaDirectory = await mkdtemp(join(tmpdir(), "hghubx-tv-media-"));
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10", "-t", "60", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(mediaDirectory, "fixture.mp4")], { timeout: 60000 });
  vite = await createServer({ root, cacheDir: join(root, "node_modules/.vite-tv-remote"),
    // Worker-only dependencies otherwise arrive after the first page has mounted
    // and Vite can invalidate its optimized graph in the middle of a scenario.
    optimizeDeps: { include: ["pinyin-pro"] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, open: false } });
  await vite.listen(); origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  let executablePath = process.env.BROWSER_EXECUTABLE;
  if (!executablePath) {
    for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
      if (await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
    }
  }
  browser = await chromium.launch({ headless: true, executablePath: executablePath || chromium.executablePath(), args: ["--autoplay-policy=no-user-gesture-required"] });
  report.browser = browser.version();
  await scenario("history-shelf-width-loading-ready", async () => {
    const { page } = await open({ fixture: { heldDetailIds: [1, 2, 3], legacy: { history: [1, 2, 3].map((id, index) => ({ id, ep: 1, t: 5, dur: 60, at: 30 - index })) } },
      posterSizes: { 1: [160, 400], 2: [900, 300], 3: [500, 500] } });
    const shelf = page.locator('[data-tv-region="home-继续观看"]');
    await page.waitForFunction(() => window.__tvFixture.detailReleases.length === 2);
    assert.equal(await shelf.getByRole("button", { name: "正在加载影片信息", exact: true }).count(), 3);
    await page.locator('[data-tv-region="home-推荐"] .tv-card').first().waitFor();
    const loading = await assertShelfWidths(page, "loading");
    await page.evaluate(() => {
      const fixture = window.__tvFixture;
      fixture.cards[0].title = "短名";
      fixture.cards[1].title = "这是一部标题很长且不应改变封面宽度的作品";
      fixture.cards[2].title = "A_Long_Unbroken_Title_For_Card_Width";
      fixture.heldDetailIds = []; fixture.releaseDetails();
    });
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('[data-tv-region="home-继续观看"] .tv-card')];
      return cards.length === 3 && cards.every(card => {
        const image = card.querySelector("img"); return image?.complete && image.naturalWidth > 0;
      });
    });
    assert.deepEqual(await shelf.locator("strong").allTextContents(), ["短名", "这是一部标题很长且不应改变封面宽度的作品", "A_Long_Unbroken_Title_For_Card_Width"]);
    assert.deepEqual(await shelf.locator("img").evaluateAll(images => images.map(image => [image.naturalWidth, image.naturalHeight])), [[160, 400], [900, 300], [500, 500]]);
    const ready = [];
    for (const [width, height] of [[1280, 720], [1920, 1080], [3840, 2160]]) {
      await page.setViewportSize({ width, height });
      ready.push({ width, height, ...await assertShelfWidths(page, "ready") });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    // Simulate a WebView without flex gap; the fallback belongs to each slot,
    // including LibraryCard's observer wrapper, rather than its inner button.
    const gaps = await page.evaluate(() => {
      document.documentElement.setAttribute("data-legacy-flex-gap", "");
      return ["home-继续观看", "home-推荐"].map(region => {
        const track = document.querySelector(`[data-tv-region="${region}"]`); track.style.gap = "0px";
        const slots = [...track.children];
        return { region, expected: parseFloat(getComputedStyle(document.documentElement).fontSize) * .9,
          values: slots.slice(1, 3).map((slot, index) => slot.offsetLeft - slots[index].offsetLeft - slots[index].offsetWidth) };
      });
    });
    for (const row of gaps) for (const gap of row.values) assert(Math.abs(gap - row.expected) <= 1, `${row.region}: legacy spacing ${gap} must equal ${row.expected}`);
    await assertShelfWidths(page, "legacy gap");
    await screenshot(page, "history-shelf-equal-width-1280x720.png");
    return { loading, ready, legacyGaps: gaps };
  });
  await scenario("agreement-gate-single-controller", async () => {
    const { page } = await open({ accepted: false });
    await page.locator('[data-tv-focus="agreement-checkbox"]').waitFor();
    // index.html carries the ES5 startup watchdog again (#138); the fixture
    // counts ready() calls through __HG_STARTUP__. The gate contract here is:
    // mounting the gate IS startup success — no content IPC, exactly one
    // keyboard listener and one native back subscription before acceptance.
    const pre = await page.evaluate(() => ({ ready: window.__tvFixture.startupReady, keys: window.__tvFixture.keyboardListeners,
      native: window.__tvFixture.nativeListeners, requests: window.__tvFixture.calls.filter(call => /^(api_|app_boot|line_auto|line_health)/.test(call.command)) }));
    assert.equal(pre.keys, 1); assert.equal(pre.native, 1); assert.deepEqual(pre.requests, []);
    assert(await page.locator('[data-tv-focus="agreement-accept"]').isDisabled());
    await activate(page, "agreement-checkbox");
    assert(await page.locator('[data-tv-focus="agreement-checkbox"]').isChecked());
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    });
    assert(await page.locator('[data-tv-focus="agreement-checkbox"]').isChecked(), "Confirm repeat must not toggle twice");
    await activate(page, "agreement-accept");
    await page.locator('[data-tv-focus="nav-home"]').waitFor();
    assert.equal((await calls(page, "app_boot")).length, 1);
    assert.equal(await page.locator("#hg-startup-error").count(), 0);
    return pre;
  });
  await scenario("keyboard-focus-modal-tag-gate", async () => {
    const { page } = await open();
    const card = page.locator('[data-tv-region="home-推荐"] [data-tv-focus="video:1"]');
    await card.waitFor(); await card.focus(); await page.keyboard.press("Enter");
    await page.locator('[data-tv-focus="detail:video:1:more"]').waitFor();
    assert.equal(await page.locator(".tv-page-heading > :not(h1), .tv-detail-eyebrow").count(), 0, "Page chrome must contain no decorative subtitles");
    await page.waitForFunction(() => !document.querySelector('[data-tv-focus="detail:video:1:more"]')?.disabled);
    await screenshot(page, "detail-1280x720.png");
    await activate(page, "detail:video:1:more");
    await page.getByRole("dialog", { name: "屏蔽标签" }).waitFor();
    for (const key of ["Tab", "ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Tab"]) {
      await page.keyboard.press(key);
      assert(await page.evaluate(() => !!document.activeElement?.closest('[data-tv-modal="detail-tags:video:1"]')), `Modal must own focus after ${key}: ${await page.evaluate(() => JSON.stringify({ active: document.activeElement?.getAttribute?.("data-tv-focus") ?? document.activeElement?.tagName, hasFocus: document.hasFocus(), modalPresent: !!document.querySelector('[data-tv-modal="detail-tags:video:1"]') }))}`);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-tv-focus") === "detail:video:1:more");
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.__tvFixture.back(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-tv-focus") === "video:1" && !!document.activeElement?.closest('[data-tv-region="home-推荐"]'));
    assert.equal(await page.evaluate(() => window.__tvFixture.exits), 0, "Native and keyboard back pair must pop once");
    await page.keyboard.press("Enter"); await activate(page, "detail:video:1:more");
    await activate(page, "block:都市"); await activate(page, "block-confirm");
    await page.getByRole("heading", { name: "内容已屏蔽" }).waitFor();
    assert.equal(await page.locator(".tv-detail-cover img").count(), 0); assert.equal(await page.locator("video").count(), 0);
    return { focusRestored: true, modalTrapped: true, duplicateBackSuppressed: true, blockedMediaUnmounted: true };
  });
  await scenario("episode-grid-uniform-height", async () => {
    // Episode 1 has a short label, episode 2 a long wrapping title, and the
    // legacy history marks episode 2 with the extra "上次观看" line. All three
    // stresses used to stretch a single grid cell taller than its neighbours.
    const { page } = await open({ fixture: { legacy: { history: [{ id: 1, ep: 2, t: 23, dur: 60, at: 300 }] } } });
    await page.locator('[data-tv-region="home-推荐"] [data-tv-focus="video:1"]').waitFor();
    await activate(page, "video:1");
    await page.locator('[data-tv-focus="detail:video:1:part:2"]').waitFor();
    await page.locator('[data-tv-focus="detail:video:1:part:2"] small').filter({ hasText: "上次观看" }).waitFor();
    const measure = () => page.evaluate(() => {
      const buttons = [...document.querySelectorAll(".tv-detail-episode-grid button")];
      return buttons.map(button => {
        const label = button.querySelector("span");
        return { height: button.getBoundingClientRect().height,
          scrollHeight: button.scrollHeight, clientHeight: button.clientHeight,
          labelClamped: label ? label.scrollHeight > label.clientHeight + 1 : false,
          labelText: label?.textContent || "" };
      });
    });
    const results = [];
    for (const [width, height] of [[1280, 720], [1920, 1080], [3840, 2160]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const cells = await measure();
      assert.equal(cells.length, 2, "Both episodes must render");
      const expected = parseFloat(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)) * 4.6667;
      for (const [index, cell] of cells.entries()) {
        assert(Math.abs(cell.height - expected) <= 1, `${width}px: episode ${index + 1} height ${cell.height} must equal ${expected}`);
        assert(cell.scrollHeight <= cell.clientHeight + 1, `${width}px: episode ${index + 1} content must fit its fixed cell`);
      }
      assert(Math.abs(cells[0].height - cells[1].height) <= 1, `${width}px: episode cells must be equal height`);
      results.push({ width, height, heights: cells.map(cell => cell.height), longLabelClamped: cells[1].labelClamped });
    }
    assert(results.some(result => result.longLabelClamped), "The long episode title must clamp, not stretch the cell");
    await page.setViewportSize({ width: 1280, height: 720 });
    await screenshot(page, "episode-grid-uniform-1280x720.png");
    return results;
  });
  await scenario("actual-worker-initials-resume-errors", async () => {
    const { page } = await open();
    await activate(page, "nav-search");
    await page.getByText(/目录同步完成/).waitFor();
    const status = await catalogStatus(page); assert.equal(status.count, 12); assert.equal(status.complete, true);
    const matches = await page.evaluate(async () => {
      const { queryCatalog } = await import("/src/tv/search/catalog.ts");
      const p = { blockedTags: [], paused: false, hideUntagged: false }, result = {};
      for (const query of ["WDSJ", "wdsj", "DSJ", "wdai sj2", "W-D_S.J"]) result[query] = (await queryCatalog(window.__tvFixture.base, query, 0, p)).items.map(item => `${item.kind}:${item.id}`);
      return result;
    });
    assert.deepEqual(matches.WDSJ, matches.wdsj); assert.deepEqual(matches.WDSJ, matches["W-D_S.J"]);
    assert.deepEqual(matches.WDSJ.slice(0, 3), ["video:1", "video:4", "video:2"]); assert(matches.DSJ.includes("video:1")); assert.deepEqual(matches["wdai sj2"], ["video:5"]);
    for (const key of "WDSJ") await activate(page, `search:key:${key}`);
    await page.waitForTimeout(350); assert.equal(await activeKey(page), "search:key:J");
    await page.waitForFunction(() => document.querySelector(".tv-search-query")?.textContent === "WDSJ");
    await page.locator('[data-tv-focus="search:video:1"]').waitFor();
    await screenshot(page, "search-1280x720.png");
    assert.equal((await calls(page, "api_search")).length, 0); assert((await page.evaluate(() => window.__tvFixture.postMax)) <= 2);
    await page.evaluate(async () => { window.__tvFixture.catalogMode = "repeat"; await (await import("/src/tv/search/catalog.ts")).retryCatalog(window.__tvFixture.base, true); });
    await page.getByText(/上游返回了重复目录页/).waitFor();
    const failed = await catalogStatus(page); assert.equal(failed.complete, false); assert.equal(failed.channels[0].nextPage, 2);
    assert.equal(await page.locator('[data-tv-focus="search:video:1"]').count(), 1, "Sync errors retain old matches");
    await page.evaluate(async () => { window.__tvFixture.catalogMode = "normal"; await (await import("/src/tv/search/catalog.ts")).retryCatalog(window.__tvFixture.base, true); });
    await page.getByText(/目录同步完成/).waitFor();
    return { matches, checkpoint: status, repeatedPageStopped: true, maxPostConcurrency: await page.evaluate(() => window.__tvFixture.postMax) };
  });
  await scenario("post-qualification-retry-source-discard", async () => {
    const { page } = await open({ isolated: true });
    const result = await page.evaluate(async () => {
      const { qualifyVisiblePosts } = await import("/src/tv/postEligibility.ts");
      const items = window.__tvFixture.posts.map(post => ({ ...post, kind: "post" }));
      window.__tvFixture.failPostIds = [1];
      const first = await qualifyVisiblePosts(items, { source: window.__tvFixture.base, isCurrent: () => true, allowed: item => item.id !== 6 });
      window.__tvFixture.failPostIds = [];
      const retry = await qualifyVisiblePosts([items[0]], { source: window.__tvFixture.base, isCurrent: () => true, allowed: () => true }, true);
      let current = true;
      const pending = qualifyVisiblePosts(items, { source: window.__tvFixture.base, isCurrent: () => current, allowed: () => true }, true);
      current = false;
      const stale = await pending;
      return { first: { items: first.items.map(item => item.id), retryable: first.retryable }, retry: retry.items.map(item => item.id), stale: stale.items,
        calls: window.__tvFixture.calls.filter(call => call.command === "api_post_playback").map(call => call.args.id), max: window.__tvFixture.postMax };
    });
    assert.deepEqual(result.first, { items: [2, 3, 4, 5], retryable: 1 }); assert.deepEqual(result.retry, [1]); assert.deepEqual(result.stale, []);
    assert(!result.calls.includes(6), "Blocked tags must prevent even eligibility parsing"); assert(result.max <= 2);
    return result;
  });
  await scenario("library-atomic-migration", async () => {
    const { page } = await open({ isolated: true });
    return page.evaluate(async () => (await import("/tests/tv-library.ts")).runTvLibraryTests());
  });
  await scenario("playback-response-compatibility", async () => {
    const { page } = await open({ isolated: true });
    const result = await page.evaluate(async () => {
      const { playStreams } = await import("/src/tv/player/content.ts");
      const current = playStreams({ id: "7", ep: "2", streams: { main: "main.m3u8", hevc: "hevc.m3u8" } }, 7, "2");
      const legacy = playStreams({ id: 7, ep_num: 2, video_url: "legacy.m3u8" }, 7, "2");
      let wrongId = "", wrongPart = "", missingId = "", missingPart = "";
      try { playStreams({ id: "8", ep: 2, streams: { main: "wrong-id.m3u8" } }, 7, "2"); }
      catch (error) { wrongId = error instanceof Error ? error.message : String(error); }
      try { playStreams({ id: "7", ep: 3, streams: { main: "wrong-part.m3u8" } }, 7, "2"); }
      catch (error) { wrongPart = error instanceof Error ? error.message : String(error); }
      try { playStreams({ ep: 2, streams: { main: "missing-id.m3u8" } }, 7, "2"); }
      catch (error) { missingId = error instanceof Error ? error.message : String(error); }
      try { playStreams({ id: "7", streams: { main: "missing-part.m3u8" } }, 7, "2"); }
      catch (error) { missingPart = error instanceof Error ? error.message : String(error); }
      return { current, legacy, wrongId, wrongPart, missingId, missingPart };
    });
    assert.deepEqual(result.current, { main: "main.m3u8", hevc: "hevc.m3u8" });
    assert.deepEqual(result.legacy, { main: "legacy.m3u8", hevc: undefined });
    assert.equal(result.wrongId, "播放信息已变化，请重试当前剧集");
    assert.equal(result.wrongPart, "播放信息已变化，请重试当前剧集");
    assert.equal(result.missingId, "播放信息已变化，请重试当前剧集");
    assert.equal(result.missingPart, "播放信息已变化，请重试当前剧集");
    return result;
  });
  await scenario("legacy-metadata-autofill-home-library", async () => {
    const legacy = { favs: [1, 4], postFavs: [1], history: [
      { id: 1, ep: 2, t: 23, dur: 60, at: 300 },
      { id: 2, ep: 1, t: 12, dur: 60, at: 200 },
      { id: 3, ep: 2, t: 41, dur: 60, at: 100 },
    ] };
    const { page } = await open({ fixture: { legacy, detailDelay: 120 } });
    assert.equal(await page.evaluate(() => document.querySelector(".tv-page-scroll:not([hidden])")?.scrollTop), 0, "First page must open at its heading");
    await page.waitForFunction(() => {
      const shelf = document.querySelector('[data-tv-region="home-继续观看"]');
      return ["我的时间", "我的时间 第二季", "新的时间"].every((title, index) => {
        const card = shelf?.querySelector(`[data-tv-focus="video:${index + 1}"]`);
        return card?.querySelector("strong")?.textContent === title && !!card.querySelector("img");
      });
    });
    assert.equal(await page.locator(".tv-detail-route").count(), 0, "History metadata fills without opening detail");
    const before = await page.evaluate(async () => (await import("/src/tv/library.ts")).listLibrary());
    for (const item of legacy.history) {
      const row = before.find(row => row.key === `video:${item.id}`);
      assert(row?.progress, "History must still exist after hydration");
      assert.deepEqual({ part: row.progress.part, seconds: row.progress.seconds, duration: row.progress.duration, updatedAt: row.progress.updatedAt },
        { part: String(item.ep), seconds: item.t, duration: item.dur, updatedAt: item.at });
    }
    assert(before.find(row => row.key === "video:1")?.favorite);
    assert.equal((await calls(page, "api_video")).filter(call => call.args.id === 4).length, 0, "Unvisited library favorites are not eagerly requested");
    await screenshot(page, "legacy-history-hydrated-1280x720.png");
    await activate(page, "nav-library");
    await page.waitForFunction(() => {
      const grid = document.querySelector('[data-tv-region="library-grid"]');
      return grid?.querySelector('[data-tv-focus="video:4"] strong')?.textContent === "WDSJ"
        && grid?.querySelector('[data-tv-focus="post:1"] strong')?.textContent === "我的时间视频1";
    });
    assert.equal(await page.locator(".tv-detail-route").count(), 0);
    const after = await page.evaluate(async () => (await import("/src/tv/library.ts")).listLibrary());
    assert(after.find(row => row.key === "video:1")?.favorite && after.find(row => row.key === "post:1")?.favorite, "Same numeric video/post IDs hydrate independently");
    assert.equal((await calls(page, "api_video")).filter(call => call.args.id === 1).length, 1, "Resolved metadata is reused across home and library");
    assert.equal((await calls(page, "api_play")).length, 0, "Metadata hydration must not request video playback");
    assert.equal(await page.locator("video").count(), 0);
    const maximum = await page.evaluate(() => window.__tvFixture.detailMax);
    assert(maximum <= 2, "Visible library hydration must stay at two concurrent detail requests");
    await screenshot(page, "legacy-favorites-hydrated-1280x720.png");
    return { automaticTitles: true, preservedProgress: true, independentKinds: true, maxDetailConcurrency: maximum };
  });
  await scenario("legacy-metadata-tag-gate-retry", async () => {
    const { page } = await open({ fixture: {
      legacy: { favs: [], history: [{ id: 1, ep: 1, t: 5, dur: 60, at: 20 }, { id: 6, ep: 2, t: 18, dur: 60, at: 10 }] },
      contentPreferences: { blockedTags: ["都市"], paused: false, hideUntagged: true },
      detailDelay: 100, failDetailIds: [6],
    } });
    await page.waitForFunction(() => {
      const shelf = document.querySelector('[data-tv-region="home-继续观看"]');
      return shelf?.querySelector('[data-tv-focus="video:1"] strong')?.textContent === "已屏蔽的内容"
        && shelf?.querySelector('[data-tv-focus="video:6"]')?.textContent?.includes("信息加载失败");
    });
    const blocked = page.locator('[data-tv-region="home-继续观看"] [data-tv-focus="video:1"]');
    assert.equal(await blocked.locator("img").count(), 0, "Resolved blocked tags must never mount a cover");
    assert.equal((await calls(page, "api_video")).filter(call => call.args.id === 1).length, 1, "Unknown legacy tags must be resolved even when hideUntagged is enabled");
    await assertShelfWidths(page, "blocked and failed metadata");
    await page.evaluate(() => { window.__tvFixture.failDetailIds = []; });
    const retry = page.locator('[data-tv-region="home-继续观看"] [data-tv-focus="video:6"]');
    await retry.focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-tv-region="home-继续观看"] [data-tv-focus="video:6"] strong')?.textContent === "夜晚故事");
    assert.equal(await retry.locator("img").count(), 1);
    assert.equal(await page.locator(".tv-detail-route").count(), 0, "Confirm on failed metadata retries without entering detail");
    assert.equal(await activeKey(page), "video:6", "Metadata replacement preserves the focused card");
    assert.equal((await calls(page, "api_video")).filter(call => call.args.id === 6).length, 2, "Retry must request failed metadata exactly once");
    await assertShelfWidths(page, "metadata retry complete");
    return { unknownTagsHydrated: true, blockedCoverAbsent: true, retryByRemote: true, focusPreserved: true };
  });
  await scenario("player-remote-seek-last-part", async () => {
    const { page } = await open();
    await page.locator('[data-tv-region="home-推荐"] [data-tv-focus="video:1"]').waitFor();
    await page.locator('[data-tv-region="home-推荐"] [data-tv-focus="video:1"]').focus(); await page.keyboard.press("Enter");
    await activate(page, "detail:video:1:part:2");
    await page.waitForFunction(() => document.querySelector("video")?.currentTime > .1);
    await page.waitForFunction(() => document.querySelector(".tv-player-controls")?.hidden === true, null, { timeout: 10000 });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".tv-player-controls")?.hidden === false && document.activeElement?.getAttribute("data-tv-focus") === "player:play");
    await screenshot(page, "player-1280x720.png");
    assert.equal(await page.locator(".tv-player-hint, .tv-detail-eyebrow").count(), 0, "Player must not render decorative subtitle hints");
    assert.equal(await page.locator("video").evaluate(video => video.paused), false, "First confirm reveals without toggling");
    await page.keyboard.press("Enter"); await page.waitForFunction(() => document.querySelector("video")?.paused);
    await activate(page, "player:progress");
    const before = await page.locator("video").evaluate(video => video.currentTime);
    await page.keyboard.press("ArrowRight");
    assert(Math.abs(await page.locator("video").evaluate(video => video.currentTime) - before) < .5, "Seek preview must not commit");
    await page.keyboard.press("Escape"); assert.equal(await page.locator(".tv-player-seek-hint").count(), 0);
    await page.waitForTimeout(200);
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter");
    await page.waitForFunction(before => document.querySelector("video").currentTime >= before + 9, before);
    await page.locator("video").evaluate(video => { video.currentTime = video.duration - 1; });
    // Playwright's physical-key table omits some Android media keys; dispatch
    // the same DOM key the native remote emits through the real controller.
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "MediaPlay", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "MediaPlay", bubbles: true }));
    });
    await page.getByRole("dialog", { name: /播放完毕/ }).waitFor();
    assert.equal(await page.locator('[data-tv-focus="player:ended-next"]').count(), 0);
    assert((await calls(page, "api_play")).every(call => call.args.id === 1 && call.args.ep === 2));
    return { confirmTwoStages: true, previewCancelCommit: true, finalPartNoOtherWork: true };
  });
  await scenario("720p-1080p-4k-layout", async () => {
    const { page } = await open(); const measurements = [];
    await page.locator('[data-tv-region="home-推荐"] .tv-card').first().waitFor();
    for (const [width, height] of [[1280, 720], [1920, 1080], [3840, 2160]]) {
      await page.setViewportSize({ width, height });
      // resize 的 device-metrics/layout 提交完成后再聚焦：focus() 落在重建中的渲染 widget 上会静默失效
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const card = page.locator('[data-tv-region="home-推荐"] .tv-card').first(); await card.focus();
      if (await card.evaluate(el => el !== document.activeElement)) await card.focus();
      assert(await card.evaluate(el => el === document.activeElement), `${width}px: .tv-card 未获得焦点（outline 断言前置）`);
      const size = await card.evaluate(element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom,
        text: parseFloat(getComputedStyle(element.querySelector("strong")).fontSize), helper: parseFloat(getComputedStyle(element.querySelector("small")).fontSize), outline: getComputedStyle(element).outlineStyle }; });
      assert(size.text >= 18 * width / 960 - .1); assert(size.helper >= 16 * width / 960 - .1); assert.equal(size.outline, "solid");
      assert(size.x >= 0 && size.right <= width && size.y >= 0 && size.bottom <= height);
      const file = `home-${width}x${height}.png`; await page.screenshot({ path: join(output, file), animations: "disabled" }); report.screenshots.push(file); measurements.push({ width, height, ...size });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await activate(page, "nav-settings");
    await page.locator('[data-tv-focus="autoplay-next"]').waitFor();
    assert.equal(await page.locator(".tv-page-heading > :not(h1)").count(), 0, "Settings heading must contain only its title");
    await screenshot(page, "settings-1280x720.png");
    return measurements;
  });
  await scenario("pin-lock-gate-and-settings", async () => {
    const { page } = await open();
    await page.locator('[data-tv-region="home-推荐"] .tv-card').first().waitFor();
    assert.equal(await page.locator('[data-tv-modal="tv-pin-gate"]').count(), 0);
    await activate(page, "nav-settings");
    await activate(page, "settings-启动密码");
    const toggle = page.locator('[data-tv-focus="pin-toggle"]');
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await activate(page, "pin-toggle");
    await page.locator('[data-tv-modal="settings-pin"]').waitFor();
    for (const d of ["1", "2", "3", "4"]) await activate(page, `pin-modal-key-${d}`);
    for (const d of ["9", "9", "9", "9"]) await activate(page, `pin-modal-key-${d}`);
    await page.getByText("两次输入的密码不一致，请重新设置").waitFor();
    for (const d of ["2", "5", "8", "0"]) await activate(page, `pin-modal-key-${d}`);
    for (const d of ["2", "5", "8", "0"]) await page.keyboard.press(d);
    await page.locator('[data-tv-modal="settings-pin"]').waitFor({ state: "detached" });
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    const stored = JSON.parse(await page.evaluate(() => localStorage.getItem("hghubx_tv_pin_v1")));
    assert.deepEqual(Object.keys(stored).sort(), ["enabled", "hash", "salt", "version"]);
    assert.equal(stored.enabled, true);
    assert.match(stored.salt, /^[0-9a-f]{32}$/);
    assert.match(stored.hash, /^[0-9a-f]{64}$/);

    await page.reload();
    await page.locator(".hg-launch").waitFor({ state: "detached" });
    const gate = page.locator('[data-tv-modal="tv-pin-gate"]');
    await gate.waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-tv-focus="nav-home"]').count(), 0, "App shell must not mount before PIN unlock");
    assert.equal((await calls(page, "app_boot")).length, 0, "app_boot must not run while locked behind PIN gate");
    for (const [w, h] of [[1280, 720], [1920, 1080], [3840, 2160]]) {
      await page.setViewportSize({ width: w, height: h });
      const box = await page.locator(".tv-pin-card").boundingBox();
      assert(box.y >= 0 && box.y + box.height <= h, `PIN card must fit vertically inside ${w}x${h}`);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await screenshot(page, "pin-gate-1280x720.png");

    await page.keyboard.press("2");
    await page.keyboard.press("5");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__tvFixture.exits), 0);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__tvFixture.exits), 0);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.__tvFixture.exits === 1);

    for (const d of ["0", "0", "0", "0"]) await page.keyboard.press(d);
    await page.getByText("PIN 码错误，请重新输入").waitFor();
    for (const d of ["2", "5", "8", "0"]) await activate(page, `pin-gate-key-${d}`);
    await page.locator('[data-tv-region="home-推荐"] .tv-card').first().waitFor();
    assert.equal(await gate.count(), 0);

    await activate(page, "nav-settings");
    await activate(page, "settings-启动密码");
    await activate(page, "pin-lock-now");
    await gate.waitFor({ state: "visible" });
    for (const d of ["2", "5", "8", "0"]) await page.keyboard.press(d);
    await page.locator('[data-tv-region="home-推荐"] .tv-card').first().waitFor();
    await activate(page, "nav-settings");
    await activate(page, "settings-启动密码");
    await activate(page, "pin-change");
    const pinModal = page.locator('[data-tv-modal="settings-pin"]');
    await pinModal.getByText("请输入当前 4 位 PIN 码", { exact: true }).waitFor();
    for (const d of ["2", "5", "8", "0", "1", "3", "5", "7", "1", "3", "5", "7"]) await page.keyboard.press(d);
    await page.getByText("启动密码已更新").waitFor();
    await pinModal.waitFor({ state: "detached" });
    await activate(page, "pin-toggle");
    await pinModal.getByText("请输入当前 4 位 PIN 码以关闭启动密码", { exact: true }).waitFor();
    for (const d of ["2", "5", "8", "0"]) await page.keyboard.press(d);
    await page.getByText("PIN 码错误，请重试").waitFor();
    for (const d of ["1", "3", "5", "7"]) await page.keyboard.press(d);
    await page.getByText("启动密码已关闭").waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await page.reload();
    await page.locator('[data-tv-region="home-推荐"] .tv-card').first().waitFor();
    assert.equal(await gate.count(), 0);
    return { hashedStorage: true, coldBootGated: true, remoteDigitsAndKeypad: true, changeAndDisable: true };
  });
  await scenario("standard-build-excludes-tv-resources", async () => {
    await vite.close(); vite = undefined;
    process.env.VITE_APP_EDITION = "standard";
    const modules = new Set();
    const result = await build({ root, logLevel: "warn", plugins: [{ name: "capture-standard-module-graph", generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) if (file.type === "chunk") for (const id of Object.keys(file.modules)) modules.add(id);
    } }], build: { write: false } });
    const forbidden = [...modules].filter(id => /\/src\/tv\/|\/pinyin-pro\//.test(id));
    assert.deepEqual(forbidden, [], "Standard app bundle must not contain TV modules or pinyin-pro");
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output || []);
    const css = outputs.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
    assert(!css.includes(".tv-search-keyboard") && !css.includes(".tv-pin-gate"));
    return { modules: modules.size, forbidden, emitted: outputs.map(item => item.fileName) };
  });
  for (const context of contexts) for (const page of context.pages()) {
    assert.deepEqual(await page.evaluate(() => window.__tvFixture?.unknown || []), [], "Unexpected mock IPC is a hard failure");
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  for (const [index, context] of contexts.entries()) { await context.tracing.stop({ path: join(output, `trace-${index}.zip`) }).catch(() => {}); await context.close(); }
  await browser?.close(); await vite?.close();
  if (mediaDirectory) await rm(mediaDirectory, { recursive: true, force: true });
  if (savedEdition === undefined) delete process.env.VITE_APP_EDITION; else process.env.VITE_APP_EDITION = savedEdition;
  report.passed = report.cases.filter(item => item.status === "passed").length;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`TV remote acceptance: ${report.passed}/${report.cases.length} scenarios. Artifacts: ${output}`);
}
