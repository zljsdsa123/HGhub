// Local-only headless playback checks. No upstream APIs, credentials or Tauri IPC are used.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptScenarios = {
  tv: { script: "test-tv-remote.mjs", timeout: 480000, metrics: { transport: "mock Tauri IPC; actual TV bootstrap, worker, library and player" } },
  "post-flicker": { script: "test-post-flicker.mjs", timeout: 240000, metrics: { transport: "mock Tauri IPC; real PostDetail/AppProvider/Player; local HLS fixture" } },
};
const ALL_SCENARIOS = ["seek", "legacy", "lifecycle", "gesture", "proxy", "portrait-fit", "ios-native", "recovery", "review", "tv", "post-flicker"];
const { values: args } = parseArgs({ options: {
  "media-dir": { type: "string" }, output: { type: "string" }, "browser-executable": { type: "string" },
  scenarios: { type: "string", default: "seek,legacy,lifecycle,gesture,proxy,portrait-fit" }, help: { type: "boolean" },
} });
if (args.help) {
  console.log(`pnpm test:playback [--media-dir DIR] [--output NEW_DIR] [--browser-executable PATH] [--scenarios all|${ALL_SCENARIOS.join(",")}]`);
  process.exit(0);
}
const scenarios = args.scenarios === "all" ? ALL_SCENARIOS : args.scenarios.split(",");
assert(scenarios.length && scenarios.every(s => ALL_SCENARIOS.includes(s)), "Unknown scenario");
const output = resolve(args.output || join(root, "test-results", "playback", new Date().toISOString().replace(/[:.]/g, "-")));
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Refuse to overwrite artifacts from an earlier run.
const jsonl = (file, entry) => appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
const report = { started: new Date().toISOString(), platform: process.platform, browser: "chromium", transport: "browser fixture; not Tauri/WKWebView", output, cases: [] };
let temporaryMedia, temporaryPortraitMedia, vite, media, portraitMedia, browser;
let nextRequest = 0;
const requests = new Set();
// hls.js 的 worker/XHR 会直接请求 Linux 本机媒体代理；测试里统一映射到临时 fixture server。
const fixtureMediaOrigins = new Set(["http://127.0.0.1:17650", "http://hg.localhost"]);
const fixtureMediaUrl = raw => {
  const url = new URL(raw);
  return fixtureMediaOrigins.has(url.origin) ? new URL(`${url.pathname}${url.search}`, report.media).href : raw;
};

