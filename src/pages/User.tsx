import { Button, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "../api";
import type { Paged, UserProfile, VideoCard } from "../types";
import { useStore } from "../store";
import { useContentPreferences } from "../contentPreferences";
import { Masonry } from "../components/cards";
import { InplaceSearch } from "../components/InplaceSearch";
import { Avatar, Empty } from "../components/ui";
import { IBack, IChevronDown, IGrid, ISearch, IUser } from "../icons";

/** Keep pagination local to the scrolling page and reject responses from an old account/author. */
function useUserVideos(enabled: boolean, request: (page: number) => Promise<Paged<VideoCard>>) {
  const { preferences } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [items, setItems] = useState<VideoCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const generation = useRef(0);
  const cursor = useRef({ page: 0, pages: 1, busy: false });
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useCallback(async () => {
    const state = cursor.current;
    if (!enabled || state.busy || state.page >= state.pages) return;
    const version = generation.current;
    const next = state.page + 1;
    state.busy = true;
    setLoading(true); setErr("");
    try {
      const response = await request(next);
      if (version !== generation.current) return;
      const incoming = response?.items || [];
      setItems(previous => {
        const seen = new Set(previous.map(item => item.id));
        const unique = incoming.filter(item => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
        return [...previous, ...unique];
      });
      state.page = next;
      state.pages = response?.pagination?.pages || next;
      setTotal(Number.isFinite(response?.pagination?.total) ? response.pagination.total : null);
      setHasMore(next < state.pages && incoming.length > 0);
      if (!incoming.length) state.pages = next;
    } catch (error) {
      if (version === generation.current) setErr(error instanceof Error ? error.message : "加载失败，请重试");
    } finally {
      if (version === generation.current) { state.busy = false; setLoading(false); }
    }
  }, [enabled, request]);
  useEffect(() => {
    generation.current++;
    cursor.current = { page: 0, pages: 1, busy: false };
    setItems([]); setErr(""); setTotal(null); setHasMore(false); setLoading(false);
    if (scroller.current) scroller.current.scrollTop = 0;
    if (enabled) void loadMore();
    return () => { generation.current++; };
  }, [enabled, loadMore]);
  useEffect(() => {
    if (!enabled || filtering || loading || err || !hasMore || !sentinel.current || !scroller.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) void loadMore();
    }, { root: scroller.current, rootMargin: "200px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [enabled, loading, err, hasMore, loadMore, filtering]);
  return { items, loading, err, total, hasMore, loadMore, scroller, sentinel };
}

type VideoState = ReturnType<typeof useUserVideos>;
function PaginationFeedback({ state }: { state: VideoState }) {
  if (!state.items.length) return null;
  return <>
    {state.err && <div role="status" className="mt-3 rounded-(--r-md) bg-s2 p-3 text-[13px]">
      <p className="font-semibold">加载更多失败</p><p className="mt-1 break-words text-mut">{state.err}</p>
      <Button onClick={() => void state.loadMore()} className="mt-2 px-4 text-primary">重试</Button>
    </div>}
    {state.loading ? <div className="flex justify-center py-3"><Loader label="加载更多作品" /></div>
      : !state.err && state.hasMore ? <Button onClick={() => void state.loadMore()} className="mt-3 w-full rounded-(--r-ctl) bg-s3">加载更多</Button>
      : !state.err && <p className="py-3 text-center text-[12px] text-mut">— 已展示全部作品 —</p>}
    <div ref={state.sentinel} className="h-8" aria-hidden="true" />
  </>;
}
const countLabel = ({ items, total }: VideoState) => `已加载 ${items.length}${total === null ? "" : ` / ${total}`} 部`;

export function FollowingPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { accountScope, lineEpoch } = useStore();
  return <FollowingContent key={`${accountScope}:${lineEpoch}`} onBack={onBack} wide={wide} />;
}

function FollowingContent({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, user, setLoginOpen, setTab, accountScope } = useStore();
  const [searching, setSearching] = useState(false);
  // Identity belongs in the dependency list: switching accounts discards the previous feed.
  const request = useCallback((page: number) => api.following(page, 20), [accountScope]);
  const state = useUserVideos(!!user, request);
  return <div className="ios-page absolute inset-0 bg-bg flex flex-col">
    <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
      <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
        <Button aria-label="返回" onClick={onBack} className="ios-icon-button"><IBack size={20} /></Button>
        <div className="min-w-0 flex-1"><h1 className="text-[17px] font-bold text-on">关注</h1>
          {user && <p className="text-[12px] text-mut" role="status">{countLabel(state)}</p>}</div>
        <Button onClick={() => setSearching(true)} aria-label="搜索短剧" className="ios-icon-button"><ISearch size={19} /></Button>
      </div>
    </div>
    <div ref={state.scroller} className="flex-1 scroll-y px-4 pt-3 pb-8">
      {!user ? <Empty icon={<IUser size={26} />} title="登录后查看关注流" sub="关注喜欢的作者，第一时间看到他们的新作品" action="去登录" onAction={() => setLoginOpen(true)} />
        : state.loading && !state.items.length ? <div className="flex justify-center py-12"><Loader /></div>
        : state.err && !state.items.length ? <Empty icon={<IGrid size={26} />} title="关注流加载失败" sub={state.err} action="重试" onAction={() => void state.loadMore()} />
        : state.items.length ? <Masonry videos={state.items} scopeKey={`following:${accountScope}`} wide={wide} onOpen={video => push({ kind: "feed", videoIds: state.items.map(item => item.id), index: state.items.findIndex(item => item.id === video.id), title: "关注" })} />
        : <Empty icon={<IGrid size={26} />} title="还没有关注内容" sub="在分类中发现作品，关注喜欢的作者。" action="去分类看看" onAction={() => setTab("category")} />}
      {user && <PaginationFeedback state={state} />}
    </div>
    {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map(x => x.id), index: list.findIndex(x => x.id === v.id), title: "关注" })} />}
  </div>;
}

