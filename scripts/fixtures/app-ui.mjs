export function installFixture({ theme, titles }) {
  const cards = titles.map((title, i) => ({
    id: i + 1, title, cover: `https://fixture.invalid/poster/${i}`, tags: ["都市", "剧情"], score: i % 2 === 0 ? 8.5 : 0,
    episode_count: 24, total_episodes: 24, hot: 286000, like_count: 1800, collect_count: 900,
    comment_count: 20, is_finished: true, is_original: 0, description: "界面回归示例数据",
    author: { id: 1, name: "示例作者" },
  }));
  const topic = { id: 1, title: "本周精选", slug: "weekly", cover: cards[0].cover, intro: "城市与故事", video_count: cards.length };
  const paged = items => ({ items, pagination: { page: 1, pages: 1, size: 30, total: items.length } });
  localStorage.setItem("hghubx_theme", theme);
  localStorage.setItem("hghubx_app_v1", JSON.stringify({ favs: [1, 2, 3, 4, 5, 6], history: [{ id: 1, ep: 3, t: 55, dur: 180, at: 123 }], searchHist: ["都市"] }));
  localStorage.setItem("hghubx_swipe_ep_v2", "1");
  const callbacks = new Map();
  let nextCallback = 0, backChannel;
  window.__IOS_UI_FIXTURE__ = {
    hardwareBack() {
      if (!backChannel) throw new Error("Android back listener was not registered");
      backChannel.onmessage({});
    },
    hasHardwareBack() { return !!backChannel; },
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback(callback) { const id = ++nextCallback; callbacks.set(id, callback); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(command, args = {}) {
      if (command === "app_boot") return { user: null, logged_in: false, strict_security: true, base: "https://fixture.invalid" };
      if (command === "playback_log_status") return { enabled: false, path: null, error: null };
      if (command === "line_auto") return { base: "https://fixture.invalid", previous: "https://fixture.invalid", switched: false, pick: { tier: "main", ms: 1, reason: "fixture", candidates: [] } };
      if (command === "api_feed") return paged([]);
      if (["api_category", "api_original_videos", "api_search", "api_posts", "api_post_category", "api_tag_videos"].includes(command)) return paged(cards);
      if (command === "api_topics") return paged([topic]);
      if (command === "api_topic") return { topic, videos: paged(cards), related: [] };
      if (command === "api_tags") return { categories: [{ name: "题材", tags: [{ id: 1, name: "都市", slug: "city" }] }] };
      if (command === "api_rank") return paged(cards.map((card, index) => ({ ...card, rank: index + 1, video_id: card.id, metric_value: card.hot, metric_label: "热度" })));
      if (command === "api_search_hot") return paged(titles.map((title, index) => ({ video_id: index + 1, title, plays: `${550 - index * 10}.1w播放量` })));
      if (command === "api_video") return { ...cards[(args.id - 1) % cards.length], counts: { collect: 900, comment: 20, hot: 286000, like: 1800 }, episodes: [] };
      if (command === "api_login") {
        if (args.username === "profile-fixture") return { user: { id: 9, username: "fixture", nickname: "示例用户", avatar: "", avatar_color: "#63748b", counts: {} } };
        throw "账号或密码不正确";
      }
      if (command === "api_logout") return { ok: true };
      if (command === "security_set") return args.strict;
      if (command === "api_play") throw "UI fixture has no media";
      if (command === "plugin:app|register_listener" && args.event === "back-button") { backChannel = args.handler; return; }
      if (command === "plugin:window|is_maximized" || command === "plugin:window|is_fullscreen") return false;
      return null;
    },
  };
}
