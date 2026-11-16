import { Button, Form, Input } from "./ios/controls";
import { Loader } from "./ios/effects";
import { useEffect, useRef, useState } from "react";
import { fmt } from "../api";
import type { Post, VideoCard } from "../types";
import { MediaCard, Masonry } from "./cards";
import { FilteredContent } from "./FilteredContent";
import { Empty } from "./ui";
import { IBack, IClose, ISearch } from "../icons";
import { useSearchResults } from "../useSearchResults";
import { useDialogFocusTrap } from "./ios/dialogFocus";
import { registerOverlayBack } from "../back";

/** 栏目内搜索保持自身范围；与全局搜索共用请求、缓存和失败恢复逻辑。 */
export function InplaceSearch({ kind, postLabel = "吃瓜帖", scope, onOpenVideo, onOpenPost, onClose, wide }: {
  kind: "video" | "post";
  postLabel?: string;
  scope?: "original";
  onOpenVideo?: (v: VideoCard, list: VideoCard[]) => void;
  onOpenPost?: (p: Post) => void;
  onClose: () => void;
  wide?: boolean;
}) {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const results = useSearchResults(scope);
  const { result, request, loading, error } = results;
  const items = result?.kind === "video" ? result.items as VideoCard[] : [];
  const posts = result?.kind === "post" ? result.items as Post[] : [];
  const count = result?.items.length ?? 0;
  const videoLabel = scope === "original" ? "原创" : "短剧";
  const label = kind === "post" ? postLabel : videoLabel;
  useDialogFocusTrap(true, rootRef, onClose);
  const submit = (keyword: string) => {
    const trimmed = keyword.trim();
    if (!trimmed) return;
    setQ(trimmed); setSubmitted(trimmed);
    results.search(trimmed, kind);
  };

  useEffect(() => registerOverlayBack(() => {
    const root = rootRef.current;
    // Stack pages stay mounted under the next page. A hidden search must not consume
    // the hardware back event that belongs to the page currently on top.
    if (!root || root.closest("[inert]")) return false;
    closeRef.current();
    return true;
  }), []);

  return (
    <div ref={rootRef} role="dialog" aria-modal="true" aria-label={`${label}搜索`} tabIndex={-1}
      onKeyDown={event => event.stopPropagation()}
      className="ios-page ios-inplace-search absolute inset-0 z-20 bg-bg flex flex-col outline-none">
      <div className="shrink-0 px-4 pb-3 flex items-center gap-2.5 bg-s1" style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}>
        <Button onClick={onClose} className="w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable" aria-label="退出搜索"><IBack size={19} /></Button>
        <Form className="flex-1 min-w-0 flex items-center gap-2 h-11 rounded-(--r-ctl) bg-s3 px-3.5 focus-within:bg-s4 transition-colors"
          onSubmit={(e) => { e.preventDefault(); submit(q); }}>
          <ISearch size={17} className="text-mut shrink-0" />
          <Input ref={inputRef} data-autofocus aria-label={`${label}搜索关键词`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`搜索${label}…`}
            className="flex-1 min-w-0 bg-transparent text-[14px] text-on placeholder-dim outline-none" />
          {q && <Button aria-label="清空搜索" type="button" onClick={() => { results.clear(); setQ(""); setSubmitted(""); inputRef.current?.focus(); }} className="ios-icon-button ios-search-clear"><IClose size={16} /></Button>}
        </Form>
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-8">
        {!submitted ? (
          <div className="flex justify-center py-20"><span className="text-[13px] text-mut">输入关键词，在本栏目内搜索{label}</span></div>
        ) : <>
          <div role="status" aria-live="polite" className="text-[12px] text-mut mb-2.5">
            {loading && <span className="block">{request?.page === 1 ? `正在搜索「${submitted}」…` : "正在加载更多…"}</span>}
            {result && <>「{result.keyword}」已加载 <span className="text-primary font-bold">{count}{result.total !== null ? ` / ${result.total}` : ""}</span> 条{label}</>}
          </div>
          {error && <div role="alert" className="flex flex-wrap items-center gap-2 mb-3 text-[13px] text-danger">
            <span>「{submitted}」{request?.page && request.page > 1 ? "加载更多失败" : "搜索失败"}：{error}</span>
            <Button onClick={results.retry} disabled={loading} className="px-3 text-primary">重试</Button>
          </div>}
          <section aria-label="栏目搜索结果" aria-busy={loading}>
            {result && count > 0 ? <>
              {kind === "post" ? (
                <FilteredContent items={posts} scopeKey={JSON.stringify([submitted, kind, scope, result.keyword, result.kind])}>{visible => <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
                  {visible.map((post) => (
                    <MediaCard key={post.id} title={post.title} cover={post.cover} subtitle={`${fmt(post.hot)} 次浏览`} onOpen={() => onOpenPost?.(post)} />
                  ))}
                </div>}</FilteredContent>
              ) : <Masonry videos={items} scopeKey={JSON.stringify([submitted, kind, scope, result.keyword, result.kind])} wide={wide} onOpen={(v) => onOpenVideo?.(v, items)} />}
            </> : loading ? <div className="flex justify-center py-12"><Loader label="正在搜索" className="w-8 h-8 spinner" /></div>
              : !error && <Empty icon={<ISearch size={26} />}
                title={result && result.page < result.pages ? "已加载页面没有匹配内容" : "没有找到相关内容"}
                sub={result && result.page < result.pages ? "继续加载，看看后面的搜索结果" : "换个关键词试试"} />}
            {result && <div className="flex justify-center py-4">
              {loading && count > 0 ? <Loader label="搜索结果更新中" className="w-6 h-6 spinner" />
                : !loading && !error && result.keyword === submitted && (result.page < result.pages
                  ? <Button onClick={results.loadMore} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on/85 pressable">加载更多</Button>
                  : count > 0 && <span className="text-[12px] text-dim">— 已经到底啦 —</span>)}
            </div>}
          </section>
        </>}
      </div>
    </div>
  );
}