export function UserPage({ id, name, onBack, wide }: { id: number; name?: string; onBack: () => void; wide: boolean }) {
  const { accountScope, lineEpoch } = useStore();
  return <UserContent key={`${accountScope}:${lineEpoch}:${id}`} id={id} name={name} onBack={onBack} wide={wide} />;
}

function UserContent({ id, name, onBack, wide }: { id: number; name?: string; onBack: () => void; wide: boolean }) {
  const { push, toast, follows, setFollowing, actionPending, accountScope, user, setLoginOpen } = useStore();
  const [searching, setSearching] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.userStats>> | null>(null);
  const [infoError, setInfoError] = useState("");
  const [infoLoading, setInfoLoading] = useState(true);
  const [infoReload, setInfoReload] = useState(0);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState("");
  const followPending = useRef(false);
  const context = useRef({ id, accountScope });
  context.current = { id, accountScope };
  const mounted = useRef(false);
  const followVersion = useRef(0);
  const request = useCallback((page: number) => api.userVideos(id, page, 20), [id]);
  const state = useUserVideos(true, request);

  useEffect(() => {
    mounted.current = true;
    followVersion.current++; followPending.current = false;
    setFollowBusy(false); setFollowError("");
    return () => { mounted.current = false; followVersion.current++; };
  }, [id, accountScope]);
  useEffect(() => { setProfile(null); setStats(null); }, [id]);
  useEffect(() => {
    let alive = true;
    setInfoLoading(true); setInfoError("");
    Promise.allSettled([api.user(id), api.userStats(id)]).then(([profileResult, statsResult]) => {
      if (!alive) return;
      if (profileResult.status === "fulfilled") setProfile(profileResult.value);
      if (statsResult.status === "fulfilled") setStats(statsResult.value);
      const failures = [profileResult, statsResult].filter(result => result.status === "rejected") as PromiseRejectedResult[];
      if (failures.length) setInfoError(failures.map(result => result.reason instanceof Error ? result.reason.message : "资料加载失败").filter((value, index, all) => all.indexOf(value) === index).join("；"));
      setInfoLoading(false);
    });
    return () => { alive = false; };
  }, [id, infoReload]);

  const following = follows.includes(id);
  const onFollow = async () => {
    if (followPending.current || actionPending(`follow:${id}`)) return;
    if (!user) { setLoginOpen(true); return; }
    const version = ++followVersion.current;
    const on = !following;
    followPending.current = true; setFollowBusy(true); setFollowError("");
    const current = () => mounted.current && followVersion.current === version && context.current.id === id && context.current.accountScope === accountScope;
    try {
      await setFollowing(id, on);
      if (!current()) return;
      toast(on ? `已关注 ${profile?.nickname || name || ""}` : "已取消关注", on ? "ok" : "info");
    } catch (error) {
      if (current()) setFollowError(error instanceof Error ? error.message : "操作失败，请重试");
    } finally {
      if (current()) { followPending.current = false; setFollowBusy(false); }
    }
  };
  const stat = (value: number | undefined) => value === undefined ? "—" : fmt(value);

  return <div className="ios-page absolute inset-0 bg-bg flex flex-col">
    <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
      <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
        <Button aria-label="返回" onClick={onBack} className="ios-icon-button"><IBack size={20} /></Button>
        <h1 className="flex-1 min-w-0 text-[16px] font-bold text-on truncate">{profile?.nickname || name || "用户主页"}</h1>
        <Button onClick={() => setSearching(true)} aria-label="搜索短剧" className="ios-icon-button"><ISearch size={19} /></Button>
      </div>
    </div>
    <div ref={state.scroller} className="flex-1 scroll-y px-4 pt-3 pb-8">
      <Surface className="rounded-(--r-lg) bg-s1 p-4 elev-1 a-rise">
        <div className="flex items-center gap-3.5">
          <Avatar size={56} name={profile?.nickname || name || "U"} hue={220} ring />
          <div className="flex-1 min-w-0">
            <p className="text-[16px] font-bold text-on break-words">{profile?.nickname || name || (infoLoading ? "正在读取资料…" : "用户资料暂不可用")}</p>
            {profile?.username && <p className="text-[12px] text-mut mt-0.5 break-words">@{profile.username} · ID {id}</p>}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-mut" aria-busy={infoLoading}>
            <span>作品 <b className="text-on">{stat(stats?.video_count)}</b></span>
            <span>粉丝 <b className="text-on">{stat(stats?.followers)}</b></span>
            <span>获赞 <b className="text-on">{stat(stats?.like_count)}</b></span>
          </div>
          <Button onClick={() => void onFollow()} disabled={followBusy || actionPending(`follow:${id}`)} aria-busy={followBusy || actionPending(`follow:${id}`)} aria-pressed={following}
            className={`min-h-11 px-3.5 rounded-full text-[13px] font-semibold shrink-0 ${following ? "bg-s3 text-mut" : "bg-primary text-on-primary"}`}>
            {followBusy || actionPending(`follow:${id}`) ? "处理中…" : following ? "已关注" : "+ 关注"}
          </Button>
        </div>
        {followError && <p role="alert" className="mt-3 text-[13px] text-danger break-words">{followError}。关注状态未更改，请重试。</p>}
      </Surface>
      {infoError && <div role="status" className="mt-3 rounded-(--r-md) bg-s2 p-3 text-[13px]">
        <p className="font-semibold">资料信息未完整加载</p><p className="mt-1 text-mut break-words">{infoError}</p>
        <Button disabled={infoLoading} onClick={() => setInfoReload(value => value + 1)} className="mt-2 px-3 text-primary">重试资料</Button>
      </div>}
      {profile?.sign && <details className="group mt-3 text-[13px] text-mut"><summary className="cursor-pointer min-h-11 flex items-center gap-2 text-on">作者简介<IChevronDown size={16} className="group-open:rotate-180" /></summary><p className="leading-relaxed whitespace-pre-wrap break-words">{profile.sign}</p></details>}
      <div className="mt-4 mb-2.5 flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-[14px] font-bold text-on">作品</h2><p role="status" className="text-[12px] text-mut">{countLabel(state)}</p></div>
      {state.loading && !state.items.length ? <div className="flex justify-center py-12"><Loader /></div>
        : state.err && !state.items.length ? <Empty icon={<IGrid size={26} />} title="作品加载失败" sub={state.err} action="重试" onAction={() => void state.loadMore()} />
        : state.items.length ? <Masonry videos={state.items} scopeKey={id} wide={wide} onOpen={v => push({ kind: "feed", videoIds: state.items.map(x => x.id), index: state.items.findIndex(x => x.id === v.id), title: profile?.nickname || name || "用户作品" })} />
        : <Empty icon={<IGrid size={26} />} title="暂无作品" />}
      <PaginationFeedback state={state} />
    </div>
    {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map(x => x.id), index: list.findIndex(x => x.id === v.id), title: profile?.nickname || name || "用户作品" })} />}
  </div>;
}
