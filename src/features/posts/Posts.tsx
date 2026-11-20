import { MediaCard } from "../../shared/ui/cards";
import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, cover, fmt, isMobile } from "../../shared/api/api";
import type { Post } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { copyText } from "../../shared/lib/clipboard";
import { Empty, Img, Sheet } from "../../shared/ui/ui";
import { Player } from "../playback";
import { IBack, ICommentF, IFireF, IFlame, IHeart, IHeartF, IPlayF, ISearch, IStar, IStarF } from "../../shared/ui/icons";
import { handleArticleClick, sanitizeHtml } from "../../shared/lib/html";
import { InplaceSearch } from "../search/InplaceSearch";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { TagBlockMenu } from "../../shared/ui/TagBlockMenu";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { usePaginatedList } from "../../shared/lib/usePaginatedList";
import { CommentsPanel } from "../feed/Panels";
import { postHot } from "./postData";

/* ================= 吃瓜列表 ================= */
export function PostsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, lineEpoch } = useStore();
  const { preferences } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [searching, setSearching] = useState(false);
  const { items, page, pages, loading, err, loadMore, scroller: scrollRef, sentinel } = usePaginatedList<Post>({
    filtering,
    resetKey: lineEpoch,
    rootMargin: "240px",
    getId: (item) => item.id,
    request: (next) => api.postCategory("remen-chigua", next, 20, "latest"),
  });

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="ios-subpage-bar">
          <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
          <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><IFlame size={18} strokeWidth={1.9} /></span>
          <div className="flex-1 min-w-0">
            <h1 className="text-[17px] font-bold text-on leading-tight">吃瓜</h1>
            <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">{loading && !items.length ? "加载中…" : `已加载 ${items.length} 篇 · ${Math.max(page, 1)}/${Math.max(pages, 1)} 页`}</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label="搜索吃瓜" className="ios-nav-btn"><ISearch size={18} /></Button>
        </div>
      </div>
      <div ref={scrollRef} aria-busy={loading} className="flex-1 scroll-y pt-3.5 pb-8">
        {items.length ? (
          <FilteredContent items={items} scopeKey="posts">{visible => (
          <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
            {visible.map((p) => (
              <MediaCard key={p.id} title={p.title} cover={p.cover} subtitle={`${fmt(p.hot)} 次浏览`} onOpen={() => push({ kind: "post", id: p.id })} />
            ))}
          </div>
          )}</FilteredContent>
        ) : loading ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err ? (
          <Empty icon={<IFireF size={26} />} title="吃瓜内容加载失败" sub={err} action="重试" onAction={() => loadMore(true)} />
        ) : (
          <Empty icon={<IFireF size={26} />} title="暂无吃瓜内容" />
        )}
        <div ref={sentinel} className="h-10" />
        {err && items.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-3 py-2 text-[13px] text-danger" role="alert">
            <span>加载更多失败：{err}</span>
            <Button disabled={loading} onClick={() => loadMore()} className="text-primary pressable">重试</Button>
          </div>
        )}
        {!loading && !err && items.length > 0 && page < pages && <Button onClick={() => loadMore()} className="w-full mt-3">加载更多</Button>}
        {loading && items.length > 0 && <div className="flex justify-center py-2"><Loader className="w-6 h-6 spinner" /></div>}
      </div>
      {searching && <InplaceSearch kind="post" postLabel="吃瓜帖子" wide={wide} onClose={() => setSearching(false)} onOpenPost={(p) => push({ kind: "post", id: p.id })} />}
    </div>
  );
}

const isHtml = (s: string) => /<(p|div|br|img|h[1-6]|ul|ol|li|blockquote|span|strong|em)\b/i.test(s);
/* 过滤上游旧品牌标签，避免显示到界面。 */
const HIDDEN_POST_TAG = "\u9ec4\u679c";

