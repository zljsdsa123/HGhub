import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TopicPage } from "../src/pages/Discover";
import { AppProvider } from "../src/store";
import type { TopicDetail, VideoCard } from "../src/types";
import "../src/index.css";

type PendingTopic = {
  slug: string;
  page: number;
  size: number;
  resolve: (value: TopicDetail) => void;
  reject: (reason: string) => void;
};

const idsByPage = [
  Array.from({ length: 20 }, (_, index) => index + 1),
  [20, ...Array.from({ length: 19 }, (_, index) => index + 21)],
  Array.from({ length: 20 }, (_, index) => index + 40),
  Array.from({ length: 20 }, (_, index) => index + 60),
  [80, 81],
];

const makeVideo = (id: number): VideoCard => ({
  id,
  title: `专题影片 ${id}`,
  cover: "",
  tags: [],
  score: 8,
  episode_count: 1,
  total_episodes: 1,
  duration: "01:00",
  hot: id,
  like_count: 0,
  collect_count: 0,
  comment_count: 0,
  is_finished: true,
  is_original: 0,
});

const topicTitles: Record<string, string> = {
  "hot-aiduanju": "热门专题",
  "luanlun-aiduanju": "第二专题",
};

const pending: PendingTopic[] = [];
const history: { slug: string; page: number; size: number }[] = [];

const fixture = {
  history,
  pending,
  resolve(slug: string, page: number) {
    const index = pending.findIndex((request) => request.slug === slug && request.page === page);
    const [request] = index < 0 ? [] : pending.splice(index, 1);
    if (!request) throw new Error(`no pending api_topic for ${slug} page ${page}`);
    const ids = idsByPage[page - 1] ?? [];
    request.resolve({
      topic: { id: 1, slug, title: topicTitles[slug] ?? slug, cover: "", video_count: 81 },
      videos: {
        items: ids.map(makeVideo),
        pagination: { page, pages: 5, size: 20, total: 81 },
      },
      related: [],
    });
  },
  reject(slug: string, page: number) {
    const index = pending.findIndex((request) => request.slug === slug && request.page === page);
    const [request] = index < 0 ? [] : pending.splice(index, 1);
    if (!request) throw new Error(`no pending api_topic for ${slug} page ${page}`);
    request.reject("第 3 页暂时不可用");
  },
};

Object.assign(window, {
  topicPaginationFixture: fixture,
  __TAURI_INTERNALS__: {
    invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === "app_boot") {
        return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
      }
      if (command === "debug_log") return Promise.resolve();
      if (command === "api_topic") {
        const slug = String(args.slug);
        const page = Number(args.page);
        const size = Number(args.size);
        history.push({ slug, page, size });
        return new Promise((resolve, reject) => pending.push({ slug, page, size, resolve, reject }));
      }
      return Promise.reject(`Unexpected IPC: ${command}`);
    },
  },
});

function Fixture() {
  const [slug, setSlug] = useState("hot-aiduanju");
  return <AppProvider>
    <div style={{ position: "relative", width: 390, height: 844 }}>
      <button id="topic-a" style={{ position: "fixed", zIndex: 10, left: 4, top: 4 }} onClick={() => setSlug("hot-aiduanju")}>专题 A</button>
      <button id="topic-b" style={{ position: "fixed", zIndex: 10, left: 72, top: 4 }} onClick={() => setSlug("luanlun-aiduanju")}>专题 B</button>
      <TopicPage slug={slug} name={slug} onBack={() => {}} wide={false} />
    </div>
  </AppProvider>;
}

createRoot(document.querySelector("#root")!).render(<Fixture />);
