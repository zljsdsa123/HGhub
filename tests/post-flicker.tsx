import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { PostDetail } from "../src/features/posts/Posts";
import "../src/index.css";

// 探针：挂载真实 PostDetail（AppProvider 提供 lineEpoch/accountScope）。
// 回归脚本通过 window.postFlickerFixture 注入接口失败、切换帖子 id，
// 并派发真实的 hg:line-changed / hg:proxy-changed 事件（issue #165）。
const post = (id: number) => ({
  id, title: `示例帖子 ${id}`, cover: "https://fixture.invalid/cover.jpg", tags: ["都市"],
  hot: 1200, content: `<p>这是第 ${id} 篇帖子的正文。</p><img src="https://fixture.invalid/article.jpg" alt="正文配图">${"<p>正文段落，用于撑开滚动高度。</p>".repeat(40)}`,
  counts: { like: 3, comment: 2, collect: 1 }, publish_time: "2026-11-19 10:00",
});
const fixture = {
  history: [] as { cmd: string; args: Record<string, unknown> }[],
  events: [] as { t: number; type: string; detail?: string }[],
  postResult: "ok" as "ok" | "fail",
  playbackResult: "ok" as "ok" | "empty" | "fail",
  playbackUrl: "https://media.fixture.invalid/a.m3u8",
};
Object.assign(window, {
  postFlickerFixture: fixture,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback() { return 0; },
    unregisterCallback() {},
    invoke(cmd: string, args: Record<string, unknown> = {}) {
      if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, strict_security: true, base: "https://fixture.invalid" });
      if (cmd === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
      if (cmd === "debug_log") return Promise.resolve();
      if (cmd === "api_post" || cmd === "api_post_playback") {
        fixture.history.push({ cmd, args });
        if (cmd === "api_post") {
          if (fixture.postResult === "fail") return Promise.reject("HTTP 503 upstream unavailable");
          return Promise.resolve(post(Number(args.id)));
        }
        if (fixture.playbackResult === "fail") return Promise.reject("HTTP 503 upstream unavailable");
        if (fixture.playbackResult === "empty") return Promise.resolve({ videos: [] });
        return Promise.resolve({ videos: [{ index: 1, url: fixture.playbackUrl }] });
      }
      return Promise.resolve(null);
    },
  },
});

// 记录整页 Loader 与播放器 portal 的每一次出现/消失（旧代码的闪烁在这里现形）。
const t0 = performance.now();
const note = (type: string, detail?: string) => fixture.events.push({ t: Math.round(performance.now() - t0), type, detail });
new MutationObserver(muts => {
  for (const m of muts) {
    m.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      const el = n as Element;
      if (el.matches?.("[data-post-scroll]") || el.querySelector?.("[data-post-scroll]")) note("page.add");
      if (el.matches?.(".inline-player-host") || el.querySelector?.(".inline-player-host")) note("player.add");
      if (el.matches?.(".spinner") || el.querySelector?.(".spinner")) note("spinner.add", String(el.className).slice(0, 60));
    });
    m.removedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      const el = n as Element;
      if (el.matches?.("[data-post-scroll]") || el.querySelector?.("[data-post-scroll]")) note("page.del");
      if (el.matches?.(".inline-player-host") || el.querySelector?.(".inline-player-host")) note("player.del");
      if (el.matches?.(".spinner") || el.querySelector?.(".spinner")) note("spinner.del");
    });
  }
}).observe(document.documentElement, { childList: true, subtree: true });

function Harness() {
  const [id, setId] = useState(1);
  Object.assign(window, { postFlickerSetId: setId });
  return <PostDetail id={id} onBack={() => {}} active />;
}

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <Harness />
  </AppProvider>,
);
