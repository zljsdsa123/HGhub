/** Serialized into Chromium before the actual application module loads. */
export function installTvFixture({ accepted = false, legacy, contentPreferences, detailDelay = 0, failDetailIds = [], heldDetailIds = [] } = {}) {
  const base = "https://tv.fixture.invalid";
  if (accepted) localStorage.setItem("hghubx_usage_agreement", JSON.stringify({ version: "2026-11-15-v1", accepted: true, acceptedAt: new Date().toISOString() }));
  localStorage.setItem("hghubx_auto_line", "off");
  if (legacy && !sessionStorage.getItem("tv-metadata-seeded")) {
    localStorage.setItem("hghubx_app_v1", JSON.stringify(legacy));
    sessionStorage.setItem("tv-metadata-seeded", "1");
  }
  if (contentPreferences) localStorage.setItem("hghubx_content_preferences_v1", JSON.stringify(contentPreferences));
  const titles = ["我的时间", "我的时间 第二季", "新的时间", "WDSJ", "我的AI时间2", "夜晚故事"];
  const cards = titles.map((title, index) => ({ id: index + 1, title, cover: `${base}/poster/${index + 1}`, tags: index === 5 ? ["夜晚"] : ["都市"],
    score: 8.5, episode_count: 2, total_episodes: 2, hot: 100 - index, like_count: 0, collect_count: 0, comment_count: 0, is_finished: true, is_original: 0,
    description: "遥控器回归用故事简介", author: { id: 1, name: "Fixture" } }));
  const posts = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, title: `我的时间视频${index + 1}`, cover: `${base}/post/${index + 1}`, tags: ["视频"], hot: 20 - index, video_url: "" }));
  const fixture = { base, cards, posts, calls: [], unknown: [], failAck: false, failPosts: false, postActive: 0, postMax: 0, startupReady: 0, keyboardListeners: 0,
    detailDelay, failDetailIds, detailActive: 0, detailMax: 0, heldDetailIds, detailReleases: [],
    releaseDetails() { const releases = fixture.detailReleases.splice(0); releases.forEach(release => release()); },
    nativeListeners: 0, exits: 0, catalogMode: "normal", holdCatalog: false, releaseCatalog: null, failPostIds: [], backChannel: null,
    back() { if (!fixture.backChannel) throw new Error("Missing native back listener"); fixture.backChannel.onmessage({}); } };
  Object.defineProperty(window, "__tvFixture", { value: fixture });
  let startup;
  Object.defineProperty(window, "__HG_STARTUP__", { configurable: true, get: () => startup, set(value) {
    const original = value.ready;
    value.ready = function () { fixture.startupReady++; return original.apply(this, arguments); };
    startup = value;
  } });
  const add = window.addEventListener.bind(window);
  window.addEventListener = (type, ...rest) => { if (type === "keydown") fixture.keyboardListeners++; return add(type, ...rest); };
  const callbacks = new Map(); let callbackId = 0;
  const paged = (items, args = {}, pages = 1) => ({ items, pagination: { page: args.page || 1, pages, size: args.size || 20, total: items.length * pages } });
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback(callback) { const id = ++callbackId; callbacks.set(id, callback); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(command, args = {}) {
      fixture.calls.push({ command, args });
      if (command === "debug_log" || command === "playback_log_write" || command === "line_cancel") return null;
      if (command === "playback_log_status") return { enabled: false, path: null, error: null };
      if (command === "plugin:app|register_listener" && args.event === "back-button") { fixture.nativeListeners++; fixture.backChannel = args.handler; return null; }
      if (command === "plugin:app|remove_listener") return null;
      if (command === "plugin:app|exit") { fixture.exits++; return null; }
      if (command === "app_boot") return { base: fixture.base, user: null, logged_in: false, local_mode: true, pending_migration_identity: null };
      if (command === "tv_migration_complete") { if (fixture.failAck) throw new Error("fixture acknowledgement interrupted"); return null; }
      if (command === "line_state") return { base: fixture.base, default: base, fixed: [{ name: "测试线路", url: base }] };
      if (command === "line_health") return { base: fixture.base, ok: true, ms: 1, status: 200 };
      if (command === "proxy_state") return { mode: "off", url: "", effective: null, system_proxy: false, env_proxy: false };
      if (command === "proxy_set") return { mode: args.mode, url: "", effective: null, system_proxy: false, env_proxy: false };
      if (command === "cache_clear") return { webCache: true, platform: "android" };
      if (command === "api_feed" && args.size === 50) {
        if (fixture.holdCatalog) await new Promise(resolve => { fixture.releaseCatalog = resolve; });
        if (fixture.catalogMode === "error") throw new Error("fixture catalog offline");
        if (fixture.catalogMode === "repeat") return paged(cards, args, 3);
        return paged(cards, args);
      }
      if (["api_feed", "api_category", "api_original_videos", "api_tag_videos"].includes(command)) return paged(cards, args);
      if (command === "api_rank") return { type: args.kind, items: cards.map((item, index) => ({ ...item, video_id: item.id, rank: index + 1, metric_value: item.hot })) };
      if (command === "api_posts") { if (fixture.failPosts) throw new Error("fixture post channel offline"); return paged(posts, args); }
      if (command === "api_video" || command === "api_post") {
        fixture.detailActive++; fixture.detailMax = Math.max(fixture.detailMax, fixture.detailActive);
        try {
          if (fixture.detailDelay) await new Promise(resolve => setTimeout(resolve, fixture.detailDelay));
          if (fixture.heldDetailIds.includes(args.id)) await new Promise(resolve => fixture.detailReleases.push(resolve));
          // Tauri invoke rejects with a host string. Keep this a string so the
          // app's network-only one-shot retry does not swallow the UI retry test.
          if (fixture.failDetailIds.includes(args.id)) throw "fixture detail unavailable";
          if (command === "api_post") {
            const post = posts.find(item => item.id === args.id); if (!post) throw new Error("Unknown post identity");
            return { ...post, content: "ARTICLE_BODY_MUST_NOT_RENDER" };
          }
          const card = cards.find(item => item.id === args.id); if (!card) throw new Error("Unknown video identity");
          // Episode 2 carries a deliberately long title so the episode grid is
          // exercised with a wrapping label next to a short one.
          const titles = { 1: "", 2: "这是一个非常长的剧集标题用于验证选集格子高度一致且不会撑破布局" };
          return { ...card, counts: { hot: card.hot, collect: 0, comment: 0, like: 0 }, episodes: [1, 2].map(ep => ({ ep_num: ep, title: titles[ep] ?? `第 ${ep} 集`, duration: 60, status: 1 })) };
        } finally { fixture.detailActive--; }
      }
      if (command === "api_play") {
        // Match the current upstream shape: string id, `ep`, and streams.main.
        return { id: String(args.id), ep: args.ep, title: cards.find(item => item.id === args.id)?.title, duration: 60,
          streams: { main: `http://hg.localhost/seg?u=${encodeURIComponent(`${base}/video-${args.id}-${args.ep}.mp4`)}` } };
      }
      if (command === "api_post_playback") {
        fixture.postActive++; fixture.postMax = Math.max(fixture.postMax, fixture.postActive);
        try {
          await new Promise(resolve => setTimeout(resolve, 40));
          if (fixture.failPostIds.includes(args.id)) throw new Error("视频不存在或不可播放");
          return { videos: [7, 12].map(index => ({ index, url: `http://hg.localhost/seg?u=${encodeURIComponent(`${base}/post-${args.id}-${index}.mp4`)}` })) };
        } finally { fixture.postActive--; }
      }
      if (command === "api_topics") return { items: [] };
      if (command === "api_tags") return { categories: [] };
      fixture.unknown.push(command);
      throw new Error(`Unexpected TV fixture IPC: ${command}`);
    },
  };
}
