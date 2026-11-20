import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "../../shared/api/api";
import type { Paged, UserProfile, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { usePaginatedList } from "../../shared/lib/usePaginatedList";
import { Masonry } from "../../shared/ui/cards";
import { InplaceSearch } from "../search/InplaceSearch";
import { Avatar, Empty } from "../../shared/ui/ui";
import { IBack, IChevronDown, IGrid, IHeart, ISearch, IUser } from "../../shared/ui/icons";

/** Keep pagination local to the scrolling page and reject responses from an old account/author. */
function useUserVideos(enabled: boolean, resetKey: string | number, request: (page: number) => Promise<Paged<VideoCard>>) {
  const { preferences } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  return usePaginatedList<VideoCard>({
    enabled,
    filtering,
    resetKey,
    rootMargin: "200px",
    getId: (item) => item.id,
    request,
  });
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
  const { push, user, follows, setLoginOpen, setTab, accountScope } = useStore();
  const [searching, setSearching] = useState(false);
  const [creators, setCreators] = useState<Record<number, UserProfile>>({});
  const creatorsRef = useRef(creators);
  creatorsRef.current = creators;
  // Identity belongs in the dependency list: switching accounts discards the previous feed.
  const request = useCallback((page: number) => api.following(page, 20), []);
  const state = useUserVideos(!!user, accountScope, request);
  const followSlice = follows.slice(0, 24);
  const followKey = followSlice.join(",");

  useEffect(() => {
    if (!user || !followSlice.length) return;
    let alive = true;
    const missing = followSlice.filter(uid => !creatorsRef.current[uid]);
    if (!missing.length) return;
    Promise.allSettled(missing.map(uid => api.user(uid))).then(results => {
      if (!alive) return;
      const loaded: Record<number, UserProfile> = {};
      results.forEach((r, idx) => {
        if (r.status === "fulfilled" && r.value) loaded[missing[idx]] = r.value;
      });
      if (Object.keys(loaded).length) setCreators(prev => ({ ...prev, ...loaded }));
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, followKey]);

  return <div className="ios-page absolute inset-0 bg-bg flex flex-col">
    <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
      <div className="ios-subpage-bar">
        <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
        <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><IHeart size={18} /></span>
        <div className="min-w-0 flex-1">
          <h1 className="text-[17px] font-bold text-on leading-tight">关注</h1>
          {user && <p className="text-[12px] text-mut leading-tight mt-0.5" role="status">{follows.length > 0 ? `已关注 ${follows.length} 人 · ` : ""}{countLabel(state)}</p>}
        </div>
        <Button onClick={() => setSearching(true)} aria-label="搜索短剧" className="ios-nav-btn"><ISearch size={18} /></Button>
      </div>
    </div>
    <div ref={state.scroller} className="flex-1 scroll-y pt-3.5 pb-8">
      {!user ? <Empty icon={<IUser size={26} />} title="登录后查看关注流" action="去登录" onAction={() => setLoginOpen(true)} /> : <>
        {followSlice.length > 0 && (
          <Surface role="region" aria-label="已关注创作者" className="mb-4 rounded-(--r-md) bg-s1 p-3.5 a-rise">
            <div className="flex items-center justify-between mb-2.5">
              <h2 className="text-[13px] font-semibold text-on/90">已关注创作者</h2>
              <span className="text-[12px] text-mut">共 {follows.length} 位</span>
            </div>
            <div className="scroll-x flex gap-3 snap-x">
              {followSlice.map(uid => {
                const info = creators[uid];
                const label = info?.nickname || `用户 ${uid}`;
                return (
                  <Button key={uid} onClick={() => push({ kind: "user", id: uid, name: info?.nickname })}
                    className="w-[68px] shrink-0 flex flex-col items-center gap-1.5 snap-start pressable"
                    aria-label={`进入 ${label} 主页`}>
                    <Avatar size={48} name={label} hue={(uid * 47) % 360} ring />
                    <span className="w-full text-[12px] text-on/85 text-center truncate">{label}</span>
                  </Button>
                );
              })}
            </div>
          </Surface>
        )}
        {state.loading && !state.items.length ? <div className="flex justify-center py-12"><Loader /></div>
          : state.err && !state.items.length ? <Empty icon={<IGrid size={26} />} title="关注流加载失败" sub={state.err} action="重试" onAction={() => void state.loadMore()} />
          : state.items.length ? <>
            {followSlice.length > 0 && <h2 className="mb-2.5 text-[14px] font-bold text-on">最新动态</h2>}
            <Masonry videos={state.items} scopeKey={`following:${accountScope}`} wide={wide} onOpen={(video, visible) => push({ kind: "feed", videoIds: visible.map(item => item.id), index: visible.findIndex(item => item.id === video.id), title: "关注" })} />
          </>
          : follows.length > 0 ? <Empty icon={<IGrid size={26} />} title="关注的创作者暂未发布新剧" sub="可点击上方头像进入创作者主页查看，或去分类发现更多作品。" action="去分类看看" onAction={() => setTab("category")} />
          : <Empty icon={<IGrid size={26} />} title="还没有关注内容" sub="在分类中发现作品，关注喜欢的作者。" action="去分类看看" onAction={() => setTab("category")} />}
        <PaginationFeedback state={state} />
      </>}
    </div>
    {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list, kw) => push({ kind: "feed", videoIds: list.map(x => x.id), index: list.findIndex(x => x.id === v.id), title: kw ? `搜索 · ${kw}` : "搜索" })} />}
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
  const state = useUserVideos(true, `${accountScope}:${id}`, request);

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

  const isOwnProfile = user?.id === id;
  const following = follows.includes(id);
  const onFollow = async () => {
    if (isOwnProfile || followPending.current || actionPending(`follow:${id}`)) return;
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
    <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
      <div className="ios-subpage-bar">
        <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
        <h1 className="flex-1 min-w-0 text-[17px] font-bold text-on leading-tight truncate">{profile?.nickname || name || "用户主页"}</h1>
        <Button onClick={() => setSearching(true)} aria-label="搜索短剧" className="ios-nav-btn"><ISearch size={18} /></Button>
      </div>
    </div>
    <div ref={state.scroller} className="flex-1 scroll-y pt-3.5 pb-8">
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
          {!isOwnProfile && <Button onClick={() => void onFollow()} disabled={followBusy || actionPending(`follow:${id}`)} aria-busy={followBusy || actionPending(`follow:${id}`)} aria-pressed={following}
            className={`min-h-11 px-3.5 rounded-full text-[13px] font-semibold shrink-0 ${following ? "bg-s3 text-mut" : "bg-primary text-on-primary"}`}>
            {followBusy || actionPending(`follow:${id}`) ? "处理中…" : following ? "已关注" : "+ 关注"}
          </Button>}
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
        : state.items.length ? <Masonry videos={state.items} scopeKey={id} wide={wide} onOpen={(v, visible) => push({ kind: "feed", videoIds: visible.map(x => x.id), index: visible.findIndex(x => x.id === v.id), title: profile?.nickname || name || "用户作品" })} />
        : <Empty icon={<IGrid size={26} />} title="暂无作品" />}
      <PaginationFeedback state={state} />
    </div>
    {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list, kw) => push({ kind: "feed", videoIds: list.map(x => x.id), index: list.findIndex(x => x.id === v.id), title: kw ? `搜索 · ${kw}` : "搜索" })} />}
  </div>;
}