async function serveMedia(dir) {
  const manifest = await readFile(join(dir, "list.m3u8"), "utf8");
  assert(manifest.startsWith("#EXTM3U") && manifest.includes("#EXT-X-ENDLIST"), "Expected a local VOD HLS fixture");
  const server = createHttpServer(async (req, res) => {
    const started = performance.now(), request = ++nextRequest;
    const url = new URL(req.url, "http://localhost");
    let status = 200, bytes = 0, fragment;
    res.on("close", () => jsonl(join(output, "media-server.jsonl"), { request, route: url.pathname, fragment, status, bytes, elapsed_ms: Math.round(performance.now() - started), aborted: !res.writableFinished }));
    try {
      let body, kind;
      if (url.pathname === "/hls") {
        body = Buffer.from(manifest.split("\n").map(line => !line || line.startsWith("#") ? line :
          `http://hg.localhost/seg?u=${encodeURIComponent(`https://media.fixture.invalid/${line.trim()}`)}`).join("\n"));
        kind = "application/vnd.apple.mpegurl";
      } else if (url.pathname === "/seg") {
        fragment = basename(new URL(url.searchParams.get("u")).pathname);
        assert(/^seg\d+\.ts$/.test(fragment), "Unexpected fixture segment");
        await new Promise(done => setTimeout(done, 120));
        body = await readFile(join(dir, fragment)); kind = "video/mp2t";
      } else { status = 404; body = Buffer.from("not found"); kind = "text/plain"; }
      bytes = body.length;
      res.writeHead(status, { "Content-Type": kind, "Content-Length": bytes, "Access-Control-Allow-Origin": "*" });
      res.end(body);
    } catch {
      status = 404; res.writeHead(status); res.end("fixture error");
    }
  });
  server.on("connection", socket => { requests.add(socket); socket.on("close", () => requests.delete(socket)); });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return server;
}

const getLogs = page => page.evaluate(async () => { await window.playerSeekFixture.flushLogs(); return window.playerSeekFixture.logs; });
// 本地 VOD HLS fixture：testsrc2 + 正弦音轨。size 决定横屏（320x180）或竖屏（360x640）源。
const generateHlsFixture = (dir, size) => execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=15`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "90", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_filename", join(dir, "seg%03d.ts"), join(dir, "list.m3u8")], { timeout: 60000, stdio: "pipe" });
async function waitLog(page, event, source) {
  await page.waitForFunction(({ event, source }) => window.playerSeekFixture.logs.some(e => e.event === event && (!source || e.data.source === source)), { event, source });
  return getLogs(page);
}
async function clickProgress(page, fraction) {
  const input = page.getByRole("slider", { name: "播放进度" });
  await input.scrollIntoViewIfNeeded();
  const r = await input.boundingBox(); assert(r, "Seekbar missing");
  await page.mouse.click(r.x + r.width * fraction, r.y + r.height / 2);
}
async function loadPlayer(page, legacy = false, extra = "") {
  await page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&proxy=${encodeURIComponent(report.media)}${legacy ? "&legacy=1" : ""}${extra}`);
  await page.waitForFunction(() => document.querySelector("video")?.currentTime > 1);
}
async function speedMenuKeyboardChecks(page, paused) {
  const trigger = page.getByRole("button", { name: "倍速", exact: true });
  const menu = page.getByRole("menu", { name: "播放速度", exact: true });
  const assertFocus = async selector => {
    await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), selector);
  };
  const assertMediaState = async () => {
    assert.equal(await page.locator("video").evaluate(video => video.paused), paused, "Menu keys must preserve playback pause state");
  };
  const open = async key => {
    await trigger.focus();
    await page.keyboard.press(key);
    await menu.waitFor({ state: "visible" });
    await assertFocus('.player-speed-menu [aria-checked="true"]');
    await assertMediaState();
  };
  const assertSelection = async rate => {
    await page.waitForFunction(rate => document.querySelector("video").playbackRate === rate, rate);
    await menu.waitFor({ state: "detached" });
    await assertFocus(".player-speed");
    await assertMediaState();
  };

  // These keys reach the real Feed, so leaking Space would toggle the video.
  await open("Space");
  await page.keyboard.press("Home");
  await assertFocus('.player-speed-menu button:first-of-type');
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.locator(":focus").innerText(), "0.75x");
  await page.keyboard.press("End");
  await assertFocus('.player-speed-menu button:last-of-type');
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.locator(":focus").innerText(), "1.5x");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await assertSelection(2);

  await open("Enter");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await assertSelection(.75);

  await open("Space");
  await page.keyboard.press("Escape");
  await assertSelection(.75);

  await open("Enter");
  await page.keyboard.press("Tab");
  await menu.waitFor({ state: "detached" });
  await assertFocus(".player-volume > button");
  await assertMediaState();

  // Restore normal speed without mouse activation and preserve a useful focus.
  await open("Space");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await assertSelection(1);
}
async function gestureChecks(page) {
  await page.addInitScript(() => {
    const { promise, resolve } = Promise.withResolvers();
    window.__playGate = promise;
    window.__releasePlay = resolve;
  });
  await page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&swipe-ep=1&proxy=${encodeURIComponent(report.media)}`);
  const guide = page.getByRole("dialog", { name: "视频长按操作提示", exact: true });
  await guide.waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("video")?.paused);
  await guide.getByRole("button", { name: "知道了", exact: true }).click();
  await guide.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector("video")?.currentTime > 1 && !document.querySelector("video").paused);
  const video = page.locator('video');
  const tap = () => page.evaluate(() => {
    const surface = document.querySelector('video').parentElement.parentElement;
    const bounds = surface.getBoundingClientRect();
    for (const type of ['pointerdown','pointerup']) surface.dispatchEvent(new PointerEvent(type, {
      bubbles:true, pointerId:91, pointerType:'touch', button:0, clientX:bounds.x+100, clientY:bounds.y+100,
    }));
  });
  const clean = () => page.locator('.player-root').getAttribute('data-clean');
  const start = Date.now();
  await tap();
  await page.waitForFunction(() => document.querySelector('.player-root')?.dataset.clean === 'true');
  const singleTapMs = Date.now()-start;
  assert(singleTapMs < 230, 'First tap must update before the old double-tap waiting window');
  await page.waitForTimeout(250);
  await tap();
  await page.waitForFunction(() => document.querySelector('.player-root')?.dataset.clean === 'false');
  await page.waitForTimeout(250);
  const wasPaused = await video.evaluate(v=>v.paused);
  await tap(); await tap();
  await page.waitForFunction(paused => document.querySelector('video').paused !== paused, wasPaused);
  assert.equal(await clean(), 'false', 'Double tap restores chrome and toggles playback once');
  await page.evaluate(() => {
    const surface = document.querySelector('video').parentElement.parentElement;
    const bounds = surface.getBoundingClientRect();
    surface.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 92, pointerType: 'touch', button: 0, clientX: bounds.x + 80, clientY: bounds.y + 220 }));
    surface.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 92, pointerType: 'touch', button: 0, clientX: bounds.x + 220, clientY: bounds.y + 220 }));
  });
  await page.waitForFunction(() => document.querySelector('[data-seek-bar]')?.dataset.scrubbing === 'true');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.player-root *')].some(el => {
    const r = el.getBoundingClientRect();
    return r.top > 120 && r.bottom < 380 && el.textContent?.includes('/ 1:30');
  })), false, 'Horizontal gesture scrub must only highlight the bottom progress bar without a center-screen bar');
  await page.evaluate(() => {
    const surface = document.querySelector('video').parentElement.parentElement;
    const bounds = surface.getBoundingClientRect();
    surface.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 92, pointerType: 'touch', button: 0, clientX: bounds.x + 220, clientY: bounds.y + 220 }));
  });
  await page.waitForFunction(() => !document.querySelector('[data-seek-bar]')?.dataset.scrubbing);
  // 2.2.0 反馈回归：切集过渡期（下一集地址未解析）手势 overlay 必须常驻。
  // 修复前第二划落在卸载后的封面/滚动列表上被丢弃或切到别的视频；修复后集数连加且视频不变。
  await page.evaluate(() => window.playerSeekFixture.setLogging(true));
  const swipeUp = () => page.evaluate(() => {
    const surface = document.querySelector('[data-mobile-hold-target]') || document.querySelector('.player-root section');
    const b = surface.getBoundingClientRect();
    const x = b.x + b.width / 2, y0 = b.y + b.height * .7, y1 = b.y + b.height * .3;
    const at = y => ({ bubbles: true, pointerId: 92, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y });
    surface.dispatchEvent(new PointerEvent('pointerdown', at(y0)));
    surface.dispatchEvent(new PointerEvent('pointermove', at(y1)));
    surface.dispatchEvent(new PointerEvent('pointerup', { ...at(y1), buttons: 0 }));
  });
  await swipeUp();
  await page.locator('.mobile-video-episode').filter({ hasText: /^第2集$/ }).first().waitFor();
  await swipeUp();
  await page.locator('.mobile-video-episode').filter({ hasText: /^第3集$/ }).first().waitFor();
  await page.evaluate(() => window.__releasePlay());
  await page.waitForFunction(() => window.playerSeekFixture.logs.some(e => e.event === 'play.resolve' && e.data.video_id === 991 && e.data.episode === 3));
  assert.equal(await page.evaluate(() => window.playerSeekFixture.logs.some(e => e.event === 'play.resolve' && e.data.video_id === 992)), false,
    'Fast episode swipes must stay on the same video');
  return { singleTapMs, bottomOnlyScrub: true, fastSwipeEpisodes: [2, 3], sameVideo: true };
}

// issue #142 回归：手机竖屏视口 + 真实竖屏源（360x640，高>宽）。
// fit 判定只认解码后的 videoWidth/videoHeight（VideoSurface onSize → Feed vsize），
// 所以必须等真实元数据落地后再断言 computed object-fit：
//   修复前：landscapeVideo=false 且已测量、非全屏、vpLandscape=false → "cover"（裁切铺满）→ 断言失败；
//   修复后：竖屏视频一律 "contain"（保留原始比例）→ 断言通过。
// 第二段用横屏源验证「铺满/适应」切换链路未被修复破坏（该分支修复前后行为一致）。
async function portraitFitChecks(page) {
  const open = proxy => page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&portrait-fit=1&proxy=${encodeURIComponent(proxy)}`);
  // onSize 是原生媒体事件里的 React 更新；双 rAF 保证 setVsize 已提交到 DOM（帧同步，非任意 sleep）。
  const afterCommit = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(undefined)))));
  const objectFit = () => page.locator("video").evaluate(v => getComputedStyle(v).objectFit);

  await open(report.portraitMedia);
  const guide = page.getByRole("dialog", { name: "视频长按操作提示", exact: true });
  await guide.waitFor({ state: "visible" });
  await guide.getByRole("button", { name: "知道了", exact: true }).click();
  await guide.waitFor({ state: "hidden" });
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.videoWidth === 360 && v.videoHeight === 640 && v.currentTime > 1 && !v.paused;
  });
  await afterCommit();
  const portrait = await page.locator("video").evaluate(v => ({
    objectFit: getComputedStyle(v).objectFit, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
  }));
  assert(portrait.videoHeight > portrait.videoWidth, "Fixture must decode a portrait source (h > w) to reach the portrait branch");
  assert.equal(portrait.objectFit, "contain", "Portrait video must keep its original aspect ratio (issue #142), not crop with object-cover");
  // 「铺满」按钮只在 landscapeVideo=true 时渲染；它不存在证明确实走了竖屏分支。
  assert.equal(await page.getByRole("button", { name: "铺满", exact: true }).count(), 0, "Portrait source must not offer the landscape fill toggle");

  // 同一手机竖屏视口换横屏源（320x180）：默认 contain，铺满→cover，适应→contain。
  await open(report.media);
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.videoWidth === 320 && v.videoHeight === 180 && v.currentTime > 1 && !v.paused;
  });
  await afterCommit();
  assert.equal(await objectFit(), "contain", "Landscape video in a portrait viewport must default to contain");
  await page.getByRole("button", { name: "铺满", exact: true }).click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector("video")).objectFit === "cover");
  await page.getByRole("button", { name: "适应", exact: true }).click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector("video")).objectFit === "contain");
  return { viewport: "390x844", portrait_source: "360x640", portrait_object_fit: portrait.objectFit,
    landscape_default_fit: "contain", landscape_toggle: ["contain", "cover", "contain"] };
}

