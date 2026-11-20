import { Button, Form, Image, Input } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, fmt, cover as imageCover } from "../../shared/api/api";
import { handleArticleClick, sanitizeHtml } from "../../shared/lib/html";
import { commentText } from "./commentText";
import type { Comment, CommentPage, Episode } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { copyText } from "../../shared/lib/clipboard";
import { Avatar, Empty } from "../../shared/ui/ui";
import { IClose, IHeart, ISendF } from "../../shared/ui/icons";

/* ================= 选集 ================= */
export function EpisodesPanel({ episodes, current, onPick, onClose, bare = false }: {
  videoId: number; episodes: Episode[]; current: number; onPick: (ep: number) => void; onClose: () => void;
  /** 嵌在双栏抽屉里时，隐藏自带的标题栏 */
  bare?: boolean;
}) {
  const [asc, setAsc] = useState(true);
  const gridRef = useRef<HTMLDivElement>(null);
  const list = asc ? episodes : [...episodes].reverse();
  useLayoutEffect(() => {
    const activeEl = gridRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [current, asc, episodes.length]);
  return (
    <div className="flex flex-col h-full">
      {bare ? (
        <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
          <span className="text-[12px] text-mut">共 {episodes.length} 集</span>
          <Button onClick={() => setAsc((v) => !v)} className="ml-auto text-[12px] text-primary pressable">{asc ? "倒序" : "正序"}</Button>
        </div>
      ) : (
        <div className="shrink-0 flex items-center gap-2 px-4 h-12">
          <span className="text-[14px] font-bold text-on">选集</span>
          <span className="text-[12px] text-mut">共 {episodes.length} 集</span>
          <Button onClick={() => setAsc((v) => !v)} className="ml-auto text-[12px] text-primary pressable">{asc ? "倒序" : "正序"}</Button>
          <Button onClick={onClose} aria-label="关闭" className="w-8 h-8 min-h-0 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
            <IClose size={13} />
          </Button>
        </div>
      )}
      <div ref={gridRef} className="flex-1 scroll-y px-4 pb-4">
        <div className="grid grid-cols-4 gap-2">
          {list.map((e) => (
            <Button key={e.ep_num} aria-current={e.ep_num === current ? "true" : undefined} onClick={() => onPick(e.ep_num)}
              className={`inline-flex items-center justify-center h-10 rounded-(--r-sm) text-[13px] font-semibold tabular-nums pressable ${e.ep_num === current ? "bg-primary text-on-primary" : "bg-s3 text-on/80"}`}>
              {e.ep_num}
            </Button>
          ))}
        </div>
        {!episodes.length && <div className="text-center text-[12px] text-dim py-8">暂无剧集</div>}
      </div>
    </div>
  );
}

/* ================= 评论 ================= */
export function CommentsPanel({ videoId, ep, total, kind = "video", onClose }: {
  videoId: number; ep: number; total: number; kind?: "video" | "post"; onClose: () => void;
}) {
  const { user, setLoginOpen, toast, accountScope, lineEpoch } = useStore();
  const [items, setItems] = useState<Comment[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loadedTotal, setLoadedTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryPage, setRetryPage] = useState(1);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadSequence = useRef(0);
  const loadBusy = useRef(false);
  const sendBusy = useRef(false);
  const sendSequence = useRef(0);
  const scope = `${accountScope}:${lineEpoch}:${kind}:${videoId}:${ep}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const alive = useRef(true);

  const load = useCallback(async (p: number) => {
    if (p > 1 && loadBusy.current) return;
    const token = ++loadSequence.current;
    loadBusy.current = true;
    setLoading(true); setError("");
    try {
      const res: CommentPage | null = kind === "post"
        ? await api.postComments(videoId, p, 20)
        : await api.comments(videoId, ep, p, 20);
      if (!alive.current || token !== loadSequence.current || currentScope.current !== scope) return;
      const incoming = (res?.items || []).map((x) => ({ ...x, text: commentText(x.text) }));
      setItems((prev) => {
        const base = p === 1 ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...incoming.filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      setPages(res?.pagination?.pages || 1);
      const count = res?.pagination?.total;
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) setLoadedTotal(count);
    } catch (e) {
      if (alive.current && token === loadSequence.current && currentScope.current === scope) {
        setError((e as Error).message || "加载失败，请重试"); setRetryPage(p);
      }
    } finally {
      if (alive.current && token === loadSequence.current && currentScope.current === scope) {
        loadBusy.current = false; setLoading(false);
      }
    }
  }, [videoId, ep, kind, scope]);

  useEffect(() => {
    alive.current = true;
    setItems([]); setPage(0); setPages(1); setLoadedTotal(null); setText(""); setSending(false); sendBusy.current = false;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    void load(1);
    return () => { alive.current = false; loadSequence.current++; sendSequence.current++; loadBusy.current = false; };
  }, [load]);

  const send = async () => {
    if (kind === "post") return;
    const t = text.trim();
    if (!t || sendBusy.current) return;
    if (!user) { setLoginOpen(true); return; }
    sendBusy.current = true;
    const token = ++sendSequence.current;
    setSending(true);
    try {
      await api.commentSend(videoId, ep, t);
      if (!alive.current || token !== sendSequence.current || currentScope.current !== scope) return;
      setText("");
      toast("评论已提交，审核通过后展示", "ok");
      void load(1);
    } catch (e) {
      if (alive.current && token === sendSequence.current && currentScope.current === scope) toast((e as Error).message || "评论失败", "info");
    } finally {
      if (alive.current && token === sendSequence.current && currentScope.current === scope) { sendBusy.current = false; setSending(false); }
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[14px] font-bold text-on">评论</span>
        <span className="text-[12px] text-mut">{fmt(loadedTotal ?? total)}{kind === "video" ? ` · 第 ${ep} 集` : " 条"}</span>
        <Button onClick={onClose} aria-label="关闭" className="ml-auto w-8 h-8 min-h-0 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </Button>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 scroll-y px-4" aria-busy={loading}>
        {items.length ? items.map((c) => (
          <div key={c.id} className="flex gap-2.5 py-3 border-b border-s3 last:border-0">
            <Avatar size={32} name={c.nickname} hue={(c.user_id * 37) % 360} />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className="min-w-0 text-[12px] font-semibold text-on/90 [overflow-wrap:anywhere]">{c.nickname}</span>
                <span className="shrink-0 text-[12px] text-dim">{c.time}</span>
              </div>
              <p className="text-[14px] text-on/80 mt-1 leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{c.text || "该评论包含不支持的内容"}</p>
              <div className="flex items-center gap-3 mt-1.5 text-[12px] text-dim">
                <span className="flex items-center gap-1"><IHeart size={11} />{c.like_count || 0}</span>
                {c.reply_count > 0 && <span>{c.reply_count} 条回复</span>}
              </div>
            </div>
          </div>
        )) : loading ? (
          <div className="flex justify-center py-10"><Loader className="w-7 h-7 spinner" /></div>
        ) : error ? (
          <Empty icon={<IHeart size={22} />} title="评论加载失败" sub={error} action="重试" onAction={() => void load(1)} />
        ) : (
          <Empty icon={<IHeart size={22} />} title="还没有评论" />
        )}
        {items.length > 0 && (
          <div className="flex justify-center py-4">
            {loading ? <Loader className="w-5 h-5 spinner" />
              : error ? <div role="status" className="flex flex-wrap items-center justify-center gap-2 text-[12px] text-mut"><span>评论加载失败：{error}</span><Button className="px-3 text-primary" onClick={() => void load(retryPage)}>重试</Button></div>
              : page < pages ? (
                <Button onClick={() => load(page + 1)} className="px-4 h-8 rounded-(--r-ctl) bg-s3 text-[12px] text-on/80 pressable">查看更多</Button>
              ) : <span className="text-[12px] text-dim">— 到底啦 —</span>}
          </div>
        )}
      </div>

      {kind === "video" && (
        <Form className="shrink-0 flex items-center gap-2 px-3 py-2.5 bg-s2/70" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <Avatar size={30} name={user?.nickname || "我"} hue={322} />
          <Input ref={inputRef} disabled={sending} value={text} onChange={(e) => setText(e.target.value)}
            readOnly={!user} onClick={() => { if (!user) setLoginOpen(true); }}
            onKeyDown={(event) => { if (!user && event.key === "Enter") { event.preventDefault(); setLoginOpen(true); } }}
            placeholder={user ? "说点什么…" : "登录后参与评论"}
            className="flex-1 min-w-0 h-9 rounded-(--r-ctl) bg-s4 px-3.5 text-[14px] text-on placeholder-dim outline-none focus:bg-s3" />
          <Button type="submit" aria-label="发送评论" disabled={!text.trim() || sending}
            className={`w-9 h-9 rounded-full flex items-center justify-center pressable ${text.trim() ? "brand-grad glow-neon" : "bg-s3 text-dim"}`}>
            {sending ? <Loader className="w-4 h-4 spinner" /> : <ISendF size={16} />}
          </Button>
        </Form>
      )}
    </div>
  );
}
/* ================= 图文正文（吃瓜） ================= */
export function ArticlePanel({ title, html, cover, hot, onClose }: {
  title: string; html: string; cover?: string; hot?: number; onClose: () => void;
}) {
  const { toast, strictSecurity } = useStore();
  const safeHtml = useMemo(() => sanitizeHtml(html), [html, strictSecurity]);
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      copyText(url).then(() => toast("链接已复制", "ok")).catch(() => toast("复制失败", "info"));
    });
  };
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[14px] font-bold text-on">图文详情</span>
        {hot ? <span className="text-[12px] text-mut">{fmt(hot)} 热度</span> : null}
        <Button onClick={onClose} aria-label="关闭" className="ml-auto w-8 h-8 min-h-0 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </Button>
      </div>
      <div className="flex-1 scroll-y px-4 pb-6">
        {cover && <Image src={imageCover(cover)} alt="" className="w-full rounded-(--r-md) mb-3 object-cover" />}
        <h2 className="text-[16px] font-bold text-on leading-snug">{title}</h2>
        <div className="article-body mt-3" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={{ __html: safeHtml }} />
        {!safeHtml && <p className="text-[13px] text-dim mt-4">这篇内容没有正文，可能只有图片或视频。</p>}
      </div>
    </div>
  );
}
