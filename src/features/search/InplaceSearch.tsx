import { Button, Form, Input } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useEffect, useRef, useState } from "react";
import { fmt } from "../../shared/api/api";
import type { Post, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { MediaCard, Masonry } from "../../shared/ui/cards";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { Empty } from "../../shared/ui/ui";
import { IBack, IClose, ISearch } from "../../shared/ui/icons";
import { useSearchResults } from "./useSearchResults";
import { useDialogFocusTrap } from "../../shared/ui/ios/dialogFocus";
import { registerOverlayBack } from "../../shared/lib/back";

/** 栏目内搜索保持自身范围；与全局搜索共用请求、缓存和失败恢复逻辑。 */
export function InplaceSearch({ kind, postLabel = "吃瓜帖", scope, onOpenVideo, onOpenPost, onClose, wide }: {
  kind: "video" | "post";
  postLabel?: string;
  scope?: "original";
  onOpenVideo?: (v: VideoCard, list: VideoCard[], keyword: string) => void;
  onOpenPost?: (p: Post) => void;
  onClose: () => void;
  wide?: boolean;
}) {
  const { searchHist, addSearch, clearSearchHist } = useStore();
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
    if (!scope) addSearch(trimmed);
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
      className="ios-page ios-inplace-search absolute inset-0 z-30 bg-bg flex flex-col outline-none">
      <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="ios-subpage-bar">
          <Button onClick={onClose} className="ios-nav-btn" aria-label="退出搜索"><IBack size={20} /></Button>
          <Form className="flex-1 min-w-0 flex items-center gap-2 h-11 rounded-(--r-ctl) bg-s3 px-3.5 focus-within:bg-s4 transition-colors"
            onSubmit={(e) => { e.preventDefault(); submit(q); }}>
            <ISearch size={17} className="text-mut shrink-0" />
            <Input ref={inputRef} data-autofocus aria-label={`${label}搜索关键词`} value={q}
              onChange={(e) => {
                const next = e.target.value;
                setQ(next);
                if (!next && submitted) { setSubmitted(""); results.clear(); }
              }}
              placeholder={`搜索${label}…`}
              className="flex-1 min-w-0 bg-transparent text-[14px] text-on placeholder-dim outline-none" />
            {(q || submitted) && <Button aria-label="清空搜索" type="button" onClick={() => { results.clear(); setQ(""); setSubmitted(""); inputRef.current?.focus(); }} className="ios-icon-button ios-search-clear"><IClose size={16} /></Button>}
          </Form>
        </div>
      </div>

      <div className="flex-1 scroll-y pt-3.5 pb-8">
        {!submitted ? (
          !scope && searchHist.length > 0 ? (
            <div className="mt-1 a-rise">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[14px] font-bold text-on">搜索历史</span>
                <Button onClick={clearSearchHist} className="-mr-2 px-2 inline-flex items-center justify-end text-[12px] text-dim pressable">清空</Button>
              </div>
              <div className="flex flex-wrap gap-2 mt-2.5">
                {searchHist.map((h) => (
                  <Button key={h} onClick={() => submit(h)} className="ios-filter-pill text-on/85">{h}</Button>
                ))}
              </div>
            </div>
          ) : null
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
              ) : <Masonry videos={items} scopeKey={JSON.stringify([submitted, kind, scope, result.keyword, result.kind])} wide={wide} onOpen={(v, visible) => onOpenVideo?.(v, visible, result.keyword)} />}
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