async function seekChecks(page, legacy) {
  await loadPlayer(page, legacy);
  await clickProgress(page, .1);
  assert.equal((await getLogs(page)).length, 0, "Default-off must not record seeks");
  await page.getByRole("button", { name: "诊断设置", exact: true }).click();
  const diagnostics = page.getByRole("button", { name: "播放诊断设置", exact: true });
  assert.equal(await diagnostics.getAttribute("aria-expanded"), "false");
  await diagnostics.click();
  assert.equal(await diagnostics.getAttribute("aria-expanded"), "true");
  await page.getByRole("switch", { name: "播放诊断日志", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="播放诊断日志"]').getAttribute("aria-checked") === "true");
  await page.getByRole("button", { name: "诊断设置", exact: true }).click();
  await clickProgress(page, .8);
  let logs = await waitLog(page, "seek.resumed");
  const first = logs.find(e => e.event === "seek.request" && e.data.source === `${legacy ? "legacy" : "desktop"}_click`);
  assert(first, "Actual click must request a seek");
  for (const event of ["seek.input.down", "seek.input.change", "seek.input.up", "seek.assigned", "media.seeking", "media.seeked"]) assert(logs.some(e => e.event === event), event);
  assert(logs.some(e => e.event === "seek.resumed" && e.data.seek === first.data.seek), "Click must recover a frame with matching seek ID");

  const before = logs.length;
  const r = await page.getByRole("slider", { name: "播放进度" }).boundingBox();
  const current = await page.locator("video").evaluate(v => v.currentTime / v.duration);
  await page.mouse.move(r.x + r.width * current, r.y + r.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(r.x + r.width * (current + (.45 - current) * i / 12), r.y + r.height / 2);
    await page.waitForTimeout(30);
  }
  const duringDrag = (await getLogs(page)).slice(before);
  assert.equal(duringDrag.filter(e => e.event === "seek.request").length, 0, "Pointer movement must only preview, without seeking");
  assert(duringDrag.filter(e => e.event === "seek.input.change" && e.data.input === "drag").length > 1, "Drag must keep logging preview positions");
  const preview = await page.getByRole("slider", { name: "播放进度" }).inputValue();
  assert(Math.abs(Number(preview) - 40.5) < .5, "Seekbar must preview the target before release");
  await page.mouse.up();
  await page.waitForFunction(n => window.playerSeekFixture.logs.slice(n).some(e => e.event === "seek.resumed"), before);
  logs = (await getLogs(page)).slice(before);
  const drags = logs.filter(e => e.event === "seek.request" && e.data.source === `${legacy ? "legacy" : "desktop"}_drag`);
  assert.equal(drags.length, 1, "A whole drag must commit exactly one seek on release");
  const last = drags.at(-1);
  assert(logs.some(e => e.event === "seek.input.up" && e.data.input === "drag"));
  assert(logs.some(e => e.event === "seek.resumed" && e.data.seek === last.data.seek), "Final drag target must recover a frame");
  const fragments = (await getLogs(page)).filter(e => e.event === "hlsFragLoading" || e.event === "hlsFragLoaded");
  assert(fragments.some(e => e.event === "hlsFragLoading" && e.data.load_ms === null), "Incomplete downloads must have unknown duration");
  for (const { data } of fragments) {
    for (const key of ["load_ms", "first_byte_ms"]) {
      assert(data[key] === null || data[key] >= 0, "Fragment timings must never be negative");
    }
  }

  if (!legacy) await speedMenuKeyboardChecks(page, false);

  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await clickProgress(page, .6);
  logs = await waitLog(page, "seek.ready");
  assert(await page.locator("video").evaluate(v => v.paused), "Paused seek must stay paused");
  const keyboardBefore = logs.length;
  await page.getByRole("slider", { name: "播放进度" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(n => window.playerSeekFixture.logs.slice(n).some(e => e.event === "seek.ready"), keyboardBefore);
  assert((await getLogs(page)).slice(keyboardBefore).some(e => e.event === "seek.request" && e.data.source.endsWith("_keyboard")), "Native keyboard seek must still work");
  assert(await page.locator("video").evaluate(v => v.paused), "Keyboard seek must preserve pause");
  if (!legacy) await speedMenuKeyboardChecks(page, true);

  // Page changes during capture must cancel the preview rather than seek the hidden player.
  const cancelledBefore = (await getLogs(page)).length;
  const cancelBox = await page.getByRole("slider", { name: "播放进度" }).boundingBox();
  await page.mouse.move(cancelBox.x + cancelBox.width * .3, cancelBox.y + cancelBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelBox.x + cancelBox.width * .7, cancelBox.y + cancelBox.height / 2);
  await page.evaluate(() => window.playerSeekFixture.setActive(false));
  await page.waitForFunction(() => document.querySelector('input[aria-label="播放进度"]').disabled);
  await page.mouse.up();
  const cancelled = (await getLogs(page)).slice(cancelledBefore);
  assert(cancelled.some(e => e.event === "seek.input.cancel"), "Deactivation must cancel the drag");
  assert(!cancelled.some(e => e.event === "seek.request"), "Cancelled drag must not commit a seek");
  await page.evaluate(() => window.playerSeekFixture.setActive(true));
  await page.waitForFunction(() => !document.querySelector('input[aria-label="播放进度"]').disabled);
  assert(await page.locator("video").evaluate(v => v.paused), "Returning must preserve manual pause");
  await page.evaluate(() => window.playerSeekFixture.setLogging(false));
  const count = (await getLogs(page)).length;
  await clickProgress(page, .2); await page.waitForTimeout(350);
  assert.equal((await getLogs(page)).length, count, "Disabled logging must stop recording");
  await page.evaluate(() => { window.playerSeekFixture.rejectLoggingSave = true; });
  const rejected = await page.evaluate(() => window.playerSeekFixture.setLogging(true).then(() => false, () => true));
  assert(rejected, "Failed persistence must reject");
  await clickProgress(page, .3);
  assert.equal((await getLogs(page)).length, count, "Failed persistence must keep logging disabled");
  return { click_ms: logs.find(e => e.event === "seek.resumed" && e.data.seek === first.data.seek)?.data.elapsed_ms, drag_requests: drags.length,
    ...(!legacy ? { speed_menu_keyboard: { playing_preserved: true, paused_preserved: true, activation: ["Space", "Enter"], navigation: ["ArrowUp", "ArrowDown", "Home", "End"], exit: ["Escape", "Tab"], focus_restored: true } } : {}) };
}
async function lifecyclePlayerCheck(page, legacy) {
  let release, held, holdDeadline;
  const gate = new Promise(done => { release = done; });
  const manifestHeld = new Promise(done => { held = done; });
  await page.route("**/hls?*", async route => {
    const response = await route.fetch({ url: fixtureMediaUrl(route.request().url()) }); held(); await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&proxy=${encodeURIComponent(report.media)}${legacy ? "&legacy=1" : ""}`);
    await page.waitForFunction(() => window.playerSeekFixture && document.querySelector("video"));
    await Promise.race([manifestHeld, new Promise((_, reject) => { holdDeadline = setTimeout(() => reject(new Error("Manifest interception timed out")), 15000); })]);
    clearTimeout(holdDeadline);
    await page.evaluate(async () => { await window.playerSeekFixture.setLogging(true); window.playerSeekFixture.setActive(false); });
    await page.waitForFunction(() => document.querySelector('input[aria-label="播放进度"]').disabled);
    release();
    await page.waitForFunction(() => window.playerSeekFixture.engineState().levels > 0);
    await page.waitForTimeout(350);
    const state = await page.locator("video").evaluate(v => ({ time: v.currentTime, paused: v.paused, ready: v.readyState }));
    const logs = await getLogs(page);
    assert(state.paused, `BACKGROUND_AUTOPLAY: inactive page resumed after manifest returned (${JSON.stringify(state)})`);
    assert.equal(await page.evaluate(() => window.playerSeekFixture.engineState().loading), false, "Inactive player must not load fragments");
    assert(!logs.some(e => e.event === "play.request" && e.data.active === false), "Autoplay must be gated before calling play()");
    assert(!logs.some(e => e.event === "hlsFragLoading"), "Hidden manifest must not start fragment loading");
    await page.evaluate(() => window.playerSeekFixture.setActive(true));
    await page.waitForFunction(() => document.querySelector("video").currentTime > 1 && !document.querySelector("video").paused);
    await page.locator(legacy ? ".post-player" : ".player-root").hover();
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await page.evaluate(() => window.playerSeekFixture.setActive(false));
    await page.waitForFunction(() => !window.playerSeekFixture.engineState().loading);
    await page.evaluate(() => window.playerSeekFixture.setActive(true));
    await page.waitForFunction(() => !document.querySelector('input[aria-label="播放进度"]').disabled);
    assert(await page.locator("video").evaluate(v => v.paused), "Manual pause must survive page reactivation");
    await page.getByRole("button", { name: "播放", exact: true }).first().click();
    await page.waitForFunction(() => !document.querySelector("video").paused);
    await page.locator("video").evaluate(v => v.pause());
    await page.evaluate(() => window.playerSeekFixture.setActive(false));
    await page.waitForFunction(() => !window.playerSeekFixture.engineState().loading);
    await page.evaluate(() => window.playerSeekFixture.setActive(true));
    await page.waitForFunction(() => !document.querySelector('input[aria-label="播放进度"]').disabled);
    assert(await page.locator("video").evaluate(v => v.paused), "Native/PiP pause must survive page reactivation");
    return { inactive_paused: state.paused, inactive_fragment_loading: false, manual_pause_preserved: true, native_pause_preserved: true };
  } finally { clearTimeout(holdDeadline); release(); await page.unroute("**/hls?*"); }
}
async function lifecycleCheck(page) {
  const feed = await lifecyclePlayerCheck(page, false);
  const legacy = await lifecyclePlayerCheck(page, true);
  const lateMount = [];
  for (const legacy of [false, true]) {
    // Feed intentionally defers its play API while inactive. Mount each real
    // player with a known source only after the parent has become inactive.
    await page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&delayed-mount=1&proxy=${encodeURIComponent(report.media)}${legacy ? "&legacy=1" : ""}`);
    await page.locator('[data-player-fixture][data-active="true"]').waitFor();
    await page.evaluate(async () => { await window.playerSeekFixture.setLogging(true); window.playerSeekFixture.setActive(false); });
    await page.locator('[data-player-fixture][data-active="false"]').waitFor();
    assert.equal(await page.locator("video").count(), 0, "Parent must become inactive before the player mounts");
    await page.evaluate(() => window.playerSeekFixture.setMounted(true));
    const logs = await waitLog(page, "hls.manifest");
    assert(await page.locator("video").evaluate(v => v.paused), "Late-mounted inactive player must not autoplay");
    assert.equal(await page.evaluate(() => window.playerSeekFixture.engineState().loading), false, "Late-mounted inactive player must not load fragments");
    assert(!logs.some(e => e.event === "play.request"), "Late-mounted autoplay must be gated before calling play()");
    assert(!logs.some(e => e.event === "hlsFragLoading"), "Late-mounted inactive player must not request fragments");
    await page.evaluate(() => window.playerSeekFixture.setActive(true));
    await page.waitForFunction(() => document.querySelector("video").currentTime > 1 && !document.querySelector("video").paused);
    lateMount.push({ player: legacy ? "legacy" : "video_surface", inactive_paused: true, inactive_fragment_loading: false, activated_playback: true });
  }
  return { feed, legacy, late_mount_paused: true, late_mount: lateMount };
}

async function proxyRecoveryCheck(page) {
  const players = [];
  for (const legacy of [false, true]) {
    let broken = true, release, held;
    const gate = new Promise(done => { release = done; });
    const intercepted = new Promise(done => { held = done; });
    await page.route("**/hls?*", async route => {
      if (broken) {
        held(); await gate;
        return route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "manifest unavailable" });
      }
      const response = await route.fetch({ url: fixtureMediaUrl(route.request().url()) });
      return route.fulfill({ response });
    });
    try {
      await page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&proxy=${encodeURIComponent(report.media)}${legacy ? "&legacy=1" : ""}`);
      await page.waitForFunction(() => window.playerSeekFixture && document.querySelector("video"));
      await intercepted;
      await page.evaluate(() => window.playerSeekFixture.setLogging(true));
      release();
      await page.waitForFunction(() => window.playerSeekFixture.logs.some(e => e.event === "hls.error" && e.data.detail === "manifestLoadError" && e.data.fatal));
      assert.equal(await page.locator("video").evaluate(v => v.currentTime), 0, "Fault must prevent initial playback");
      broken = false;
      await page.evaluate(() => window.dispatchEvent(new Event("hg:proxy-changed")));
      await page.waitForFunction(() => document.querySelector("video").currentTime > 1 && !document.querySelector("video").paused);

      // A subsequent proxy change must retain the same DOM video, current episode,
      // playback position and the user's paused state.
      await page.locator("video").evaluate(v => { v.pause(); v.currentTime = 20; window.__proxyVideo = v; });
      await page.waitForFunction(() => !document.querySelector("video").seeking && document.querySelector("video").readyState >= 2);
      const before = (await getLogs(page)).filter(e => e.event === "proxy.restored").length;
      await page.evaluate(() => window.dispatchEvent(new Event("hg:proxy-changed")));
      await page.waitForFunction(before => window.playerSeekFixture.logs.filter(e => e.event === "proxy.restored").length > before, before);
      await page.waitForFunction(() => document.querySelector("video").readyState >= 2);
      const paused = await page.locator("video").evaluate(v => ({ paused: v.paused, time: v.currentTime, sameElement: v === window.__proxyVideo }));
      assert(paused.paused && Math.abs(paused.time - 20) < 0.5 && paused.sameElement, `Pause/position must survive: ${JSON.stringify(paused)}`);

      // Hidden pages reload metadata but must not start playing until reactivated.
      await page.evaluate(() => window.playerSeekFixture.setActive(false));
      await page.evaluate(() => window.dispatchEvent(new Event("hg:proxy-changed")));
      await page.waitForFunction(() => window.playerSeekFixture.engineState().levels > 0);
      assert(await page.locator("video").evaluate(v => v.paused), "Hidden retry must stay paused");
      await page.evaluate(() => window.playerSeekFixture.setActive(true));
      await page.waitForFunction(() => document.querySelector("video").readyState >= 2);
      assert(await page.locator("video").evaluate(v => v.paused), "Reactivation must retain manual pause");
      await page.getByRole("button", { name: "播放", exact: true }).first().click();
      await page.waitForFunction(() => !document.querySelector("video").paused && document.querySelector("video").currentTime > 20);
      const playingAt = await page.locator("video").evaluate(v => v.currentTime);
      const playingRetries = (await getLogs(page)).filter(e => e.event === "proxy.restored").length;
      await page.evaluate(() => window.dispatchEvent(new Event("hg:proxy-changed")));
      await page.waitForFunction(before => window.playerSeekFixture.logs.filter(e => e.event === "proxy.restored").length > before, playingRetries);
      await page.waitForFunction(time => !document.querySelector("video").paused && document.querySelector("video").currentTime >= time, playingAt);
      if (!legacy) {
        await page.evaluate(() => window.dispatchEvent(new Event("hg:line-changed")));
        assert.equal(await page.locator(".spinner").count(), 0, "Background line switch must not leave a stuck loading spinner on a healthy playing stream");
        assert(!(await page.locator("video").evaluate(v => v.paused)), "Background line switch must keep healthy stream playing");
      }
      const logs = await getLogs(page);
      const current = logs.filter(e => e.data.video_id).map(e => e.data.video_id);
      assert(current.every(id => id === 991), "Proxy save must retain current video");
      players.push({ player: legacy ? "legacy" : "feed", fatal_manifest_recovered: true, paused_time: paused.time,
        same_video_element: paused.sameElement, hidden_stayed_paused: true, playing_resumed: true });
    } finally { release(); await page.unroute("**/hls?*"); }
  }

  // API resolution can fail before a video element exists. Retrying must not
  // depend on mounting the media engine or navigating away from the current item.
  await page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&api-failure=1&proxy=${encodeURIComponent(report.media)}`);
  await page.getByText("fixture playback API unavailable", { exact: true }).waitFor();
  assert.equal(await page.locator("video").count(), 0);
  await page.evaluate(() => { window.playerSeekFixture.rejectPlaybackApi = false; window.dispatchEvent(new Event("hg:proxy-changed")); });
  await page.waitForFunction(() => document.querySelector("video")?.currentTime > 1);
  return { players, failed_api_resolution_retried: true };
}

async function explicitRecoveryCheck(page) {
  const players = [];
  for (const legacy of [false, true]) {
    let broken = true, manifestRequests = 0;
    await page.route("**/hls?*", async route => {
      manifestRequests += 1;
      if (broken) return route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "manifest unavailable" });
      const response = await route.fetch({ url: fixtureMediaUrl(route.request().url()) });
      return route.fulfill({ response });
    });
    try {
      const url = `${report.ui}/tests/player-seek.html?diagnostics=1&proxy=${encodeURIComponent(report.media)}${legacy ? "&legacy=1" : ""}`;

      // A failed initial manifest must actually be re-requested automatically.
      await page.goto(url);
      const retry = page.getByRole("button", { name: "重试", exact: true });
      await retry.waitFor();
      assert.equal(manifestRequests, 5, "Initial manifest request plus four bounded reloads");
      await page.waitForTimeout(1200);
      assert.equal(manifestRequests, 5, "Terminal failure must stop automatic requests");
      broken = false;
      await retry.click();
      await page.waitForFunction(() => document.querySelector("video")?.currentTime > 1);
      assert.equal(manifestRequests, 6, "Manual retry reloads the manifest instead of just calling play");

      // A recoverable source must stay dormant if covered before its retry fires.
      broken = true; manifestRequests = 0;
      const failedManifest = page.waitForResponse(response => new URL(response.url()).pathname === "/hls" && response.status() === 404);
      await page.goto(url);
      await failedManifest;
      await page.waitForFunction(() => window.playerSeekFixture?.engineState().loading === false);
      await page.evaluate(() => window.playerSeekFixture.setActive(false));
      const hiddenRequests = manifestRequests;
      await page.waitForTimeout(1200);
      assert.equal(manifestRequests, hiddenRequests, "Covered player does not execute pending manifest recovery");
      broken = false;
      await page.evaluate(() => window.playerSeekFixture.setActive(true));
      await page.waitForFunction(() => document.querySelector("video")?.currentTime > 1);

      // Exhaust fatal media recovery without replacing the element or losing
      // its clock. The actual UI retry must then rebuild the engine.
      await page.waitForFunction(() => {
        const video = document.querySelector("video");
        return video?.buffered.length && video.buffered.end(0) >= 30;
      });
      await page.locator(legacy ? ".post-player" : ".player-root").hover();
      if (legacy) {
        await page.getByRole("button", { name: "播放速度 1 倍", exact: true }).click();
        await page.getByRole("button", { name: "播放速度 1.25 倍", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "倍速", exact: true }).click();
        await page.getByRole("menuitemradio", { name: "1.5x", exact: true }).click();
      }
      await page.locator("video").evaluate(video => {
        video.pause(); video.currentTime = 8;
      });
      await page.waitForFunction(() => !document.querySelector("video").seeking && document.querySelector("video").readyState >= 2);
      await page.evaluate(() => {
        window.__retryVideo = document.querySelector("video");
        window.playerSeekFixture.stopForMediaFailure();
      });
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await page.evaluate(() => window.playerSeekFixture.failMedia());
        await page.waitForFunction(attempt => window.playerSeekFixture.mediaRecoveryCalls === attempt, attempt);
      }
      await page.evaluate(() => window.playerSeekFixture.failMedia());
      await retry.waitFor();
      await page.evaluate(() => { window.playerSeekFixture.suppressMediaRecovery = false; });
      await retry.click();
      await page.waitForFunction(() => {
        const video = document.querySelector("video");
        return video && !video.paused && video.currentTime >= 8 && video.playbackRate === 1.5;
      });
      assert.equal(await page.locator("video").evaluate(video => video === window.__retryVideo), true,
        "Retry replaces the HLS engine while retaining the DOM video and position");
      players.push({ player: legacy ? "legacy" : "feed", bounded_manifest_reload: true,
        hidden_retry_suspended: true, bounded_media_recovery: true, manual_retry_restores_position_rate_and_play: true });
    } finally {
      await page.unroute("**/hls?*");
    }
  }
  return { players };
}