/* ================= 吃瓜详情（网页式浏览） ================= */
export function PostDetail({ id, onBack, active = true }: { id: number; onBack: () => void; active?: boolean }) {
  const {
    toast, strictSecurity, muted, setMuted, volume, push, lineEpoch, accountScope,
    isLiked, isFav, setLiked, setCollected, actionPending,
  } = useStore();
  const { preferences, blockReason } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [post, setPost] = useState<(Post & { content?: string; video_url?: string }) | null>(null);
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const autoBackKey = useRef("");
  const [tagMenu, setTagMenu] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  useEffect(() => { if (!active) { setTagMenu(false); setCommentsOpen(false); } }, [active]);
  const currentPost = loadedId === id ? post : null;
  const blocked = filtering && currentPost ? blockReason(currentPost.tags) : null;
  const allowed = !filtering || (!!currentPost && !blocked);
  useEffect(() => {
    if (!active || !filtering || !currentPost || !blocked) {
      if (!blocked) autoBackKey.current = "";
      return;
    }
    const key = String(id);
    if (autoBackKey.current === key) return;
    autoBackKey.current = key;
    toast("该内容命中屏蔽标签，已自动返回", "info");
    onBack();
  }, [active, filtering, currentPost, blocked, id, onBack, toast]);
  useEffect(() => { if (!allowed) { setTagMenu(false); setCommentsOpen(false); } }, [allowed]);
  const [err, setErr] = useState<string | null>(null);
  const [play, setPlay] = useState(false);
  /* 吃瓜帖详情里的 video_url 恒为空，视频地址只在 playback 接口里；
     不解析就整页只有图文（issue #11）。segs 是分段地址，多数帖只有 1 段。 */
  const [segs, setSegs] = useState<string[]>([]);
  const [seg, setSeg] = useState(0);
  const [resolving, setResolving] = useState(false);
  const [reload, setReload] = useState(0);
  const [mediaRetry, setMediaRetry] = useState(0);
  const [mediaError, setMediaError] = useState("");
  const [readProgress, setReadProgress] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  /* 线路/代理事件只换 lineEpoch，不换帖子：已显示内容必须保留，后台刷新（issue #165）。
     清空重置只属于「换帖子/换账号/手动重试」，否则自动选线一切线整页就闪回加载态。 */
  const shownKeyRef = useRef("");
  /* effect 里读最新值，避免把 loadedId/segs 加进依赖造成重复请求。 */
  const latestView = useRef({ loadedId: null as number | null, segs: [] as string[] });
  latestView.current = { loadedId, segs };
  const content = post?.content || "";
  const src = segs[seg] || "";
  // React 会在 HTML 属性对象身份变化时重写 innerHTML；滚动不能让配图重新加载。
  const articleHtml = useMemo(() => ({ __html: sanitizeHtml(content) }), [content, strictSecurity]);
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      copyText(url).then(() => toast("链接已复制", "ok")).catch(() => toast("复制失败", "info"));
    });
  };

  useEffect(() => {
    let alive = true;
    const key = `${accountScope}:${id}`;
    /* 手动重试也要清空：reload 计数进 key，而不是只看「大于 0」。 */
    const reset = shownKeyRef.current !== `${key}:${reload}`;
    shownKeyRef.current = `${key}:${reload}`;
    if (reset) {
      setReadProgress(0);
      scrollRef.current?.scrollTo(0, 0);
      setPost(null);
      setLoadedId(null);
      setTagMenu(false);
      setErr(null);
      setPlay(false);
      setSegs([]);
      setSeg(0);
    }
    api.post(id)
      .then((p) => {
        if (!alive) return;
        setPost(p);
        setLoadedId(id);
        setErr(null);
        /* 旧接口返回直链时提供回退，不覆盖已经解析出的分段。 */
        if (p.video_url) { setSegs(previous => previous.length ? previous : [p.video_url!]); setPlay(true); }
      })
      .catch((e) => {
        if (!alive) return;
        /* 后台刷新失败不打断正在阅读的内容；首次加载失败才显示整页错误。 */
        if (latestView.current.loadedId !== id) setErr((e as Error).message || "加载失败");
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reload, lineEpoch, accountScope]);

  useEffect(() => {
    if (!allowed) { setResolving(false); return; }
    let alive = true;
    /* 已有可播地址时静默刷新：遮罩与错误条只在没有画面时出现。 */
    const silent = latestView.current.segs.length > 0;
    setResolving(!silent); setMediaError("");
    api.postPlayback(id)
      .then((r) => {
        if (!alive) return;
        const list = (r?.videos || []).map((v) => v?.url || "").filter(Boolean);
        if (list.length) { setSegs(list); setPlay(true); }
      })
      .catch(e => { if (alive && !silent) setMediaError(e instanceof Error ? e.message : "视频解析失败"); })
      .finally(() => { if (alive) setResolving(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reload, mediaRetry, allowed, lineEpoch, accountScope]);

  // Keep blocked content out of the surface while the host navigates back.
  if (currentPost && blocked) return <div className="absolute inset-0 flex items-center justify-center bg-bg" aria-label="正在返回">
    <Loader className="w-8 h-8 spinner" />
  </div>;

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-subpage-header shrink-0" style={{ paddingTop: isMobile ? "var(--sat, 0px)" : 0 }}>
        <div className="ios-subpage-bar">
          <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
          <span className="text-[16px] font-bold text-on">吃瓜详情</span>
          <Button disabled={!currentPost} onClick={() => { if (active && allowed) setTagMenu(true); }} className="ml-auto -mr-2 px-2.5 min-h-9 inline-flex items-center justify-end text-[13px] font-medium text-primary">不感兴趣</Button>
        </div>
      </div>

      <div role="progressbar" aria-label="阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={readProgress} className="h-1 shrink-0 bg-s3 overflow-hidden"><div className="h-full bg-primary" style={{ width: `${readProgress}%` }} /></div>
      <div ref={scrollRef} data-post-scroll className="flex-1 scroll-y pb-8 !px-0" onScroll={event => {
        const el = event.currentTarget;
        const range = el.scrollHeight - el.clientHeight;
        setReadProgress(range > 0 ? Math.round(el.scrollTop / range * 100) : 100);
      }}>
        {err ? (
          <Empty icon={<IFireF size={26} />} title="加载失败" sub={err} action="重试" onAction={() => setReload(n => n + 1)} />
        ) : !currentPost ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : (
          <>
            <div data-post-media className="relative w-full bg-black mx-auto" style={{ height: isMobile ? "min(48vh, 420px)" : "min(60vh, 640px)" }}>
              {play && src ? (
                <Player src={src} scopeKey={id} poster={cover(currentPost.cover)} autoPlay active={active && !tagMenu && !commentsOpen} controls muted={muted} volume={volume}
                  onToggleMute={() => setMuted((m) => !m)} diagnosticContext={{ video_id: id, active: active && !tagMenu && !commentsOpen }} className="w-full h-full"
                  onEnded={() => {
                    /* 多段吃瓜视频：播完自动接下一段；末段保留播放器以便回拖或重看 */
                    if (seg < segs.length - 1) setSeg(seg + 1);
                  }} />
              ) : src ? (
                <Button aria-label="播放视频" onClick={() => setPlay(true)} className="absolute inset-0">
                  <Img src={currentPost.cover} eager />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="w-14 h-14 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center elev-2">
                        <IPlayF size={24} className="text-white ml-0.5" />
                      </span>
                    </span>
                </Button>
              ) : (
                <div className="absolute inset-0"><Img src={currentPost.cover} eager /></div>
              )}
              {resolving && !src && <div className="absolute inset-0 flex items-center justify-center gap-3 pointer-events-none bg-black/40 text-white"><Loader label="正在解析视频" /><span>正在解析视频…</span></div>}
            </div>
            {mediaError && !src && <div role="alert" className="flex flex-wrap items-center justify-center gap-3 px-4 py-3 text-[13px] text-danger"><span>{mediaError}</span><Button disabled={resolving} onClick={() => setMediaRetry(n => n + 1)} className="text-primary">重新解析</Button></div>}
              {segs.length > 1 && (
                <div role="group" aria-label="视频分段" className="flex items-center gap-2 px-4 py-3 overflow-x-auto">
                  {segs.map((_, i) => (
                    <Button aria-label={`第 ${i + 1} 段`} aria-pressed={i === seg} key={i} onClick={() => { setSeg(i); setPlay(true); }}
                      className="shrink-0 min-h-11 px-3 rounded-full text-[13px] font-semibold pressable"
                      style={i === seg
                        ? { background: "var(--p-primary)", color: "var(--p-on-primary)" }
                        : { background: "var(--p-s3)", color: "var(--p-on)" }}>
                      {i + 1}
                    </Button>
                  ))}
                </div>
              )}
            <div className="px-4 pt-3.5 mx-auto max-w-[800px] select-text">
              <h1 className="text-[17px] font-bold text-on leading-snug">{currentPost.title}</h1>
              <div className="flex items-center gap-2 mt-2 text-[12px] text-mut">
                <span>{currentPost.publish_time || currentPost.created_at}</span>
                <span className="flex items-center gap-1"><IFireF size={10} />{fmt(postHot(currentPost))}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {(currentPost.tags || []).filter((t) => !t.includes(HIDDEN_POST_TAG)).slice(0, 8).map((t) => (
                  <Button key={t} onClick={() => push({ kind: "tag", tag: t, name: t })}
                    className="inline-flex items-center justify-center min-h-0 h-7 px-2.5 rounded-(--r-ctl) bg-s3 text-[12px] text-on/85 hover:bg-s4 pressable">
                    #{t}
                  </Button>
                ))}
              </div>
              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                {(() => {
                  const liked = isLiked(id, 1, "post");
                  const fav = isFav(id, "post");
                  const likeBusy = actionPending(`like:post:${id}:1`);
                  const favBusy = actionPending(`collect:post:${id}`);
                  const likeCount = Math.max(0, (currentPost.counts?.like ?? 0) + Number(liked));
                  const favCount = Math.max(0, (currentPost.counts?.collect ?? 0) + Number(fav));
                  return <>
                    <Button aria-pressed={liked} disabled={likeBusy} onClick={() => {
                      void setLiked("post", id, 1, !liked)
                        .then(() => toast(!liked ? "已加入喜欢" : "已取消喜欢", !liked ? "heart" : "info"))
                        .catch(e => toast(e instanceof Error ? e.message : "操作失败", "info"));
                    }} className="h-9 px-3.5 rounded-full bg-s2 flex items-center gap-1.5 text-[13px] text-on pressable">
                      {liked ? <IHeartF size={15} className="text-neon" /> : <IHeart size={15} />}
                      <span>{likeCount > 0 ? fmt(likeCount) : "喜欢"}</span>
                    </Button>
                    <Button aria-pressed={fav} disabled={favBusy} onClick={() => {
                      void setCollected("post", id, !fav)
                        .then(() => toast(!fav ? "已收藏" : "已取消收藏", !fav ? "star" : "info"))
                        .catch(e => toast(e instanceof Error ? e.message : "操作失败", "info"));
                    }} className="h-9 px-3.5 rounded-full bg-s2 flex items-center gap-1.5 text-[13px] text-on pressable">
                      {fav ? <IStarF size={15} className="text-amber" /> : <IStar size={15} />}
                      <span>{favCount > 0 ? fmt(favCount) : "收藏"}</span>
                    </Button>
                    <Button onClick={() => setCommentsOpen(true)} className="h-9 px-3.5 rounded-full bg-s2 flex items-center gap-1.5 text-[13px] text-on pressable">
                      <ICommentF size={14} />
                      <span>{currentPost.counts?.comment ? fmt(currentPost.counts.comment) : "评论"}</span>
                    </Button>
                  </>;
                })()}
              </div>
              {currentPost.content && (
                (isHtml(currentPost.content) || (!strictSecurity && /<[a-z][\s\S]*>/i.test(currentPost.content)))
                  ? <div className="article-body mt-3.5" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={articleHtml} />
                  : <Surface className="mt-3.5 rounded-(--r-md) bg-s2 p-3.5 text-[14px] leading-relaxed text-on/80 whitespace-pre-wrap">{currentPost.content}</Surface>
              )}
            </div>
          </>
        )}
      </div>
      <Sheet open={commentsOpen && active} onClose={() => setCommentsOpen(false)}>
        <div className="flex flex-col" style={{ height: "72dvh" }}>
          <CommentsPanel videoId={id} ep={1} total={currentPost?.counts?.comment ?? 0} kind="post" onClose={() => setCommentsOpen(false)} />
        </div>
      </Sheet>
      <TagBlockMenu open={tagMenu && active} tags={currentPost?.tags || []} onClose={() => setTagMenu(false)} onSettings={() => push({ kind: "settings", section: "内容偏好" })} />
    </div>
  );
}
