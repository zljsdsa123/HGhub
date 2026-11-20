import { Button, Form, Input, SegmentedControl, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useEffect, useRef, useState } from "react";
import { api, fmt, isMobile } from "../../shared/api/api";
import type { HotSearchVideo, Post, RankItem, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { MediaCard, Masonry, RankRow } from "../../shared/ui/cards";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { Empty } from "../../shared/ui/ui";
import { useSearchResults } from "./useSearchResults";
import { SearchTags } from "./SearchTags";
import { IBack, IChevR, IClose, IFireF, IPlayF, IRefresh, ISearch, ITrophy } from "../../shared/ui/icons";

export default function Search({ active, wide }: { active: boolean; wide: boolean }) {
  const { push, searchHist, addSearch, clearSearchHist, lineEpoch, accountScope } = useStore();
  const { preferences } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
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
  const [hotTagState, setHotTagState] = useState<{
    epoch: number;
    tags: Record<number, readonly string[]>;
    failed: number[];
    retry: number;
  }>({ epoch: lineEpoch, tags: {}, failed: [], retry: 0 });
  const hotBusy = useRef(false);
  const hotSeq = useRef(0);
  const hotEpoch = useRef(lineEpoch);
  const hotLoadedAt = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  /* 移动端进入搜索页不自动聚焦：iOS 会立刻弹键盘遮住内容（#20）。
     桌面端没有软键盘，聚焦便于直接打字。 */
  useEffect(() => {
    if (active && !isMobile) inputRef.current?.focus();
  }, [active]);

  const refreshHot = async (force = false) => {
    if (hotBusy.current && !force) return;
    const seq = ++hotSeq.current;
    const reqEpoch = hotEpoch.current;
    hotBusy.current = true;
    setHotLoading(true);
    setHotError(null);
    try {
      const res = await api.searchHot();
      if (!aliveRef.current || seq !== hotSeq.current || reqEpoch !== hotEpoch.current) return;
      setHotVideos(res.items);
      hotLoadedAt.current = Date.now();
    } catch (e) {
      if (!aliveRef.current || seq !== hotSeq.current || reqEpoch !== hotEpoch.current) return;
      setHotError(e instanceof Error ? e.message : "热搜榜加载失败，请重试");
    } finally {
      if (seq === hotSeq.current) {
        hotBusy.current = false;
        if (aliveRef.current) setHotLoading(false);
      }
    }
  };
  useEffect(() => {
    const epochChanged = hotEpoch.current !== lineEpoch;
    if (epochChanged) {
      hotEpoch.current = lineEpoch;
      hotLoadedAt.current = 0;
      hotBusy.current = false;
      setHotVideos([]);
      setHotError(null);
    }
    // 切换主导航时短暂复用榜单；手动刷新或切线路后重新获取官网内容。
    if (active && (epochChanged || Date.now() - hotLoadedAt.current > 60_000)) void refreshHot(epochChanged);
  }, [active, lineEpoch]);

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
  const currentHotTags = hotTagState.epoch === lineEpoch ? hotTagState.tags : {};
  const currentHotFailed = hotTagState.epoch === lineEpoch ? hotTagState.failed : [];
  const hotFailedSet = new Set(currentHotFailed);
  const missingHotIds = filtering
    ? hotVideos.map(v => v.video_id).filter(id => !(id in currentHotTags) && !hotFailedSet.has(id))
    : [];
  const missingHotKey = missingHotIds.join(",");
  const hotTagPending = filtering && missingHotIds.length > 0;

  /* 官网热搜 HTML 不含标签；仅在开启屏蔽规则时按当前线路并发补查详情标签，未核验前不提前展示。 */
  useEffect(() => {
    if (!active || querying || !filtering || !missingHotIds.length) return;
    let cancelled = false;
    const reqEpoch = lineEpoch;
    const queue = [...missingHotIds];
    const loaded: Record<number, readonly string[]> = {};
    const failed: number[] = [];
    const worker = async () => {
      while (!cancelled && queue.length > 0) {
        const id = queue.shift()!;
        try {
          const detail = await api.video(id);
          if (detail && typeof detail === "object") loaded[id] = Array.isArray(detail.tags) ? detail.tags : [];
          else failed.push(id);
        } catch {
          failed.push(id);
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker())).then(() => {
      if (cancelled || !aliveRef.current || hotEpoch.current !== reqEpoch) return;
      setHotTagState(prev => {
        const baseTags = prev.epoch === reqEpoch ? prev.tags : {};
        const baseFailed = prev.epoch === reqEpoch ? prev.failed : [];
        const nextTags = { ...baseTags, ...loaded };
        const nextFailed = [...new Set([...baseFailed.filter(id => !(id in nextTags)), ...failed])];
        return { epoch: reqEpoch, tags: nextTags, failed: nextFailed, retry: prev.retry };
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, querying, filtering, lineEpoch, missingHotKey, hotTagState.retry]);

  const verifiedHotVideos = filtering
    ? hotVideos.filter(v => v.video_id in currentHotTags).map(v => ({ ...v, tags: currentHotTags[v.video_id] }))
    : hotVideos.map(v => ({ ...v, tags: undefined as readonly string[] | undefined }));

  const renderHotList = (list: typeof verifiedHotVideos) => list.length > 0 ? (
    <ol className="ios-search-hot-grid mt-3" aria-busy={hotLoading || hotTagPending}>
      {list.map((video, i) => (
        <li key={video.video_id} className="min-w-0">
          <Button aria-label={`播放 ${video.title}`} title={video.title} className="ios-search-hot-item"
            onClick={() => push({ kind: "feed", videoIds: list.map(item => item.video_id), index: i, title: "热搜榜" })}>
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
  ) : null;

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-page-heading shrink-0"><h1 className="ios-page-title">搜索</h1></div>
      {/* 搜索栏 */}
      <div className="shrink-0 pb-3 flex items-center gap-2.5" >
        <Form className="ios-search-form flex-1 min-w-0 flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); submit(q); }}>
          <ISearch size={17} className="text-mut shrink-0" />
          <Input aria-label="搜索短剧、帖子、题材…" ref={inputRef} value={q}
            onChange={(e) => {
              const next = e.target.value;
              setQ(next);
              if (!next && submitted) { setSubmitted(""); results.clear(); }
            }}
            placeholder="搜索短剧、帖子、题材…"
            className="flex-1 min-w-0 bg-transparent text-[14px] text-on placeholder-dim outline-none" />
          {(q || submitted) && <Button aria-label="清空搜索" type="button" onClick={() => { results.clear(); setQ(""); setSubmitted(""); inputRef.current?.focus(); }} className="ios-icon-button ios-search-clear"><IClose size={16} /></Button>}
        </Form>
        <Button onClick={() => push({ kind: "ranks" })} aria-label="排行榜"
          variant="primary" className="ios-icon-button ios-search-shortcut">
          <ITrophy size={19} />
        </Button>
      </div>

      <div className="flex-1 scroll-y pb-24">
        {!querying ? (
          <>
            <Surface role="region" aria-label="热搜榜" className="mt-1 rounded-(--r-md) bg-s2 p-3.5 a-rise">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-on/90"><IFireF size={15} className="text-primary" />热搜榜</h2>
                  <Button onClick={() => void refreshHot()} disabled={hotLoading} aria-label="刷新热搜榜"
                    className="-mr-2 px-2 inline-flex items-center justify-end gap-1 text-[12px] text-mut pressable">
                    {hotLoading ? <Loader className="w-3 h-3" /> : <IRefresh size={12} />}{hotLoading ? "刷新中" : "刷新"}
                  </Button>
                </div>
                {hotError && <p role="status" className="mt-2 text-[12px] text-mut leading-relaxed">
                  {hotVideos.length > 0 ? "刷新失败，保留上次榜单。" : "热搜榜暂不可用。"}{hotError}
                </p>}
                {hotVideos.length > 0 ? (
                  filtering ? (
                    <>
                      {hotTagPending && !verifiedHotVideos.length && (
                        <p role="status" className="mt-3 text-[12px] text-mut">正在按屏蔽偏好核验热搜榜…</p>
                      )}
                      {verifiedHotVideos.length > 0 && (
                        <FilteredContent items={verifiedHotVideos} scopeKey={`hot:${lineEpoch}`} className="mt-3 mb-0 bg-s3/80">
                          {visible => renderHotList(visible)}
                        </FilteredContent>
                      )}
                      {!hotTagPending && currentHotFailed.length > 0 && (
                        <div role="status" className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[12px] text-mut">
                          <span>{currentHotFailed.length} 条热搜未能核验标签，已暂缓展示</span>
                          <Button onClick={() => setHotTagState(prev => ({
                            epoch: lineEpoch,
                            tags: prev.epoch === lineEpoch ? prev.tags : {},
                            failed: [],
                            retry: prev.retry + 1,
                          }))} className="-mr-2 px-2 min-h-9 inline-flex items-center text-primary">重试核验</Button>
                        </div>
                      )}
                    </>
                  ) : renderHotList(verifiedHotVideos)
                ) : !hotError && <p role="status" className="mt-3 text-[12px] text-mut">{hotLoading ? "加载中…" : "暂无热搜影片"}</p>}
              </Surface>

            {searchHist.length > 0 && (
              <Surface role="region" aria-label="搜索历史" className="mt-4 rounded-(--r-md) bg-s2 p-3.5 a-rise">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-[14px] font-semibold text-on/90">搜索历史</h2>
                  <Button onClick={clearSearchHist} className="-mr-2 px-2 inline-flex items-center justify-end text-[12px] text-mut pressable">清空</Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  {searchHist.map((h) => (
                    <Button key={h} onClick={() => { setQ(h); submit(h); }} className="ios-filter-pill text-on/90">{h}</Button>
                  ))}
                </div>
              </Surface>
            )}

            <SearchTags key={JSON.stringify([lineEpoch, accountScope])} active={active} />
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
                  <Masonry videos={items} scopeKey={JSON.stringify([submitted, tab, result.keyword, result.kind])} wide={wide} onOpen={(v, visible) => push({ kind: "feed", videoIds: visible.map((x) => x.id), index: visible.findIndex((x) => x.id === v.id), title: `搜索 · ${result.keyword}` })} />
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
                  action="看看排行榜" onAction={() => push({ kind: "ranks" })} />
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
  { k: "hot", label: "热播榜" },
  { k: "recommend", label: "推荐榜" },
  { k: "potential", label: "潜力榜" },
] as const;

export function RankPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, lineEpoch } = useStore();
  type RankKind = typeof RANK_TABS[number]["k"];
  type RankState = { items: RankItem[]; loadedAt: number; loading: boolean; error: string };
  const [tab, setTab] = useState<RankKind>("hot");
  const [states, setStates] = useState<Partial<Record<RankKind, RankState>>>({});
  const cache = useRef<Partial<Record<RankKind, RankState>>>({});
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  const epochRef = useRef(lineEpoch);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async (kind: RankKind) => {
    const reqEpoch = epochRef.current;
    const inflightKey = `${reqEpoch}:${kind}`;
    if (pending.current.has(inflightKey)) return;
    pending.current.add(inflightKey);
    const previous = cache.current[kind];
    const update = (state: RankState) => {
      cache.current[kind] = state;
      if (alive.current) setStates(current => ({ ...current, [kind]: state }));
    };
    update({ items: previous?.items ?? [], loadedAt: previous?.loadedAt ?? 0, loading: true, error: "" });
    try {
      const res = await api.rank(kind);
      if (reqEpoch !== epochRef.current) return;
      update({ items: res?.items || [], loadedAt: Date.now(), loading: false, error: "" });
    } catch (error) {
      if (reqEpoch !== epochRef.current) return;
      update({ items: previous?.items ?? [], loadedAt: previous?.loadedAt ?? 0, loading: false,
        error: error instanceof Error ? error.message : "榜单加载失败，请重试" });
    } finally { pending.current.delete(inflightKey); }
  };
  useEffect(() => {
    if (epochRef.current !== lineEpoch) {
      epochRef.current = lineEpoch;
      cache.current = {};
      pending.current.clear();
      setStates({});
    }
    if (!cache.current[tab]?.loadedAt || Date.now() - cache.current[tab]!.loadedAt > 60_000) void load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, lineEpoch]);
  const state = states[tab];
  const items = state?.items ?? [];
  const loading = state?.loading ?? true;
  const err = state?.error ?? "";
  const max = Math.max(1, ...items.map((x) => x.metric_value || 0));
  const meta = RANK_TABS.find((t) => t.k === tab)!;

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-subpage-header shrink-0 relative overflow-hidden" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(90% 120% at 100% 0%, var(--p-pc) 0%, transparent 60%)", opacity: 0.32 }} />
        <div className="ios-subpage-inner relative">
          <div className="ios-subpage-bar">
            <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
            <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><ITrophy size={19} /></span>
            <div className="flex-1 min-w-0">
              <h1 className="text-[17px] font-bold text-on leading-tight">排行榜</h1>
              <div className="text-[12px] text-mut leading-tight mt-0.5">{meta.label}{items.length ? ` · TOP ${items.length}` : ""}</div>
            </div>
            <Button aria-label="刷新榜单" disabled={loading} onClick={() => void load(tab)} className="ios-nav-btn">
              {loading ? <Loader label="正在更新榜单" className="w-4 h-4" /> : <IRefresh size={18} />}
            </Button>
          </div>
          <SegmentedControl className="mb-3" aria-label="榜单类型" activeIndex={RANK_TABS.findIndex(item => item.k === tab)}>
            {RANK_TABS.map((t) => (
              <Button aria-pressed={tab === t.k} key={t.k} onClick={() => setTab(t.k)}>{t.label}</Button>
            ))}
          </SegmentedControl>
        </div>
      </div>

      <div className="flex-1 scroll-y pt-3.5 pb-8">
        {err && <div role="alert" className="flex flex-wrap items-center gap-2 mb-3 text-[13px] text-danger">
          <span>榜单加载失败：{err}{items.length > 0 ? "；已保留上次榜单" : ""}</span>
          <Button onClick={() => void load(tab)} disabled={loading} className="px-3 text-primary">重试</Button>
        </div>}
        <section aria-label={meta.label} aria-busy={loading}>
          {items.length > 0 ? <>
            {loading && <p role="status" className="text-[12px] text-mut mb-2">正在刷新，当前显示上次榜单…</p>}
            <FilteredContent items={items} scopeKey={tab}>{visible => visible.map((it) => (
              <RankRow key={`${it.video_id}-${it.rank}`} item={it} metricMax={max}
                onOpen={() => push({ kind: "feed", videoIds: visible.map((x) => x.video_id), index: visible.findIndex((x) => x.video_id === it.video_id), title: meta.label })} />
            ))}</FilteredContent>
          </> : loading ? (
            <div className="flex justify-center py-12"><Loader label="正在加载榜单" className="w-8 h-8 spinner" /></div>
          ) : !err && (
            <Empty icon={<ITrophy size={26} />} title="榜单暂时为空" />
          )}
        </section>
        {wide && <div className="h-2" />}
      </div>
    </div>
  );
}
