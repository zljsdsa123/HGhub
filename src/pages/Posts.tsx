import { MediaCard } from "../components/cards";
import { Button, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, cover, fmt, isMobile } from "../api";
import type { Post } from "../types";
import { useStore } from "../store";
import { copyText } from "../clipboard";
import { Empty, Img } from "../components/ui";
import Player from "../components/Player";
import { IBack, IFireF, IPlayF, ISearch } from "../icons";
import { handleArticleClick, sanitizeHtml } from "../html";
import { InplaceSearch } from "../components/InplaceSearch";
import { FilteredContent } from "../components/FilteredContent";
import { TagBlockMenu } from "../components/TagBlockMenu";
import { useContentPreferences } from "../contentPreferences";
import { postHot } from "../postData";

/* ================= 吃瓜列表 ================= */
export function PostsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  const { preferences } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [searching, setSearching] = useState(false);
  const [items, setItems] = useState<Post[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadMore = async (reset = false) => {
    if (busy.current) return;
    const next = reset ? 1 : page + 1;
    if (!reset && next > pages) return;
    busy.current = true;
    setLoading(true);
    setErr("");
    try {
      const res = await api.postCategory("remen-chigua", next, 20, "latest");
      setItems((prev) => {
        const base = reset ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr("");
    } catch (e) {
      setErr((e as Error).message || "吃瓜内容加载失败");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  useEffect(() => { loadMore(true); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || err || filtering) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { root: scrollRef.current, rootMargin: "240px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages, err, filtering]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-2 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <Button aria-label="返回" onClick={onBack} className="w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={19} /></Button>
        <h1 className="text-[15px] font-bold text-on">吃瓜</h1>
        <span className="text-[12px] text-mut ml-1">圈内爆料 · 每日更新</span>
        <Button onClick={() => setSearching(true)} aria-label="搜索吃瓜" className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></Button>
      </div>
      <div ref={scrollRef} aria-busy={loading} className="flex-1 scroll-y px-3 pt-3 pb-8">
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
          <Empty icon={<IFireF size={26} />} title="暂无吃瓜内容" sub="稍后再来看看" />
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
  const { toast, strictSecurity, muted, setMuted, push } = useStore();
  const { preferences, blockReason } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [post, setPost] = useState<(Post & { content?: string; video_url?: string }) | null>(null);
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const autoBackKey = useRef("");
  const [tagMenu, setTagMenu] = useState(false);
  useEffect(() => { if (!active) setTagMenu(false); }, [active]);
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
    onBack();
  }, [active, filtering, currentPost, blocked, id, onBack]);
  useEffect(() => { if (!allowed) setTagMenu(false); }, [allowed]);
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
  const content = post?.content || "";
  const src = segs[seg] || "";
  const safeHtml = useMemo(() => sanitizeHtml(content), [content, strictSecurity]);
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      copyText(url).then(() => toast("链接已复制", "ok")).catch(() => toast("复制失败", "info"));
    });
  };

  useEffect(() => {
    let alive = true;
    setReadProgress(0);
    scrollRef.current?.scrollTo(0, 0);
    setPost(null);
    setLoadedId(null);
    setTagMenu(false);
    setErr(null);
    setPlay(false);
    setSegs([]);
    setSeg(0);
    api.post(id)
      .then((p) => {
        if (!alive) return;
        setPost(p);
        setLoadedId(id);
        /* 旧接口返回直链时提供回退，不覆盖已经解析出的分段。 */
        if (p.video_url) { setSegs(previous => previous.length ? previous : [p.video_url!]); setPlay(true); }
      })
      .catch((e) => { if (alive) setErr((e as Error).message || "加载失败"); });
    return () => { alive = false; };
  }, [id, reload]);

  useEffect(() => {
    if (!allowed) { setResolving(false); return; }
    let alive = true;
    setResolving(true); setMediaError("");
    api.postPlayback(id)
      .then((r) => {
        if (!alive) return;
        const list = (r?.videos || []).map((v) => v?.url || "").filter(Boolean);
        if (list.length) { setSegs(list); setPlay(true); }
      })
      .catch(e => { if (alive) setMediaError(e instanceof Error ? e.message : "视频解析失败"); })
      .finally(() => { if (alive) setResolving(false); });
    return () => { alive = false; };
  }, [id, reload, mediaRetry, allowed]);

  // Keep blocked content out of the surface while the host navigates back.
  if (currentPost && blocked) return <div className="absolute inset-0 flex items-center justify-center bg-bg" aria-label="正在返回">
    <Loader className="w-8 h-8 spinner" />
  </div>;

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-2 bg-s1" style={{ paddingTop: isMobile ? "var(--sat, 0px)" : 0, height: isMobile ? "calc(44px + var(--sat, 0px))" : 44 }}>
        <Button aria-label="返回" onClick={onBack} className="w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={19} /></Button>
        <span className="text-[14px] font-semibold text-on">吃瓜详情</span>
        <Button disabled={!currentPost} onClick={() => { if (active && allowed) setTagMenu(true); }} className="ml-auto px-3 text-[13px]">不感兴趣</Button>
      </div>

      <div role="progressbar" aria-label="阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={readProgress} className="h-1 shrink-0 bg-s3 overflow-hidden"><div className="h-full bg-primary" style={{ width: `${readProgress}%` }} /></div>
      <div ref={scrollRef} data-post-scroll className="flex-1 scroll-y pb-8" onScroll={event => {
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
                <Player src={src} poster={cover(currentPost.cover)} autoPlay active={active && !tagMenu} controls muted={muted}
                  onToggleMute={() => setMuted((m) => !m)} diagnosticContext={{ video_id: id, active: active && !tagMenu }} className="w-full h-full"
                  onEnded={() => {
                    /* 多段吃瓜视频：播完自动接下一段 */
                    if (seg < segs.length - 1) setSeg(seg + 1); else setPlay(false);
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
            {mediaError && !src && <div role="alert" className="flex flex-wrap items-center justify-center gap-3 px-4 py-3 text-[13px] text-danger"><span>{mediaError}</span><Button disabled={resolving} onClick={() => setMediaRetry(n => n + 1)}>重新解析</Button></div>}
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
                  <span key={t} className="px-2 py-0.5 rounded-(--r-ctl) bg-s3 text-[12px] text-on/75">#{t}</span>
                ))}
              </div>
              {currentPost.content && (
                (isHtml(currentPost.content) || (!strictSecurity && /<[a-z][\s\S]*>/i.test(currentPost.content)))
                  ? <div className="article-body mt-3.5" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={{ __html: safeHtml }} />
                  : <Surface className="mt-3.5 rounded-(--r-md) bg-s2 p-3.5 text-[14px] leading-relaxed text-on/80 whitespace-pre-wrap">{currentPost.content}</Surface>
              )}
            </div>
          </>
        )}
      </div>
      <TagBlockMenu open={tagMenu && active} tags={currentPost?.tags || []} onClose={() => setTagMenu(false)} onSettings={() => push({ kind: "settings", section: "内容偏好" })} />
    </div>
  );
}
