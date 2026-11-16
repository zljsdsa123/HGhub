import { Button, Form, Input, SegmentedControl, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useEffect, useRef, useState } from "react";
import { api, fmt, isMobile } from "../api";
import type { HotSearchVideo, Post, RankItem, VideoCard } from "../types";
import { useStore } from "../store";
import { MediaCard, Masonry, RankRow } from "../components/cards";
import { FilteredContent } from "../components/FilteredContent";
import { Empty } from "../components/ui";
import { useSearchResults } from "../useSearchResults";
import { SearchTags } from "../components/SearchTags";
import { IBack, IChevR, IClose, IFireF, IPlayF, IRefresh, ISearch, ITrophy } from "../icons";

export default function Search({ active, wide }: { active: boolean; wide: boolean }) {
  const { push, searchHist, addSearch, clearSearchHist, lineEpoch, accountScope } = useStore();
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [tab, setTab] = useState<"video" | "post">("video");
  const results = useSearchResults();
  const { result, request, loading, error: err } = results;
  const items = result?.kind === "video" ? result.items as VideoCard[] : [];
  const posts = result?.kind === "post" ? result.items as Post[] : [];
  const count = result?.items.length ?? 0;
  const inputRef = useRef<HTMLInputElement>(null);
  const [hotVideos, setHotVideos] = useState<HotSearchVideo[]>([]);
  const [hotLoading, setHotLoading] = useState(false);
  const [hotError, setHotError] = useState<string | null>(null);
  const hotBusy = useRef(false);
  const hotLoadedAt = useRef(0);

  /* 移动端进入搜索页不自动聚焦：iOS 会立刻弹键盘遮住内容（#20）。
     桌面端没有软键盘，聚焦便于直接打字。 */
  useEffect(() => {
    if (active && !isMobile) inputRef.current?.focus();
  }, [active]);

  const refreshHot = async () => {
    if (hotBusy.current) return;
    hotBusy.current = true;
    setHotLoading(true);
    setHotError(null);
    try {
      const res = await api.searchHot();
      setHotVideos(res.items);
      hotLoadedAt.current = Date.now();
    } catch (e) {
      setHotError(e instanceof Error ? e.message : "热搜榜加载失败，请重试");
    } finally {
      hotBusy.current = false;
      setHotLoading(false);
    }
  };
  useEffect(() => {
    // 切换主导航时短暂复用榜单；手动刷新始终重新获取官网内容。
    if (active && Date.now() - hotLoadedAt.current > 60_000) void refreshHot();
  }, [active]);

  const changeTab = (next: "video" | "post") => {
    if (next === tab) return;
    setTab(next);
    if (submitted) results.search(submitted, next, true);
  };

  const submit = (keyword: string) => {
    const k = keyword.trim();
    if (!k) return;
    setQ(k);
    setSubmitted(k);
    addSearch(k);
    results.search(k, tab);
  };

  const querying = submitted.length > 0;

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-page-heading shrink-0"><h1 className="ios-page-title">搜索</h1></div>
      {/* 搜索栏 */}
      <div className="shrink-0 px-4 pb-3 flex items-center gap-2.5" >
        <Form className="ios-search-form flex-1 min-w-0 flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); submit(q); }}>
          <ISearch size={17} className="text-mut shrink-0" />
          <Input aria-label="搜索短剧、帖子、题材…" ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索短剧、帖子、题材…"
            className="flex-1 min-w-0 bg-transparent text-[14px] text-on placeholder-dim outline-none" />
          {q && <Button aria-label="清空搜索" type="button" onClick={() => { results.clear(); setQ(""); setSubmitted(""); inputRef.current?.focus(); }} className="ios-icon-button ios-search-clear"><IClose size={16} /></Button>}
        </Form>
        <Button onClick={() => push({ kind: "ranks" })} aria-label="排行榜"
          variant="primary" className="ios-icon-button ios-search-shortcut">
          <ITrophy size={19} />
        </Button>
      </div>

      <div className="flex-1 scroll-y px-4 pb-24">
        {!querying ? (
          <>
            <Surface role="region" aria-label="热搜榜" className="mt-1 rounded-(--r-md) bg-s2 p-3.5 a-rise">
                <div className="flex items-center justify-between">
                  <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-on/90"><IFireF size={15} className="text-primary" />热搜榜</h2>
                  <Button onClick={() => void refreshHot()} disabled={hotLoading} aria-label="刷新热搜榜"
                    className="flex items-center gap-1 px-2 text-[12px] text-mut pressable">
                    {hotLoading ? <Loader className="w-3 h-3" /> : <IRefresh size={12} />}{hotLoading ? "刷新中" : "刷新"}
                  </Button>
                </div>
                {hotError && <p role="status" className="mt-2 text-[12px] text-mut leading-relaxed">
                  {hotVideos.length > 0 ? "刷新失败，保留上次榜单。" : "热搜榜暂不可用。"}{hotError}
                </p>}
                {hotVideos.length > 0 ? (
                  <ol className="ios-search-hot-grid mt-3" aria-busy={hotLoading}>
                    {hotVideos.map((video, i) => (
                      <li key={video.video_id} className="min-w-0">
                        <Button aria-label={`播放 ${video.title}`} title={video.title} className="ios-search-hot-item"
                          onClick={() => push({ kind: "feed", videoIds: hotVideos.map(item => item.video_id), index: i, title: "热搜榜" })}>
                          <span aria-hidden="true" className={`ios-search-hot-rank ${i < 3 ? "text-primary" : "text-mut"}`}>{String(i + 1).padStart(2, "0")}</span>
                          <span className="ios-search-hot-content">
                            <span className="ios-search-hot-title">{video.title}</span>
                            {video.plays && <span className="ios-search-hot-plays"><IPlayF size={10} />{video.plays}</span>}
                          </span>
                          <IChevR size={15} className="text-mut" />
                        </Button>
                      </li>
                    ))}
                  </ol>
                ) : !hotError && <p role="status" className="mt-3 text-[12px] text-mut">{hotLoading ? "加载中…" : "暂无热搜影片"}</p>}
              </Surface>

            {searchHist.length > 0 && (
              <div className="mt-1 a-rise">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-bold text-on">搜索历史</span>
                  <Button onClick={clearSearchHist} className="text-[12px] text-dim pressable">清空</Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2.5">
                  {searchHist.map((h) => (
                    <Button key={h} onClick={() => { setQ(h); submit(h); }} className="px-3.5 h-8 rounded-(--r-ctl) bg-s3 text-[13px] text-on/80 pressable">{h}</Button>
                  ))}
                </div>
              </div>
            )}

            <SearchTags key={JSON.stringify([lineEpoch, accountScope])} active={active} />
            <p className="mt-3 text-[12px] text-dim leading-relaxed">
              输入关键词后按回车搜索，也可以点上面的题材直接看片单。
            </p>
          </>
        ) : (
          <>
            <SegmentedControl className="mt-1 mb-3" aria-label="搜索结果类型" activeIndex={tab === "video" ? 0 : 1}>
              {([["video", "视频"], ["post", "帖子"]] as const).map(([k, label]) => (
                <Button aria-pressed={tab === k} key={k} onClick={() => changeTab(k)}>{label}</Button>
              ))}
            </SegmentedControl>
            <div role="status" className="text-[12px] text-mut mb-2.5" aria-live="polite">
              {loading && <span className="block">{request?.page === 1 ? `正在搜索「${submitted}」…` : "正在加载更多…"}</span>}
              {result && <>「{result.keyword}」已加载 <span className="text-primary font-bold">{count}{result.total !== null ? ` / ${result.total}` : ""}</span> 条{result.kind === "post" ? "帖子" : "视频"}</>}
            </div>
            {err && <div role="alert" className="flex flex-wrap items-center gap-2 mb-3 text-[13px] text-danger">
              <span>「{submitted}」{request?.page && request.page > 1 ? "加载更多失败" : "搜索失败"}：{err}</span>
              <Button onClick={results.retry} disabled={loading} className="px-3 text-primary">重试</Button>
            </div>}
            <section aria-label="搜索结果" aria-busy={loading}>
              {result && count > 0 ? <>
                {result.kind === "video" ? (
                  <Masonry videos={items} scopeKey={JSON.stringify([submitted, tab, result.keyword, result.kind])} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: items.map((x) => x.id), index: items.findIndex((x) => x.id === v.id), title: `搜索 · ${result.keyword}` })} />
                ) : (
                  <FilteredContent items={posts} scopeKey={JSON.stringify([submitted, tab, result.keyword, result.kind])}>{visible => <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
                    {visible.map((post) => (
                      <MediaCard key={post.id} title={post.title} cover={post.cover} subtitle={`${fmt(post.hot)} 次浏览`} onOpen={() => push({ kind: "post", id: post.id })} />
                    ))}
                  </div>}</FilteredContent>
                )}
                <div className="flex justify-center py-4">
                  {loading ? <Loader label="搜索结果更新中" className="w-6 h-6 spinner" />
                    : !err && result.keyword === submitted && (result.page < result.pages ? (
                      <Button onClick={results.loadMore} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on/85 pressable">加载更多</Button>
                    ) : <span className="text-[12px] text-dim">— 已经到底啦 —</span>)}
                </div>
              </> : loading ? (
                <div className="flex justify-center py-12"><Loader label="正在搜索" className="w-8 h-8 spinner" /></div>
              ) : !err && (
                <Empty icon={<ISearch size={26} />} title="没有找到相关内容" sub="换个关键词试试，比如「都市」「逆袭」"
                  action="看看热榜" onAction={() => push({ kind: "ranks" })} />
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/* ================= 排行榜 ================= */
const RANK_TABS = [
  { k: "hot", label: "热播榜", desc: "按热力指数排序" },
  { k: "recommend", label: "推荐榜", desc: "按推荐值排序" },
  { k: "potential", label: "潜力榜", desc: "按潜力值排序" },
] as const;

export function RankPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  type RankKind = typeof RANK_TABS[number]["k"];
  type RankState = { items: RankItem[]; loadedAt: number; loading: boolean; error: string };
  const [tab, setTab] = useState<RankKind>("hot");
  const [states, setStates] = useState<Partial<Record<RankKind, RankState>>>({});
  const cache = useRef<Partial<Record<RankKind, RankState>>>({});
  const pending = useRef(new Set<RankKind>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async (kind: RankKind) => {
    if (pending.current.has(kind)) return;
    pending.current.add(kind);
    const previous = cache.current[kind];
    const update = (state: RankState) => {
      cache.current[kind] = state;
      if (alive.current) setStates(current => ({ ...current, [kind]: state }));
    };
    update({ items: previous?.items ?? [], loadedAt: previous?.loadedAt ?? 0, loading: true, error: "" });
    try {
      const res = await api.rank(kind);
      update({ items: res?.items || [], loadedAt: Date.now(), loading: false, error: "" });
    } catch (error) {
      update({ items: previous?.items ?? [], loadedAt: previous?.loadedAt ?? 0, loading: false,
        error: error instanceof Error ? error.message : "榜单加载失败，请重试" });
    } finally { pending.current.delete(kind); }
  };
  useEffect(() => {
    if (!cache.current[tab]?.loadedAt || Date.now() - cache.current[tab]!.loadedAt > 60_000) void load(tab);
  }, [tab]);
  const state = states[tab];
  const items = state?.items ?? [];
  const loading = state?.loading ?? true;
  const err = state?.error ?? "";
  const max = Math.max(1, ...items.map((x) => x.metric_value || 0));
  const meta = RANK_TABS.find((t) => t.k === tab)!;

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 relative overflow-hidden bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(90% 120% at 100% 0%, var(--p-pc) 0%, transparent 60%)", opacity: 0.32 }} />
        <div className="relative pt-2 pb-4">
          <Button aria-label="返回" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <div className="mt-1 flex flex-wrap gap-2 items-end justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="w-9 h-9 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><ITrophy size={20} /></span>
                <h1 className="text-[24px] font-bold tracking-wide text-on">HGhubX 热榜</h1>
              </div>
              <div className="text-[12px] text-mut mt-1">{meta.desc}</div>
            </div>
            <Button aria-label="刷新榜单" disabled={loading} onClick={() => void load(tab)} className="ios-icon-button">
              {loading ? <Loader label="正在更新榜单" className="w-4 h-4" /> : <IRefresh size={18} />}
            </Button>
          </div>
          <SegmentedControl className="mt-3" aria-label="榜单类型" activeIndex={RANK_TABS.findIndex(item => item.k === tab)}>
            {RANK_TABS.map((t) => (
              <Button aria-pressed={tab === t.k} key={t.k} onClick={() => setTab(t.k)}>{t.label}</Button>
            ))}
          </SegmentedControl>
        </div>
      </div>

      <div className="flex-1 scroll-y px-3.5 pt-3 pb-8">
        {err && <div role="alert" className="flex flex-wrap items-center gap-2 mb-3 text-[13px] text-danger">
          <span>榜单加载失败：{err}{items.length > 0 ? "；已保留上次榜单" : ""}</span>
          <Button onClick={() => void load(tab)} disabled={loading} className="px-3 text-primary">重试</Button>
        </div>}
        <section aria-label={meta.label} aria-busy={loading}>
          {items.length > 0 ? <>
            {loading && <p role="status" className="text-[12px] text-mut mb-2">正在刷新，当前显示上次榜单…</p>}
            <FilteredContent items={items} scopeKey={tab}>{visible => visible.map((it) => (
              <RankRow key={`${it.video_id}-${it.rank}`} item={it} metricMax={max}
                onOpen={() => push({ kind: "feed", videoIds: items.map((x) => x.video_id), index: items.findIndex((x) => x.video_id === it.video_id), title: meta.label })} />
            ))}</FilteredContent>
          </> : loading ? (
            <div className="flex justify-center py-12"><Loader label="正在加载榜单" className="w-8 h-8 spinner" /></div>
          ) : !err && (
            <Empty icon={<ITrophy size={26} />} title="榜单暂时为空" sub="稍后再来看看，或者去首页刷刷推荐" />
          )}
        </section>
        {wide && <div className="h-2" />}
      </div>
    </div>
  );
}
