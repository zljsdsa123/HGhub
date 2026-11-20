import { Button, SegmentedControl, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, APP_VERSION, fmt, isMobile, platform } from "../../shared/api/api";
import type { Detail, Post } from "../../shared/api/types";
import { detailEpisodeCount, formatWatchProgress, resolveResumeTarget, unwatchedNewEpisodes } from "../../shared/model/favoriteProgress";
import { useStore } from "../../shared/model/store";
import { Avatar, Empty, Modal } from "../../shared/ui/ui";
import { MediaCard } from "../../shared/ui/cards";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { CollectionLink, CollectionLinks } from "../../shared/ui/CollectionLink";
import { IChevR, IClock, IHeart, ILogout, ISettings, IStar, IUser, IUserF } from "../../shared/ui/icons";

/* Account changes discard cached details synchronously, before another account can paint. */
export default function Profile({ wide, active = true }: { wide: boolean; active?: boolean }) {
  const { accountScope, lineEpoch } = useStore();
  return <ProfileContent key={`${accountScope}:${lineEpoch}`} wide={wide} active={active} />;
}

function ProfileContent({ wide, active }: { wide: boolean; active: boolean }) {
  const { blockReason } = useContentPreferences();
  const {
    user, setLoginOpen, logout, history, favs, postFavs, favEpCounts,
    seedFavoriteEpisodes, ackFavoriteEpisodes, setCollected, toast,
    clearHistory, removeHistory, push, accountSync, syncAccount, accountGeneration,
  } = useStore();
  const [tab, setTab] = useState<"fav" | "history">("fav");
  const [favKind, setFavKind] = useState<"video" | "post">("video");
  const [videoCache, setVideoCache] = useState<Record<number, Detail>>({});
  const videoCacheRef = useRef(videoCache);
  videoCacheRef.current = videoCache;
  const refreshedFavorites = useRef(new Set<number>());
  const [postCache, setPostCache] = useState<Record<number, Post>>({});
  const postCacheRef = useRef(postCache);
  postCacheRef.current = postCache;
  const [limits, setLimits] = useState({ favVideo: 12, favPost: 12, history: 12 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [failedIds, setFailedIds] = useState<number[]>([]);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const logoutPending = useRef(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState("");
  const clearing = useRef(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const removalPending = useRef(false);
  const [blockedPrompt, setBlockedPrompt] = useState<{
    id: number; kind: "video" | "post"; reason: string; removableFav: boolean;
  } | null>(null);
  const [removingBlocked, setRemovingBlocked] = useState(false);
  const mounted = useRef(true);
  const actionRevision = useRef(0);
  useLayoutEffect(() => {
    mounted.current = true;
    const invalidate = () => { actionRevision.current++; };
    window.addEventListener("hg:line-changed", invalidate);
    window.addEventListener("hg:proxy-changed", invalidate);
    return () => {
      mounted.current = false;
      invalidate();
      window.removeEventListener("hg:line-changed", invalidate);
      window.removeEventListener("hg:proxy-changed", invalidate);
    };
  }, []);

  const showingPosts = tab === "fav" && favKind === "post";
  const selectionMode = selectedIds.length > 0;
  const limitKey = tab === "history" ? "history" : showingPosts ? "favPost" : "favVideo";
  const ids = tab === "history" ? history.map((h) => h.id) : showingPosts ? postFavs : favs;
  const visibleIds = ids.slice(0, limits[limitKey]);
  const hasMore = visibleIds.length < ids.length;
  const videoCards = !showingPosts ? visibleIds.map(id => videoCache[id]).filter((card): card is Detail => !!card) : [];
  const postCards = showingPosts ? visibleIds.map(id => postCache[id]).filter((card): card is Post => !!card) : [];
  const cardsCount = showingPosts ? postCards.length : videoCards.length;
  const failed = failedIds.filter(id => visibleIds.includes(id));
  const idsKey = visibleIds.join(",");
  const favoriteStateUnknown = tab === "fav" && !!user && !accountSync.favoritesKnown && favs.length === 0 && postFavs.length === 0;
  const favoriteSyncFailed = favoriteStateUnknown && !accountSync.busy;
  const syncingFavorites = favoriteStateUnknown && !favoriteSyncFailed;
  /** 观看记录里这条的进度（我的收藏与观看历史共享） */
  const progressOf = (id: number) => history.find((h) => h.id === id);

  useEffect(() => {
    if (!favs.length) return;
    const toSeed: Record<number, number> = {};
    for (const id of favs) {
      if (favEpCounts[id] !== undefined) continue;
      const detail = videoCache[id];
      if (!detail) continue;
      const latest = detailEpisodeCount(detail);
      if (latest <= 0) continue;
      const unwatched = unwatchedNewEpisodes(detail, history.find(h => h.id === id), undefined);
      toSeed[id] = Math.max(1, latest - unwatched);
    }
    if (Object.keys(toSeed).length > 0) seedFavoriteEpisodes(toSeed);
  }, [favs, videoCache, history, favEpCounts, seedFavoriteEpisodes]);

  const updatedFavCount = tab === "fav" && favKind === "video"
    ? videoCards.reduce((count, c) => (
      !blockReason(c.tags) && unwatchedNewEpisodes(c, progressOf(c.id), favEpCounts[c.id]) > 0 ? count + 1 : count
    ), 0)
    : 0;

  useEffect(() => {
    if (!active) { refreshedFavorites.current.clear(); return; }
    let alive = true;
    const refreshFavorites = tab === "fav" && !showingPosts;
    const missing = showingPosts
      ? visibleIds.filter(id => !postCacheRef.current[id])
      : visibleIds.filter(id => !videoCacheRef.current[id] || (refreshFavorites && !refreshedFavorites.current.has(id)));
    setFailedIds([]);
    if (!missing.length) { setLoading(false); return; }
    setLoading(true);
    if (showingPosts) {
      Promise.allSettled(missing.map(id => api.post(id)))
        .then(results => {
          if (!alive) return;
          const loaded: Record<number, Post> = {};
          const failedList: number[] = [];
          results.forEach((result, index) => {
            if (result.status === "fulfilled" && result.value) loaded[missing[index]] = result.value;
            else failedList.push(missing[index]);
          });
          setPostCache(previous => ({ ...previous, ...loaded }));
          setFailedIds(failedList);
          setLoading(false);
        });
    } else {
      void (async () => {
        const failedList: number[] = [];
        // Keep existing cards visible while revalidating. Limit concurrent reads
        // when returning to a list that had already loaded several pages.
        for (let offset = 0; offset < missing.length; offset += 6) {
          const batch = missing.slice(offset, offset + 6);
          const results = await Promise.allSettled(batch.map(id => api.video(id)));
          if (!alive) return;
          const loaded: Record<number, Detail> = {};
          results.forEach((result, index) => {
            const id = batch[index];
            if (result.status === "fulfilled" && result.value) {
              loaded[id] = result.value;
              if (refreshFavorites) refreshedFavorites.current.add(id);
            } else if (!videoCacheRef.current[id]) failedList.push(id);
          });
          setVideoCache(previous => ({ ...previous, ...loaded }));
        }
        setFailedIds(failedList);
        setLoading(false);
      })();
    }
    return () => { alive = false; };
  }, [active, idsKey, tab, showingPosts, reload]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const scroller = scrollRef.current;
    if (!active || !hasMore || loading || !sentinel || !scroller) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting) return;
      observer.disconnect();
      setLimits(previous => ({ ...previous, [limitKey]: previous[limitKey] + 12 }));
    }, { root: scroller, rootMargin: "300px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [active, hasMore, limitKey, loading, visibleIds.length]);

  const confirmLogout = async () => {
    if (logoutPending.current) return;
    logoutPending.current = true;
    setLogoutBusy(true);
    setLogoutError("");
    try {
      await logout();
      if (mounted.current) setLogoutOpen(false);
    } catch (error) {
      if (mounted.current) setLogoutError(error instanceof Error ? error.message : "退出失败，请重试");
    } finally {
      logoutPending.current = false;
      if (mounted.current) setLogoutBusy(false);
    }
  };

  const clearWatchHistory = async () => {
    if (clearing.current) return;
    clearing.current = true;
    setClearBusy(true); setClearError("");
    try {
      await clearHistory();
      if (mounted.current) setClearOpen(false);
    } catch (error) {
      if (mounted.current) setClearError(error instanceof Error ? error.message : "清空失败，观看记录已保留，请重试");
    } finally {
      clearing.current = false;
      if (mounted.current) setClearBusy(false);
    }
  };

  const toggleSelection = (id: number) => {
    setSelectedIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  };
  const beginSelection = (id: number) => {
    setSelectedIds(current => current.includes(id) ? current : [...current, id]);
  };
  const confirmRemoveSelected = async () => {
    if (removalPending.current || !selectedIds.length) return;
    const generation = accountGeneration();
    const revision = actionRevision.current;
    const current = () => mounted.current && accountGeneration() === generation && actionRevision.current === revision;
    removalPending.current = true;
    setRemoving(true); setRemoveError("");
    const targets = [...selectedIds];
    try {
      if (!current()) return;
      if (tab === "history") {
        await removeHistory(targets);
        if (!current()) return;
      } else {
        const failed: number[] = [];
        for (const id of targets) {
          if (!current()) return;
          try {
            await setCollected(showingPosts ? "post" : "video", id, false);
            if (!current()) return;
          } catch {
            if (!current()) return;
            failed.push(id);
          }
        }
        if (failed.length) {
          if (!current()) return;
          setSelectedIds(failed);
          throw new Error(failed.length === targets.length ? "移除失败，请重试" : `已移除 ${targets.length - failed.length} 项，${failed.length} 项失败，请重试`);
        }
      }
      if (current()) {
        setSelectedIds([]);
        setRemoveOpen(false);
        toast(tab === "history" ? `已删除 ${targets.length} 条观看历史` : `已取消收藏 ${targets.length} 项`, "info");
      }
    } catch (error) {
      if (current()) setRemoveError(error instanceof Error ? error.message : "移除失败，请重试");
    } finally {
      removalPending.current = false;
      if (current()) setRemoving(false);
    }
  };

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-page-heading shrink-0 flex items-center">
        <h1 className="ios-page-title text-on">我的</h1>
        {isMobile && (
          <Button onClick={() => push({ kind: "settings" })} aria-label="设置"
            className="ios-icon-button ml-auto">
            <ISettings size={17} strokeWidth={1.7} />
          </Button>
        )}
      </div>

      <div ref={scrollRef} className="ios-page-body flex-1 scroll-y pt-2 pb-24">
        {/* 资料卡：已登录 / 未登录（点开登录抽屉） */}
        {user ? (
          <Surface className="ios-account-card flex items-center gap-3.5 a-rise">
            <Avatar size={56} name={user.nickname} hue={280} ring />
            <div className="flex-1 min-w-0">
              <div className="text-[16px] font-bold text-on truncate">{user.nickname}</div>
              <div className="text-[12px] text-mut mt-0.5">@{user.username} · ID {user.id}</div>
              <div className="flex gap-3 mt-2 text-[12px] text-mut">
                <span>点赞 <b className="text-on">{fmt(user.counts?.like)}</b></span>
                <span>收藏 <b className="text-on">{fmt(user.counts?.collect)}</b></span>
                <span>关注 <b className="text-on">{fmt(user.counts?.following)}</b></span>
              </div>
            </div>
            <Button onClick={() => { setLogoutError(""); setLogoutOpen(true); }}
              className="ios-icon-button" aria-label="退出登录">
              <ILogout size={17} />
            </Button>
          </Surface>
        ) : (
          <Button onClick={() => setLoginOpen(true)}
            className="ios-account-card w-full text-left flex items-center gap-3.5 pressable a-rise">
            <Avatar size={56} icon={<IUser size={26} />} hue={220} ring />
            <div className="flex-1 min-w-0">
              <div className="text-[16px] font-bold text-on">未登录</div>
              <div className="text-[12px] text-mut mt-0.5">登录后查看账号收藏、关注和观看记录</div>
              <div className="flex gap-3 mt-2 text-[12px] text-mut">
                <span>收藏 <b className="text-on">{favs.length + postFavs.length}</b></span>
                <span>观看 <b className="text-on">{history.length}</b></span>
              </div>
            </div>
            <span className="inline-flex items-center gap-0.5 h-9 pl-3.5 pr-2.5 rounded-full bg-primary text-on-primary text-[13px] font-semibold shrink-0">
              登录<IChevR size={14} />
            </span>
          </Button>
        )}

        {user && accountSync.error && <div role="alert" className="mt-3 rounded-(--r-sm) bg-s3 px-3.5 py-3 text-[13px] flex flex-wrap items-center justify-between gap-2">
          <p className="text-danger break-words flex-1 min-w-[200px]">{accountSync.error}</p>
          <Button disabled={accountSync.busy} onClick={() => { void syncAccount({ manual: true }).catch(() => {}); }}
            className="inline-flex items-center min-h-9 -mx-2 px-2 text-primary font-semibold shrink-0">{accountSync.busy ? "正在重试…" : "重试同步"}</Button>
        </div>}

        {/* 关注 / 我的主页 */}
        {user && (
          <CollectionLinks className="ios-profile-links mt-4">
            <CollectionLink icon={<IHeart size={18} />} title="我的关注"
              onClick={() => push({ kind: "following" })} />
            <CollectionLink icon={<IUserF size={18} />} title="我的主页"
              onClick={() => push({ kind: "user", id: user.id, name: user.nickname })} />
          </CollectionLinks>
        )}

        {/* 我的内容 */}
        <SegmentedControl className="mt-4" aria-label="我的内容" activeIndex={tab === "fav" ? 0 : 1}>
          {([["fav", "我的收藏"], ["history", "观看历史"]] as const).map(([k, l]) => (
            <Button aria-pressed={tab === k} key={k} onClick={() => { setTab(k); setSelectedIds([]); }}>{l}</Button>
          ))}
        </SegmentedControl>

        {tab === "fav" && !favoriteStateUnknown && (favs.length > 0 || postFavs.length > 0 || favKind === "post") && (
          <div className="mt-2.5 flex items-center gap-2" role="group" aria-label="收藏内容类型">
            <Button aria-pressed={favKind === "video"} onClick={() => { setFavKind("video"); setSelectedIds([]); }} className="ios-filter-pill">
              短剧{favs.length ? ` ${favs.length}` : ""}
            </Button>
            <Button aria-pressed={favKind === "post"} onClick={() => { setFavKind("post"); setSelectedIds([]); }} className="ios-filter-pill">
              帖子{postFavs.length ? ` ${postFavs.length}` : ""}
            </Button>
            {updatedFavCount > 0 && (
              <span role="status" className="ml-auto text-[12px] font-semibold text-primary">
                {updatedFavCount} 部有新集
              </span>
            )}
          </div>
        )}

        {selectionMode && <div role="region" aria-label="批量管理" className="sticky top-0 z-20 -mx-1 mt-2 flex items-center gap-2 bg-bg/95 px-1 py-2 text-[13px] backdrop-blur">
          <span className="font-semibold text-on">已选 {selectedIds.length} 项</span>
          <Button className="ml-auto px-2 text-primary" onClick={() => { setSelectedIds([]); setRemoveError(""); }}>取消</Button>
          <Button variant="danger" className="rounded-(--r-ctl) px-3" onClick={() => { setRemoveError(""); setRemoveOpen(true); }}>移除</Button>
        </div>}

        <div className="mt-3" aria-busy={loading || syncingFavorites}>
          {favoriteSyncFailed ? (
            <Empty icon={<IStar size={24} />} title="收藏状态未知"
              sub="账号同步未完成，暂时无法确认收藏内容。" action="重试"
              onAction={() => { void syncAccount({ manual: true }).catch(() => {}); }} />
          ) : syncingFavorites ? (
            <FavoriteSyncState wide={wide} />
          ) : loading && !cardsCount ? (
            <div className="flex justify-center py-8"><Loader className="w-7 h-7 spinner" /></div>
          ) : showingPosts && postCards.length ? (
            <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
              {postCards.map((p) => {
                const reason = blockReason(p.tags);
                return <MediaCard key={p.id} blockedReason={reason} title={p.title} cover={p.cover}
                  subtitle={p.tags?.slice(0, 2).join(" · ") || `${fmt(p.hot)} 次浏览`}
                  selectionMode={selectionMode} selected={selectedIds.includes(p.id)} onLongPress={() => beginSelection(p.id)}
                  onOpen={() => {
                    if (selectionMode) { toggleSelection(p.id); return; }
                    if (reason) setBlockedPrompt({ id: p.id, kind: "post", reason, removableFav: true });
                    else push({ kind: "post", id: p.id });
                  }} />;
              })}
            </div>
          ) : !showingPosts && videoCards.length ? (
            <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
              {videoCards.map((c) => {
                const progress = progressOf(c.id);
                const reason = blockReason(c.tags);
                const latestCount = detailEpisodeCount(c);
                const unwatchedNew = tab === "fav" ? unwatchedNewEpisodes(c, progress, favEpCounts[c.id]) : 0;
                const tagLine = c.tags?.slice(0, 2).join(" · ");
                const subtitle = unwatchedNew > 0
                  ? [c.is_finished ? `全 ${latestCount} 集` : `更新至 ${latestCount} 集`, tagLine].filter(Boolean).join(" · ")
                  : tagLine;
                return <MediaCard key={c.id} blockedReason={reason} title={c.title} cover={c.cover} score={c.score}
                  badge={unwatchedNew > 0 ? `新更 ${unwatchedNew} 集` : (c.is_finished ? "已完结" : `${latestCount || c.episode_count} 集`)}
                  badgeTone={unwatchedNew > 0 ? "update" : "default"}
                  subtitle={subtitle}
                  progress={formatWatchProgress(progress, latestCount, c.is_finished)}
                  selectionMode={selectionMode} selected={selectedIds.includes(c.id)} onLongPress={() => beginSelection(c.id)}
                  onOpen={() => {
                    if (selectionMode) { toggleSelection(c.id); return; }
                    if (reason) {
                      setBlockedPrompt({ id: c.id, kind: "video", reason, removableFav: tab === "fav" });
                      return;
                    }
                    if (tab === "fav" && unwatchedNew > 0 && latestCount > 0 && (progress?.ep ?? 0) < (favEpCounts[c.id] ?? latestCount)) {
                      ackFavoriteEpisodes(c.id, latestCount);
                    }
                    const playableIds = ids.filter(id => {
                      const cached = videoCache[id];
                      return !cached || !blockReason(cached.tags);
                    });
                    const targetIndex = Math.max(0, playableIds.indexOf(c.id));
                    const resume = resolveResumeTarget(c, progress);
                    push({
                      kind: "feed", videoIds: playableIds, index: targetIndex,
                      title: tab === "fav" ? "我的收藏" : "观看历史", startEp: resume.startEp, startTime: resume.startTime,
                    });
                  }} />;
              })}
            </div>
          ) : failed.length ? (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? "收藏加载失败" : "观看记录加载失败"}
              sub="记录仍在，重试后继续浏览。" action="重试" onAction={() => setReload(n => n + 1)} />
          ) : showingPosts ? (
            <Empty icon={<IStar size={24} />} title="还没有收藏帖子"
              sub="在吃瓜页面点收藏，之后就能在这里找到"
              action="去看吃瓜" onAction={() => push({ kind: "posts" })} />
          ) : (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? "还没有收藏" : "还没有观看记录"}
              sub={tab === "fav" ? "在剧集页点收藏，之后就能在这里找到" : "看过的剧集会出现在这里"}
              action="去逛逛" onAction={() => push({ kind: "ranks" })} />
          )}
          {cardsCount > 0 && failed.length > 0 && <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-mut">
            <span>{failed.length} 项内容加载失败，已加载内容仍可浏览。</span>
            <Button disabled={loading} onClick={() => setReload(n => n + 1)} className="px-3 text-primary">重试失败内容</Button>
          </div>}
          {cardsCount > 0 && loading && <div className="flex justify-center py-3"><Loader label="加载更多内容" /></div>}
          {ids.length > 0 && <p role="status" className="mt-3 text-[12px] text-mut">已显示 {cardsCount} / {ids.length} 项{user ? "账号记录" : "本机记录"}</p>}
          {hasMore && <div ref={sentinelRef} className="h-4" aria-hidden="true" />}
          {tab === "history" && history.length > 0 && (
            <Button disabled={clearBusy} aria-busy={clearBusy} onClick={() => { setClearError(""); setClearOpen(true); }} className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-mut pressable">{clearBusy ? "正在清空…" : "清空观看历史"}</Button>
          )}
          {clearError && !clearOpen && <p role="alert" className="mt-2 text-[13px] text-danger">{clearError}</p>}
        </div>

        <div className="text-center text-[12px] text-dim mt-5">HGhubX {APP_VERSION} · {platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} 客户端</div>
      </div>
      <Modal open={removeOpen} onClose={() => { if (!removalPending.current) setRemoveOpen(false); }} label="批量移除">
        <div className="p-5">
          <h2 className="text-[18px] font-bold">{tab === "history" ? "删除所选观看历史" : "取消收藏所选内容"}</h2>
          <p className="mt-2 text-[14px] text-mut">
            {tab === "history"
              ? `确认删除选中的 ${selectedIds.length} 条观看历史？收藏不会受影响。`
              : `确认取消收藏选中的 ${selectedIds.length} 项内容？观看历史不会受影响。`}
            {user ? "当前账号的云端数据与本机缓存都会更新。" : "此操作只会修改本机记录。"}
          </p>
          {removeError && <p role="alert" className="mt-3 text-[13px] text-danger">{removeError}</p>}
          <div className="mt-4 flex gap-3">
            <Button variant="secondary" disabled={removing} onClick={() => setRemoveOpen(false)} className="flex-1">取消</Button>
            <Button variant="danger" disabled={removing || !selectedIds.length} aria-busy={removing} onClick={() => void confirmRemoveSelected()} className="flex-1 rounded-(--r-ctl) px-3">
              {removing ? "正在移除…" : "确认移除"}
            </Button>
          </div>
        </div>
      </Modal>
      <Modal open={!!blockedPrompt} onClose={() => { if (!removingBlocked) setBlockedPrompt(null); }} label="内容已屏蔽">
        {blockedPrompt && (
          <div className="p-5">
            <h2 className="text-[18px] font-bold">该内容命中屏蔽规则</h2>
            <p className="mt-2 text-[14px] text-mut break-words">{blockedPrompt.reason}。你可以在内容偏好中调整屏蔽标签{blockedPrompt.removableFav ? "，或将此内容移出收藏" : ""}。</p>
            <div className="mt-4 flex flex-wrap gap-2.5">
              <Button variant="secondary" disabled={removingBlocked} onClick={() => setBlockedPrompt(null)} className="flex-1">关闭</Button>
              {blockedPrompt.removableFav && (
                <Button variant="danger" disabled={removingBlocked} onClick={() => {
                  setRemovingBlocked(true);
                  void setCollected(blockedPrompt.kind, blockedPrompt.id, false)
                    .then(() => { if (mounted.current) { setBlockedPrompt(null); toast("已取消收藏", "info"); } })
                    .catch(e => { if (mounted.current) toast(e instanceof Error ? e.message : "操作失败", "info"); })
                    .finally(() => { if (mounted.current) setRemovingBlocked(false); });
                }} className="flex-1 rounded-(--r-ctl) px-3">
                  {removingBlocked ? "处理中…" : "取消收藏"}
                </Button>
              )}
              <Button variant="primary" disabled={removingBlocked} onClick={() => {
                setBlockedPrompt(null);
                push({ kind: "settings", section: "内容偏好" });
              }} className="w-full rounded-(--r-ctl) min-h-11 px-4 font-semibold">
                管理屏蔽标签
              </Button>
            </div>
          </div>
        )}
      </Modal>
      <Modal open={logoutOpen} onClose={() => { if (!logoutPending.current) setLogoutOpen(false); }} label="退出登录">
        <div className="p-5">
          <h2 className="text-[18px] font-bold">退出登录</h2>
          <p className="mt-2 text-[14px] text-mut">退出当前账户？账号数据和本机进度会保留，退出后显示游客的本机记录。</p>
          {logoutError && <p role="alert" className="mt-3 text-[13px] text-danger">{logoutError}</p>}
          <div className="mt-4 flex gap-3">
            <Button variant="secondary" disabled={logoutBusy} onClick={() => setLogoutOpen(false)} className="flex-1">取消</Button>
            <Button variant="danger" disabled={logoutBusy} onClick={() => void confirmLogout()} className="flex-1 rounded-(--r-ctl) px-3">
              {logoutBusy ? "正在退出…" : "确认退出"}
            </Button>
          </div>
        </div>
      </Modal>
      <Modal open={clearOpen} onClose={() => { if (!clearing.current) setClearOpen(false); }} label="清空观看历史">
        <div className="p-5">
          <h2 className="text-[18px] font-bold">清空观看历史</h2>
          <p className="mt-2 text-[14px] text-mut">确认清空全部观看历史？{user ? "当前账号的云端观看历史与本机缓存都会被清除。" : "本机游客观看历史会被清除。"}此操作无法撤销，收藏不会受影响。</p>
          {clearError && <p role="alert" className="mt-3 text-[13px] text-danger">{clearError}</p>}
          <div className="mt-4 flex gap-3">
            <Button variant="secondary" disabled={clearBusy} onClick={() => setClearOpen(false)} className="flex-1">取消</Button>
            <Button variant="danger" disabled={clearBusy} aria-busy={clearBusy} onClick={() => void clearWatchHistory()} className="flex-1 rounded-(--r-ctl) px-3">
              {clearBusy ? "正在清空…" : "确认清空"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function FavoriteSyncState({ wide }: { wide: boolean }) {
  return <>
    <div role="status" aria-live="polite" aria-label="正在同步收藏"
      className="mb-4 flex items-center justify-center gap-2.5 text-[13px] text-mut">
      <span aria-hidden="true" className="ios-loader spinner w-5 h-5" />
      <span>正在同步收藏…</span>
    </div>
    <div aria-hidden="true" className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
      {[0, 1, 2, 3].map(index => (
        <div key={index} className="min-w-0">
          <div className="aspect-[3/4] w-full rounded-[22px] bg-s3 animate-pulse" />
          <div className="mt-2.5 h-3.5 w-4/5 rounded-full bg-s3 animate-pulse" />
          <div className="mt-2 h-3 w-1/2 rounded-full bg-s2 animate-pulse" />
        </div>
      ))}
    </div>
  </>;
}