try {
  if (scenarios.some(name => name !== "ios-native" && name !== "tv" && name !== "review" && name !== "post-flicker")) {
    let mediaDir = args["media-dir"] && resolve(args["media-dir"]);
    if (!mediaDir) {
      temporaryMedia = await mkdtemp(join(tmpdir(), "hghubx-playback-")); mediaDir = temporaryMedia;
      try { generateHlsFixture(mediaDir, "320x180"); } catch { throw new Error("Cannot generate HLS fixture: install FFmpeg (libx264/AAC), set FFMPEG_PATH, or pass --media-dir DIR"); }
    }
    vite = await createViteServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, open: false } });
    await vite.listen(); report.ui = `http://127.0.0.1:${vite.httpServer.address().port}`;
    media = await serveMedia(mediaDir); report.media = `http://127.0.0.1:${media.address().port}`;
    if (scenarios.includes("portrait-fit")) {
      temporaryPortraitMedia = await mkdtemp(join(tmpdir(), "hghubx-playback-portrait-"));
      try { generateHlsFixture(temporaryPortraitMedia, "360x640"); } catch { throw new Error("Cannot generate portrait HLS fixture: install FFmpeg (libx264/AAC) or set FFMPEG_PATH"); }
      portraitMedia = await serveMedia(temporaryPortraitMedia); report.portraitMedia = `http://127.0.0.1:${portraitMedia.address().port}`;
    }
    browser = await chromium.launch({ headless: true, executablePath: args["browser-executable"], args: ["--autoplay-policy=no-user-gesture-required"] });
    report.browser_version = browser.version();
  }
  for (const name of scenarios) {
    const dir = join(output, name); await mkdir(dir);
    if (scriptScenarios[name]) {
      const result = { name, status: "running", started: new Date().toISOString() }; report.cases.push(result);
      let stdout = "", stderr = "";
      try {
        const child = await promisify(execFile)(process.execPath, [join(root, "scripts", scriptScenarios[name].script)], {
          cwd: root, encoding: "utf8", timeout: scriptScenarios[name].timeout, maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, ...(args["browser-executable"] ? { BROWSER_EXECUTABLE: args["browser-executable"] } : {}) },
        });
        stdout = child.stdout; stderr = child.stderr;
        result.metrics = { exit_code: 0, ...scriptScenarios[name].metrics };
        result.status = "passed"; console.log(`PASS ${name}: ${JSON.stringify(result.metrics)}`);
      } catch (error) {
        stdout = error.stdout || ""; stderr = error.stderr || "";
        result.status = "failed"; result.error = error.message;
        result.exit_code = typeof error.code === "number" ? error.code : null;
        result.signal = error.signal || null;
        console.error(`FAIL ${name}: ${error.message}`);
      } finally {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        await writeFile(join(dir, "stdout.log"), stdout);
        await writeFile(join(dir, "stderr.log"), stderr);
        result.finished = new Date().toISOString();
        await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
      }
      continue;
    }
    if (name === "ios-native") {
      const result = { name, status: "running", started: new Date().toISOString() }; report.cases.push(result);
      let stdout = "", stderr = "";
      try {
        const child = await promisify(execFile)(process.execPath, [join(root, "scripts/test-ios-native-media.mjs")], {
          cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, ...(args["browser-executable"] ? { BROWSER_EXECUTABLE: args["browser-executable"] } : {}) },
        });
        stdout = child.stdout; stderr = child.stderr;
        result.metrics = { exit_code: 0, transport: "mock IPC/HLS; real Player/VideoSurface" };
        result.status = "passed"; console.log(`PASS ${name}: ${JSON.stringify(result.metrics)}`);
      } catch (error) {
        stdout = error.stdout || ""; stderr = error.stderr || "";
        result.status = "failed"; result.error = error.message;
        result.exit_code = typeof error.code === "number" ? error.code : null;
        result.signal = error.signal || null;
        console.error(`FAIL ${name}: ${error.message}`);
      } finally {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        await writeFile(join(dir, "stdout.log"), stdout);
        await writeFile(join(dir, "stderr.log"), stderr);
        result.finished = new Date().toISOString();
        await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
      }
      continue;
    }
    if (name === "review") {
      const result = { name, status: "running", started: new Date().toISOString() }; report.cases.push(result);
      let stdout = "", stderr = "";
      try {
        const child = await promisify(execFile)(process.execPath, [join(root, "scripts/test-round-review.mjs")], {
          cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, ...(args["browser-executable"] ? { BROWSER_EXECUTABLE: args["browser-executable"] } : {}) },
        });
        stdout = child.stdout; stderr = child.stderr;
        result.metrics = { focused_checks: true };
        result.status = "passed"; console.log(`PASS ${name}: ${JSON.stringify(result.metrics)}`);
      } catch (error) {
        stdout = error.stdout || ""; stderr = error.stderr || "";
        result.status = "failed"; result.error = error.message;
        result.exit_code = typeof error.code === "number" ? error.code : null;
        result.signal = error.signal || null;
        console.error(`FAIL ${name}: ${error.message}`);
      } finally {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        await writeFile(join(dir, "stdout.log"), stdout);
        await writeFile(join(dir, "stderr.log"), stderr);
        result.finished = new Date().toISOString();
        await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
      }
      continue;
    }
    const mobileContext = name === "gesture" || name === "portrait-fit";
    const context = await browser.newContext({ ...(mobileContext ? {userAgent:"Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1",hasTouch:true} : {}), viewport: name === "portrait-fit" ? { width: 390, height: 844 } : { width: 1000, height: 900 } });
    await context.exposeBinding("collectPlaybackLogs", (_source, entries) => {
      for (const e of entries) jsonl(join(dir, "playback.jsonl"), { ts: e.data.at, event: `web.${e.event}`, data: e.data, transport: "browser-fixture" });
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage(), pageErrors = [], externalRequests = [];
    page.setDefaultTimeout(15000);
    // Nothing in these tests should contact an upstream service.
    await context.route("**/*", route => {
      const raw = route.request().url(), url = new URL(raw), mapped = fixtureMediaUrl(raw);
      if (mapped !== raw) return route.continue({ url: mapped });
      if ([report.ui, report.media, report.portraitMedia].includes(url.origin)) return route.continue();
      externalRequests.push({ protocol: url.protocol, host: url.hostname }); return route.abort("blockedbyclient");
    });
    const ids = new WeakMap(); let requestId = 0;
    page.on("request", req => { ids.set(req, ++requestId); jsonl(join(dir, "network.jsonl"), { request: requestId, event: "request", method: req.method(), path: new URL(req.url()).pathname }); });
    page.on("response", response => jsonl(join(dir, "network.jsonl"), { request: ids.get(response.request()), event: "response", status: response.status() }));
    page.on("requestfailed", req => jsonl(join(dir, "network.jsonl"), { request: ids.get(req), event: "failed", error: req.failure()?.errorText }));
    page.on("console", msg => jsonl(join(dir, "console.jsonl"), { type: msg.type(), text: msg.text() }));
    page.on("pageerror", error => { pageErrors.push(error.message); jsonl(join(dir, "console.jsonl"), { type: "pageerror", text: error.message }); });
    const result = { name, status: "running", started: new Date().toISOString() }; report.cases.push(result);
    let deadline;
    try {
      const action = name === "recovery" ? explicitRecoveryCheck(page) : name === "proxy" ? proxyRecoveryCheck(page) : name === "gesture" ? gestureChecks(page) : name === "portrait-fit" ? portraitFitChecks(page) : name === "seek" || name === "legacy" ? seekChecks(page, name === "legacy") : lifecycleCheck(page);
      result.metrics = await Promise.race([action, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Scenario exceeded 45 seconds")), 45000); })]);
      assert.deepEqual(pageErrors, [], "Browser script errors");
      assert.deepEqual(externalRequests, [], "Unexpected external network requests");
      result.status = "passed"; console.log(`PASS ${name}: ${JSON.stringify(result.metrics)}`);
    } catch (error) {
      result.status = "failed"; result.error = error.message;
      console.error(`FAIL ${name}: ${error.message}`);
    } finally {
      clearTimeout(deadline);
      await getLogs(page).catch(() => {});
      result.page_errors = pageErrors; result.external_requests = externalRequests;
      await page.screenshot({ path: join(dir, "final.png") }).catch(() => {});
      await context.tracing.stop({ path: join(dir, "trace.zip") }).catch(() => {});
      await context.close();
      result.finished = new Date().toISOString();
      await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    }
  }
} catch (error) {
  report.setup_error = error.message; console.error(error.message);
} finally {
  await browser?.close();
  for (const socket of requests) socket.destroy();
  if (media) await new Promise(done => media.close(done));
  if (portraitMedia) await new Promise(done => portraitMedia.close(done));
  await vite?.close();
  if (temporaryMedia) await rm(temporaryMedia, { recursive: true, force: true });
  if (temporaryPortraitMedia) await rm(temporaryPortraitMedia, { recursive: true, force: true });
  report.finished = new Date().toISOString();
  report.passed = report.cases.filter(c => c.status === "passed").length;
  report.failed = report.cases.filter(c => c.status !== "passed").length + (report.setup_error ? 1 : 0);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Playback checks: ${report.passed} passed, ${report.failed} failed. Artifacts: ${output}`);
  process.exitCode = report.failed ? 1 : 0;
}
