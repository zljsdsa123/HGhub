import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "../api";
import type { TopicCard, TagGroup, VideoCard } from "../types";
import { useStore } from "../store";
import { Masonry } from "../components/cards";
import { Empty, Img } from "../components/ui";
import { IBack, IGrid, IGlobe, IRefresh, ISearch } from "../icons";

const TopicIcon = IGrid;
const TagIcon = IGlobe;

/* ================= 专题列表页 ================= */
export function TopicsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, toast, pop, setTab } = useStore();
  const [items, setItems] = useState<TopicCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setErr("");
    api.topics()
      .then((r) => setItems(r?.items || []))
      .catch((e) => { setErr((e as Error).message || "加载失败"); toast((e as Error).message || "加载失败", "info"); })
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <button onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
          <span className="text-[17px] font-bold text-on">专题</span>
          <span className="text-[10.5px] text-mut">{items.length} 个专辑</span>
          <button onClick={() => { pop(); setTab("search"); }} aria-label="搜索" className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></button>
          <button onClick={load} className="w-9 h-9 rounded-full flex items-center justify-center text-mut hover:bg-s3 pressable"><IRefresh size={16} /></button>
        </div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-8">
        {loading ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
        ) : err && !items.length ? (
          <Empty icon={<TopicIcon size={26} />} title="专题加载失败" sub={err} action="重试" onAction={load} />
        ) : items.length ? (
          <div className="grid grid-cols-2 gap-3">
            {items.map((t) => (
              <button key={t.id} onClick={() => push({ kind: "topic", slug: t.slug, name: t.title })}
                className="text-left rounded-(--r-md) overflow-hidden bg-s1 elev-1 pressable a-rise">
                <div className="relative w-full" style={{ paddingTop: "56%" }}>
                  <Img src={t.cover} />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                  <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded-full bg-black/55 backdrop-blur-sm text-[10px] font-semibold text-white/90">
                    {t.video_count ?? 0} 部
                  </span>
                </div>
                <div className="p-2.5">
                  <div className="text-[13px] font-semibold text-on clamp-1 leading-tight">{t.title}</div>
                  {t.intro && <div className="text-[10.5px] text-mut clamp-2 mt-1 leading-relaxed">{t.intro}</div>}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <Empty icon={<TopicIcon size={26} />} title="暂无专题" />
        )}
        {wide && <div className="h-2" />}
      </div>
    </div>
  );
}

/* ================= 专题详情页 ================= */
export function TopicPage({ slug, name, onBack, wide }: { slug: string; name: string; onBack: () => void; wide: boolean }) {
  const { push, toast, pop, setTab } = useStore();
  const [topic, setTopic] = useState<TopicCard | null>(null);
  const [related, setRelated] = useState<TopicCard[]>([]);
  const [videos, setVideos] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (busy.current || page >= pages) return;
    busy.current = true;
    setLoading(true);
    try {
      const res = await api.topic(slug);
      setTopic(res?.topic || null);
      setRelated(res?.related || []);
      const next = page + 1;
      const items = res?.videos?.items || [];
      const pag = res?.videos?.pagination;
      // 详情接口只回第一页；后续页用 /api/videos/tag 无法等价，先只支持第一页内的分页翻取
      setVideos(items);
      setPage(pag?.page || next);
      setPages(pag?.pages || 1);
      setErr("");
    } catch (e) {
      setErr((e as Error).message || "加载失败");
      toast((e as Error).message || "加载失败", "info");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [page, pages, slug, toast]);

  useEffect(() => { loadMore(); /* eslint-disable-next-line */ }, []);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <button onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-bold text-on truncate">{topic?.title || name}</div>
            <div className="text-[10.5px] text-mut">{topic?.video_count ?? 0} 部 · {videos.length} 已加载</div>
          </div>
          <button onClick={() => { pop(); setTab("search"); }} aria-label="搜索" className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></button>
        </div>
        {topic?.intro && <div className="px-4 pb-3 text-[11.5px] text-mut leading-relaxed clamp-3">{topic.intro}</div>}
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-8">
        {related.length > 0 && (
          <div className="mb-4">
            <div className="text-[12px] font-semibold text-on/80 mb-2">相关专题</div>
            <div className="scroll-x flex gap-2.5 snap-x">
              {related.map((r) => (
                <button key={r.id} onClick={() => push({ kind: "topic", slug: r.slug, name: r.title })}
                  className="w-[140px] shrink-0 text-left snap-start pressable">
                  <div className="relative w-full rounded-(--r-sm) overflow-hidden bg-s1 elev-1" style={{ paddingTop: "56%" }}>
                    <Img src={r.cover} />
                    <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded-full bg-black/55 text-[9px] font-semibold text-white/90">{r.video_count ?? 0} 部</span>
                  </div>
                  <div className="mt-1.5 text-[11px] font-medium text-on clamp-1 leading-tight">{r.title}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {loading && !videos.length ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
        ) : err && !videos.length ? (
          <Empty icon={<TopicIcon size={26} />} title="加载失败" sub={err} action="重试" onAction={loadMore} />
        ) : videos.length ? (
          <Masonry videos={videos} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: videos.map((x) => x.id), index: videos.findIndex((x) => x.id === v.id), title: topic?.title || name })} />
        ) : (
          <Empty icon={<TopicIcon size={26} />} title="暂无内容" />
        )}
        <div ref={sentinel} className="h-8" />
        {loading && videos.length > 0 && <div className="flex justify-center py-3"><div className="w-6 h-6 spinner" /></div>}
        {!loading && videos.length > 0 && page >= pages && <div className="text-center text-[10.5px] text-dim py-3">— 已经到底啦 —</div>}
        {wide && <div className="h-2" />}
      </div>
    </div>
  );
}

