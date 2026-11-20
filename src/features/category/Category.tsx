import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "../../shared/api/api";
import type { Post, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { MediaCard, Masonry, RowCard } from "../../shared/ui/cards";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { CollectionLink, CollectionLinks } from "../../shared/ui/CollectionLink";
import { InplaceSearch } from "../search/InplaceSearch";
import { Empty } from "../../shared/ui/ui";
import { IAward, IBack, IChevR, IFilm, IFlame, ILayers, ISearch, ISpark, ITag, ITrophy } from "../../shared/ui/icons";

export const CHANNELS = [
  { cate: "ai-duanju", name: "AI成人短剧", Icon: IFilm },
  { cate: "ai-manju", name: "AI成人漫剧", Icon: ISpark },
  { cate: "original", name: "原创", Icon: IAward },
] as const;

/* ================= 分类总览 ================= */
export default function Category({ wide, active }: { wide: boolean; active: boolean }) {
  const { push, lineEpoch } = useStore();
  const [rows, setRows] = useState<Record<string, VideoCard[]>>({});
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mounted = useRef(false);
  const started = useRef(false);
  const pending = useRef(new Set<string>());
  const errorsRef = useRef(errors);
  errorsRef.current = errors;
  const lineEpochRef = useRef(lineEpoch);
  lineEpochRef.current = lineEpoch;
  const retryKeys = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadPreview = useCallback(async (key: string): Promise<void> => {
    if (pending.current.has(key)) return;
    const requestEpoch = lineEpochRef.current;
    pending.current.add(key);
    setLoading(m => ({ ...m, [key]: true }));
    setErrors(m => ({ ...m, [key]: "" }));
    try {
      if (key === "posts") {
        const result = await api.postCategory("remen-chigua", 1, 8, "latest");
        if (requestEpoch !== lineEpochRef.current) { retryKeys.current.add(key); return; }
        if (mounted.current) setPosts(result?.items || []);
      } else {
        const result = key === "original"
          ? await api.originalVideos("all", 1, 8, "new")
          : await api.category(key, 1, 8, "latest");
        if (requestEpoch !== lineEpochRef.current) { retryKeys.current.add(key); return; }
        if (mounted.current) setRows(m => ({ ...m, [key]: result?.items || [] }));
      }
    } catch (error) {
      const stale = requestEpoch !== lineEpochRef.current;
      if (mounted.current && !stale) setErrors(m => ({ ...m, [key]: (error as Error).message || "加载失败" }));
      /* 请求在旧线路上发出、期间线路已切换：等 finally 里用新线路补拉一次 */
      if (stale) retryKeys.current.add(key);
    } finally {
      pending.current.delete(key);
      if (mounted.current) setLoading(m => ({ ...m, [key]: false }));
      const retry = retryKeys.current.delete(key);
      if (retry && mounted.current) void loadPreview(key);
    }
  }, []);

  useEffect(() => {
    // 首次打开分类才加载，避免启动时后台频道请求/封面与首页视频竞争网络。
    if (!active || started.current) return;
    started.current = true;
    CHANNELS.forEach(c => { void loadPreview(c.cate); });
    void loadPreview("posts");
  }, [active, loadPreview]);

  /* 线路切换后：已打开过的分类在新线路上重新获取，避免残留旧线路数据 */
  const prevEpoch = useRef(lineEpoch);
  useEffect(() => {
    if (prevEpoch.current === lineEpoch) return;
    prevEpoch.current = lineEpoch;
    if (!started.current) return;
    setRows({});
    setPosts([]);
    setErrors({});
    CHANNELS.forEach(c => { void loadPreview(c.cate); });
    void loadPreview("posts");
  }, [lineEpoch, loadPreview]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-page-heading shrink-0">
        <div className="flex items-baseline gap-2.5">
          <h1 className="ios-page-title text-on">分类</h1>
          <span className="text-[13px] font-medium text-mut">{CHANNELS.length + 1} 个频道</span>
        </div>
      </div>

      <div className="flex-1 scroll-y pb-24 pt-2">
        {/* 排行榜入口：只在移动端显示（底部导航没有排行榜，桌面侧栏已有） */}
        {!wide && (
          <CollectionLink icon={<ITrophy size={18} />} title="排行榜"
            onClick={() => push({ kind: "ranks" })} className="mb-2.5 w-full" />
        )}

        {/* 专题 + 标签入口 */}
        <CollectionLinks className="ios-category-links mb-6">
          <CollectionLink icon={<ILayers size={18} />} title="专题"
            onClick={() => push({ kind: "topics" })} />
          <CollectionLink icon={<ITag size={18} />} title="标签"
            onClick={() => push({ kind: "tags" })} />
        </CollectionLinks>

        {CHANNELS.map((c, ci) => {
          const list = rows[c.cate] || [];
          const ChannelIcon = c.Icon;
          return (
            <section key={c.cate} aria-label={c.name} className="mb-6 a-rise" style={{ animationDelay: `${Math.min(ci * 50, 300)}ms` }}>
              <Button onClick={() => push({ kind: "channel", cate: c.cate, name: c.name })}
                className="w-full flex items-center gap-3 mb-3 text-left pressable group">
                <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0">
                  <ChannelIcon size={18} strokeWidth={1.9} />
                </span>
                <span className="flex-1 min-w-0">
                  <span role="heading" aria-level={2} className="block text-[16px] font-bold text-on leading-tight">{c.name}</span>
                </span>
                <span className="inline-flex items-center gap-0.5 text-[13px] font-medium leading-none text-mut group-hover:text-primary transition-colors shrink-0">
                  <span>全部</span><IChevR size={14} />
                </span>
              </Button>
              <FilteredContent items={list} scopeKey={c.cate}>{visible => <div className="scroll-x flex gap-3 snap-x" role="group" aria-label={`${c.name}影片预览`}>
                {visible.map((v) => (
                  <RowCard key={v.id} v={v} onOpen={() => push({ kind: "feed", videoIds: visible.map((x) => x.id), index: visible.findIndex((x) => x.id === v.id), title: c.name })} />
                ))}
                {!list.length && <PreviewStatus name={c.name} loading={loading[c.cate] !== false} error={errors[c.cate]} onRetry={() => void loadPreview(c.cate)} />}
              </div>}</FilteredContent>
            </section>
          );
        })}

        {/* 吃瓜 */}
        <section aria-label="吃瓜" className="mb-5 a-rise">
          <Button onClick={() => push({ kind: "posts" })}
            className="w-full flex items-center gap-3 mb-3 text-left pressable group">
            <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0">
              <IFlame size={18} strokeWidth={1.9} />
            </span>
            <span className="flex-1 min-w-0">
              <span role="heading" aria-level={2} className="block text-[16px] font-bold text-on leading-tight">吃瓜</span>
            </span>
            <span className="inline-flex items-center gap-0.5 text-[13px] font-medium leading-none text-mut group-hover:text-primary transition-colors shrink-0">
              <span>全部</span><IChevR size={14} />
            </span>
          </Button>
          <FilteredContent items={posts} scopeKey="posts">{visible => <div className="scroll-x flex gap-3 snap-x" role="group" aria-label="吃瓜内容预览">
            {visible.map((post) => (
              <div key={post.id} className="ios-row-card"><MediaCard title={post.title} cover={post.cover}
                subtitle={`${fmt(post.hot)} 次浏览`} onOpen={() => push({ kind: "post", id: post.id })} /></div>
            ))}
            {!posts.length && <PreviewStatus name="吃瓜" loading={loading.posts !== false} error={errors.posts} onRetry={() => void loadPreview("posts")} />}
          </div>}</FilteredContent>
        </section>

        <div className="text-center text-[12px] text-dim pt-1">— 已展示全部频道 —</div>
      </div>
      {wide && <div />}
    </div>
  );
}

function PreviewStatus({ name, loading, error, onRetry }: { name: string; loading: boolean; error?: string; onRetry: () => void }) {
  return <div role="status" aria-busy={loading} className="h-[150px] flex flex-col justify-center items-start gap-2 text-[12px] text-dim px-1">
    <span>{loading ? "加载中…" : error || "暂无内容"}</span>
    {!loading && error && <Button aria-label={`重试${name}`} onClick={onRetry} className="text-primary pressable">重试</Button>}
  </div>;
}

/* ================= 频道详情页 ================= */
const CHANNEL_SORTS = [
  { value: "latest", label: "最近更新" },
  { value: "hot_window", label: "当前热播" },
  { value: "random", label: "精选推荐" },
] as const;

const ORIGINAL_CATES = [
  { value: "all", label: "全部原创" },
  { value: "ai-manju", label: "原创漫剧" },
  { value: "ai-duanju", label: "原创短剧" },
] as const;

const originalSort = (cate: (typeof ORIGINAL_CATES)[number]["value"]) =>
  cate === "all" ? "new" : "latest";

export function ChannelPage({ cate, name, onBack, wide }: { cate: string; name: string; onBack: () => void; wide: boolean }) {
  const { push, lineEpoch } = useStore();
  const { preferences } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [searching, setSearching] = useState(false);
  const [serverSort, setServerSort] = useState<(typeof CHANNEL_SORTS)[number]["value"]>("latest");
  const [originalCate, setOriginalCate] = useState<(typeof ORIGINAL_CATES)[number]["value"]>("all");
  const [pageItems, setPageItems] = useState<VideoCard[][]>([]);
  const items = pageItems.flat();
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const filterKey = (sort: string, original: string) => `${cate}:${cate === "original" ? original : sort}`;
  const [displayedFilter, setDisplayedFilter] = useState(() => filterKey("latest", "all"));
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const requestSeq = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);

  const loadMore = async (reset = false, sortOverride: string = serverSort, originalCateOverride = originalCate) => {
    const seq = reset ? ++requestSeq.current : requestSeq.current;
    if (!reset && (busy.current || page >= pages)) return;
    busy.current = true;
    setLoading(true);
    setErr(null);
    if (reset) setRefreshing(true);
    try {
      const next = reset ? 1 : page + 1;
      const res = cate === "original"
        ? await api.originalVideos(originalCateOverride, next, 20, originalSort(originalCateOverride))
        : await api.category(cate, next, 20, sortOverride);
      if (seq !== requestSeq.current) return;
      setPageItems((prev) => {
        const base = reset ? [] : prev;
        const seen = new Set(base.flat().map((x) => x.id));
        return [...base, (res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setDisplayedFilter(filterKey(sortOverride, originalCateOverride));
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr(null);
    } catch (e) {
      if (seq === requestSeq.current) setErr((e as Error).message || "加载失败");
    } finally {
      if (seq === requestSeq.current) {
        busy.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  const changeServerSort = (value: (typeof CHANNEL_SORTS)[number]["value"]) => {
    if (value === serverSort) return;
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setServerSort(value);
    setErr(null);
    void loadMore(true, value);
  };

  const changeOriginalCate = (value: (typeof ORIGINAL_CATES)[number]["value"]) => {
    if (value === originalCate) return;
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setOriginalCate(value);
    setErr(null);
    void loadMore(true, originalSort(value), value);
  };

  useEffect(() => {
    setPageItems([]); setPage(0); setPages(1);
    setServerSort("latest"); setOriginalCate("all"); setSearching(false);
    void loadMore(true, "latest", "all");
    return () => { requestSeq.current++; busy.current = false; };
    /* eslint-disable-next-line */
  }, [cate, lineEpoch]);
  const filterPending = displayedFilter !== filterKey(serverSort, originalCate);
  const replacing = refreshing || filterPending;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || filtering || loading || err || replacing || page >= pages) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) void loadMore(); }, { root: scrollContainer.current, rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages, loading, err, replacing, filtering]);

  const ChannelGlyph = CHANNELS.find(c => c.cate === cate)?.Icon ?? IFilm;
  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="ios-subpage-bar">
          <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
          <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><ChannelGlyph size={18} strokeWidth={1.9} /></span>
          <div className="flex-1 min-w-0">
            <h1 className="text-[17px] font-bold text-on leading-tight truncate">{name}</h1>
            <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">{replacing ? (loading ? "正在更新筛选结果…" : "筛选更新失败") : `已加载 ${items.length} 部 · ${page}/${Math.max(pages, 1)} 页`}</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label={cate === "original" ? "搜索原创" : "搜索短剧"} className="ios-nav-btn"><ISearch size={18} /></Button>
        </div>
        {cate === "original" && (
          <div className="ios-subpage-inner pb-3 flex flex-wrap gap-2">
            {ORIGINAL_CATES.map((s) => (
              <Button aria-pressed={originalCate === s.value} key={s.value} onClick={() => changeOriginalCate(s.value)}
                className="ios-filter-pill">{s.label}</Button>
            ))}
          </div>
        )}
        {cate !== "original" && (
          <div className="ios-subpage-inner pb-3 flex flex-wrap gap-2">
            {CHANNEL_SORTS.map((s) => (
              <Button aria-pressed={serverSort === s.value} key={s.value} onClick={() => changeServerSort(s.value)}
                className="ios-filter-pill">{s.label}</Button>
            ))}
          </div>
        )}
      </div>
      <div ref={scrollContainer} className="flex-1 scroll-y pt-3.5 pb-8" aria-busy={loading}>
        {items.length > 0 && replacing && <p role="status" className="mb-3 text-[12px] text-mut">{loading ? "正在更新，暂时保留上次结果…" : "当前显示上次结果，请重试以更新筛选。"}</p>}
        {items.length > 0 && err && <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-mut"><span>{err}</span><Button className="px-3 text-primary" onClick={() => void loadMore(replacing)}>重试</Button></div>}
        {items.length ? (
          <div inert={replacing || undefined} className={replacing ? "opacity-60" : undefined}>
            <Masonry videos={items} scopeKey={filterKey(serverSort, originalCate)} wide={wide} onOpen={(v, visible) => { if (!replacing) push({ kind: "feed", videoIds: visible.map((x) => x.id), index: visible.findIndex((x) => x.id === v.id), title: name }); }} />
          </div>
        ) : err ? (
          <Empty icon={<ChannelGlyph size={26} />} title="加载失败" sub={err} action="重试" onAction={() => void loadMore(true)} />
        ) : loading ? (
          <div className="flex justify-center py-10"><Loader className="w-8 h-8 spinner" /></div>
        ) : <Empty icon={<ChannelGlyph size={26} />} title="该筛选下暂无内容" sub="换个筛选试试" />}
        <div ref={sentinel} className="h-10" />
        {loading && items.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {!loading && !err && !replacing && page < pages && <Button onClick={() => void loadMore()} className="my-3 px-4 text-primary">加载更多</Button>}
        {!loading && !replacing && !err && page >= pages && items.length > 0 && (
          <div className="text-center text-[12px] text-dim py-3">— 已经到底啦 —</div>
        )}
      </div>
      {searching && <InplaceSearch kind="video" scope={cate === "original" ? "original" : undefined} wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list, kw) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: kw ? `搜索 · ${kw}` : `搜索 · ${name}` })} />}
    </div>
  );
}
