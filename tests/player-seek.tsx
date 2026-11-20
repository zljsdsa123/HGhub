import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Feed } from "../src/features/feed";
import { AppProvider } from "../src/shared/model/store";
import { api } from "../src/shared/api/api";
import "../src/index.css";
import { flushPlaybackLog, initPlaybackLog, playbackLogApi, setPlaybackLog } from "../src/shared/diagnostics/playbackDiagnostics";
import Settings from "../src/features/settings/Settings";
import Hls from "hls.js";
import { Player, VideoSurface } from "../src/features/playback";

// 仅将自定义媒体协议映射到本地测试服务器；播放器、HLS 和鼠标事件均使用真实实现。
const proxy = new URLSearchParams(location.search).get("proxy") || "http://127.0.0.1:17779";
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, target: string | URL, async: boolean = true, user?: string | null, credential?: string | null) {
  const url = new URL(String(target), location.href);
  if (url.hostname === "hg.localhost" || (url.hostname === "localhost" && url.protocol === "hg:")) {
    target = `${proxy}${url.pathname}${url.search}`;
  }
  return open.call(this, method, target, async, user, credential);
};

const fixture = {
  rejectPlaybackApi: new URLSearchParams(location.search).has("api-failure"),
  seeks: [] as number[], errors: [] as string[],
  playCalls: [] as [number, number][],
  setActive: (_active: boolean) => {},
  setMounted: (_mounted: boolean) => {},
  logs: [] as { event: string; data: Record<string, unknown> }[],
  setLogging: setPlaybackLog,
  flushLogs: flushPlaybackLog,
  rejectLoggingSave: false,
  pauseBuffering: () => testHls?.pauseBuffering(),
  resumeBuffering: () => testHls?.resumeBuffering(),
  suppressMediaRecovery: false,
  mediaRecoveryCalls: 0,
  stopForMediaFailure: () => { fixture.suppressMediaRecovery = true; testHls?.stopLoad(); },
  failMedia: () => testHls?.trigger(Hls.Events.ERROR, {
    type: Hls.ErrorTypes.MEDIA_ERROR,
    details: Hls.ErrorDetails.BUFFER_APPEND_ERROR,
    fatal: true,
    error: new Error("fixture media failure"),
  }),
  engineState: () => ({ loading: testHls?.loadingEnabled, buffering: testHls?.bufferingEnabled, levels: testHls?.levels.length }),
};
let testHls: Hls | undefined;
const diagnosticTest = new URLSearchParams(location.search).has("diagnostics");
const legacyTest = new URLSearchParams(location.search).has("legacy");
const initiallyInactive = new URLSearchParams(location.search).has("inactive");
const delayedMount = new URLSearchParams(location.search).has("delayed-mount");
// issue #142 fit 回归：手机竖屏视口下按真实视口尺寸铺满播放面，
// 并跳过仅桌面端会成立的闲置进度条命中测试（移动端没有 .player-root.is-idle）。
const portraitFitTest = new URLSearchParams(location.search).has("portrait-fit");
// 2.2.0 反馈回归：多集详情 + 下一集地址延迟解析，制造切集过渡期窗口。
// 延迟闸门由测试脚本在页面初始化时注入（window.__playGate）， harness 只消费。
const swipeEpTest = new URLSearchParams(location.search).has("swipe-ep");
if (diagnosticTest) {
  // Test-only handle: exercise the real engine's public API without rewriting production modules.
  const attach = Hls.prototype.attachMedia;
  Hls.prototype.attachMedia = function (...args) { testHls = this; return attach.apply(this, args); };
  // Simulate a persistent decoder failure without detaching MSE or allowing
  // fresh buffers to reset the application's bounded recovery budget.
  const recoverMediaError = Hls.prototype.recoverMediaError;
  Hls.prototype.recoverMediaError = function () {
    fixture.mediaRecoveryCalls += 1;
    if (!fixture.suppressMediaRecovery) recoverMediaError.call(this);
  };
  const startLoad = Hls.prototype.startLoad;
  Hls.prototype.startLoad = function (...args) {
    if (!fixture.suppressMediaRecovery) startLoad.apply(this, args);
  };
  let enabled = false;
  playbackLogApi.status = async () => ({ enabled, path: "playback.log", error: null });
  playbackLogApi.set = async (on) => {
    if (fixture.rejectLoggingSave) throw new Error("fixture: disk unavailable");
    return { enabled: enabled = on, path: "playback.log", error: null };
  };
  playbackLogApi.write = async entries => {
    if (!enabled) return;
    fixture.logs.push(...entries);
    const collect = (window as typeof window & { collectPlaybackLogs?: (entries: typeof fixture.logs) => Promise<void> }).collectPlaybackLogs;
    await collect?.(entries);
  };
  playbackLogApi.read = async () => fixture.logs.map(e => JSON.stringify(e)).join("\n");
  api.lineState = async () => ({ base: "https://fixture.invalid", default: "https://fixture.invalid", fixed: [] });
  void initPlaybackLog();
}
Object.assign(window, { playerSeekFixture: fixture });
document.addEventListener("seeking", (e) => {
  if (e.target instanceof HTMLVideoElement) fixture.seeks.push(e.target.currentTime);
}, true);
window.addEventListener("error", (e) => fixture.errors.push(e.message));
api.boot = async () => ({ user: null, logged_in: false, base: "https://fixture.invalid", strict_security: true });
api.play = async (id = 991, ep = 1) => {
  if (fixture.rejectPlaybackApi) throw new Error("fixture playback API unavailable");
  if (swipeEpTest) {
    fixture.playCalls.push([id, ep]);
    const gate = (window as typeof window & { __playGate?: Promise<void> }).__playGate;
    if (ep > 1 && gate) await gate;
  }
  return { id, ep_num: ep, title: "Seek fixture", duration: 90, video_url: "https://media.fixture.invalid/list.m3u8" };
};
api.video = async (id = 991) => ({
  id, title: id === 991 ? "Seek fixture" : "Other fixture", description: "", cover: "", tags: [], score: 0,
  episode_count: swipeEpTest && id === 991 ? 3 : 1, total_episodes: swipeEpTest && id === 991 ? 3 : 1,
  episodes: (swipeEpTest && id === 991 ? [1, 2, 3] : [1]).map(ep_num => ({ ep_num, title: `ep${ep_num}`, duration: 90, status: 1 })),
  counts: { like: 0, collect: 0, comment: 0, hot: 0 },
  author: { id: 1, name: "Fixture" }, is_finished: true, is_original: 0,
});
function Fixture() {
  const [active, setActive] = useState(!initiallyInactive);
  const [mounted, setMounted] = useState(!delayedMount);
  const [settings, setSettings] = useState(false);
  fixture.setActive = setActive;
  fixture.setMounted = setMounted;
  return <AppProvider>
    <div data-player-fixture data-active={active} style={portraitFitTest
      ? { position: "relative", width: window.innerWidth, height: window.innerHeight }
      : { position: "relative", width: 900, height: 540 }}>
      {mounted && (legacyTest
        ? <Player src="https://media.fixture.invalid/list.m3u8" autoPlay active={active} className="w-full h-full" diagnosticContext={{ video_id: 991, active }} />
        : delayedMount
          ? <VideoSurface src="https://media.fixture.invalid/list.m3u8" autoPlay active={active} className="w-full h-full" diagnosticContext={{ video_id: 991, active }} />
          : <Feed videoIds={swipeEpTest ? [991, 992] : [991]} mode="home" active={active} bottomInset={0} />)}
    </div>
    <button onClick={() => setActive((v) => !v)}>切换播放页激活状态</button>
    {diagnosticTest && <button onClick={() => setSettings(v => !v)}>诊断设置</button>}
    {settings && <div style={{ position: "relative", width: 900, height: 700 }}><Settings onBack={() => setSettings(false)} wide /></div>}
  </AppProvider>;
}
createRoot(document.querySelector("#root")!).render(<Fixture />);

// 自动检查真正的浏览器命中测试，而非仅匹配 CSS 字符串。
async function checkIdleSeekTarget() {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    const video = document.querySelector("video");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="播放进度"]');
    if (video && input && video.currentTime > 0 && document.querySelector(".player-root.is-idle")) {
      const rect = input.getBoundingClientRect();
      if (document.elementFromPoint(rect.x + rect.width * .8, rect.y + rect.height / 2) !== input) {
        throw new Error("闲置进度条点击穿透到视频");
      }
      document.querySelector("#results")!.textContent = JSON.stringify({ passed: 1, failed: 0 });
      return;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error("等待播放或控制条隐藏超时");
}
if (!legacyTest && !initiallyInactive && !delayedMount && !portraitFitTest) void checkIdleSeekTarget().catch((error) => {
  fixture.errors.push(String(error));
  document.querySelector("#results")!.textContent = JSON.stringify({ passed: 0, failed: 1, error: String(error) });
});