/* ================= 标签聚合页 ================= */
export function TagsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, toast, pop, setTab } = useStore();
  const [groups, setGroups] = useState<TagGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setErr("");
    api.tags()
      .then((r) => setGroups(r?.categories || []))
      .catch((e) => { setErr((e as Error).message || "加载失败"); toast((e as Error).message || "加载失败", "info"); })
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <button onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
          <span className="text-[17px] font-bold text-on">标签</span>
          <button onClick={() => { pop(); setTab("search"); }} aria-label="搜索" className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></button>
          <button onClick={load} className="w-9 h-9 rounded-full flex items-center justify-center text-mut hover:bg-s3 pressable"><IRefresh size={16} /></button>
        </div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-8">
        {loading ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
        ) : err && !groups.length ? (
          <Empty icon={<TopicIcon size={26} />} title="标签加载失败" sub={err} action="重试" onAction={load} />
        ) : groups.length ? (
          groups.map((g) => (
            <section key={g.name} className="mb-5 a-rise">
              <div className="flex items-center gap-2 mb-2.5">
                <span className="text-[13.5px] font-bold text-on">{g.name}</span>
                <span className="text-[10.5px] text-dim">{g.tags?.length || 0} 个</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {g.tags.map((t) => (
                  <button key={t.id} onClick={() => push({ kind: "tag", tag: t.name, name: t.name })}
                    className="px-3 h-8 rounded-(--r-ctl) bg-s3 text-[12px] text-on/85 pressable flex items-center gap-1">
                    {t.name}
                    {!!t.hot_score && <span className="text-[9.5px] text-dim">{fmt(t.hot_score)}</span>}
                  </button>
                ))}
              </div>
            </section>
          ))
        ) : (
          <Empty icon={<TopicIcon size={26} />} title="暂无标签" />
        )}
        {wide && <div className="h-2" />}
      </div>
    </div>
  );
}

/* ================= 标签视频页 ================= */
export function TagPage({ tag, name, onBack, wide }: { tag: string; name: string; onBack: () => void; wide: boolean }) {
  const { push, toast, pop, setTab } = useStore();
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (busy.current || page >= pages) return;
    busy.current = true;
    setLoading(true);
    try {
      const next = page + 1;
      const res = await api.tagVideos(tag, next, 20);
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr("");
    } catch (e) {
      setErr((e as Error).message || "加载失败");
      toast((e as Error).message || "加载失败", "info");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [page, pages, tag, toast]);

  useEffect(() => { loadMore(); /* eslint-disable-next-line */ }, []);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <button onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
          <span className="text-[16px] font-bold text-on">{name}</span>
          <span className="text-[10.5px] text-mut">{items.length} 部</span>
          <button onClick={() => { pop(); setTab("search"); }} aria-label="搜索" className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></button>
        </div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-8">
        {loading && !items.length ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
        ) : err && !items.length ? (
          <Empty icon={<TopicIcon size={26} />} title="加载失败" sub={err} action="重试" onAction={loadMore} />
        ) : items.length ? (
          <Masonry videos={items} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: items.map((x) => x.id), index: items.findIndex((x) => x.id === v.id), title: name })} />
        ) : (
          <Empty icon={<TopicIcon size={26} />} title="该标签下暂无内容" />
        )}
        <div ref={sentinel} className="h-8" />
        {loading && items.length > 0 && <div className="flex justify-center py-3"><div className="w-6 h-6 spinner" /></div>}
        {!loading && items.length > 0 && page >= pages && <div className="text-center text-[10.5px] text-dim py-3">— 已经到底啦 —</div>}
        {wide && <div className="h-2" />}
      </div>
    </div>
  );
}