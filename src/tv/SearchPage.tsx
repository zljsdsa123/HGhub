import { useCallback, useEffect, useRef, useState } from "react";
import { cover } from "../shared/api/api";
import { blockReason, useContentPreferences } from "../shared/model/contentPreferences";
import { contentKey, type TvContent } from "./model";
import { qualifyVisiblePosts } from "./postEligibility";
import { queryCatalog, retryCatalog, startCatalog, useCatalogStatus } from "./search/catalog";
import "./search/search.css";

const KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
type Results = { identity: string; items: TvContent[]; offset: number; hasMore: boolean; total: number; retryable: number; loading: boolean; error: string };
const initial = (identity: string): Results => ({ identity, items: [], offset: 0, hasMore: false, total: 0, retryable: 0, loading: false, error: "" });

export default function SearchPage({ source, paused, onOpen }: { source: string; paused: boolean; onOpen: (content: TvContent) => void }) {
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const preferences = useContentPreferences();
  const status = useCatalogStatus(source);
  const identity = `${source}|${term}|${preferences.revision}`;
  const [results, setResults] = useState<Results>(() => initial(identity));
  const state = useRef(results); state.current = results;
  const context = useRef({ identity, source, paused, preferences: preferences.preferences });
  context.current = { identity, source, paused, preferences: preferences.preferences };
  const sequence = useRef(0);
  const busy = useRef(false);
  const loadedCount = useRef(-1);

  useEffect(() => { if (source) startCatalog(source); }, [source]);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(query), 220);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (append = false, retry = false) => {
    if (busy.current || !source || paused) return;
    const token = ++sequence.current;
    const key = identity;
    const current = () => token === sequence.current && context.current.identity === key && !context.current.paused;
    const allowed = (content: TvContent) => !blockReason(content.tags, context.current.preferences);
    busy.current = true;
    const previous = append && state.current.identity === key ? state.current : initial(key);
    const retained = state.current.identity === key ? state.current : initial(key);
    setResults({ ...retained, loading: true, error: "" });
    let offset = previous.offset, found = [...previous.items], retryable = previous.retryable, hasMore = false, total = previous.total;
    try {
      // One current page plus at most two extra pages. The next step is explicit.
      for (let extra = 0; extra <= 2; extra++) {
        const page = await queryCatalog(source, term, offset, context.current.preferences);
        if (!current()) return;
        const eligible = await qualifyVisiblePosts(page.items, { source, isCurrent: current, allowed }, retry);
        if (!current()) return;
        const playable = new Set(eligible.items.map(contentKey));
        const seen = new Set(found.map(contentKey));
        found = [...found, ...page.items.filter(item => allowed(item) && (item.kind === "video" || playable.has(contentKey(item))) && !seen.has(contentKey(item)))];
        retryable += eligible.retryable;
        offset = page.nextOffset; hasMore = page.hasMore; total = page.total;
        if (found.length >= previous.items.length + 20 || !hasMore) break;
      }
      if (current()) setResults({ identity: key, items: found, offset, hasMore, total, retryable, loading: false, error: "" });
    } catch (error) {
      if (current()) setResults({ ...retained, loading: false, error: error instanceof Error ? error.message : String(error) });
    } finally { if (token === sequence.current) busy.current = false; }
  }, [source, paused, identity, term]);

  useEffect(() => {
    sequence.current++; busy.current = false;
    if (paused) {
      setResults(previous => previous.loading ? { ...previous, loading: false } : previous);
      return;
    }
    if (state.current.identity !== identity) setResults(initial(identity));
    loadedCount.current = status.count;
    void load();
    return () => { sequence.current++; busy.current = false; };
  }, [load]);
  useEffect(() => {
    if (!status.initialized || busy.current || loadedCount.current === status.count) return;
    loadedCount.current = status.count;
    // Metadata updates only replace results; they never move the keyboard focus.
    void load();
  }, [status.count, status.initialized, results.loading, load]);

  const visible = results.identity === identity ? results : initial(identity);
  const progress = status.channels.map(channel => `${channel.kind === "video" ? "影片" : "吃瓜"} ${Math.max(0, channel.nextPage - 1)}/${channel.pages ?? "?"} 页`).join(" · ");
  return <section className="tv-search" aria-label="首字母搜索">
    <header><h1>搜索</h1></header>
    <div className="tv-search-layout">
      <div className="tv-search-input">
        <output className="tv-search-query" aria-live="polite" aria-label="当前搜索">{query || "选择字母开始"}</output>
        <div className="tv-search-keyboard" data-tv-region="search-keyboard" data-tv-columns="6">
          {KEYS.map(key => <button key={key} data-tv-focus={`search:key:${key}`} type="button" onClick={() => setQuery(value => `${value}${key}`.slice(0, 48))}>{key}</button>)}
        </div>
        <div className="tv-search-actions" data-tv-region="search-edit" data-tv-columns="2">
          <button data-tv-focus="search:delete" type="button" onClick={() => setQuery(value => value.slice(0, -1))}>删除</button>
          <button data-tv-focus="search:clear" type="button" onClick={() => setQuery("")}>清空</button>
        </div>
      </div>
      <div className="tv-search-results">
        <div className="tv-search-status" role="status">
          <p>已收录 {status.count} 项{status.complete ? " · 目录同步完成" : " · 目录尚未完成"}</p>
          <p>{status.error ? `同步已停止：${status.error}` : status.paused ? "播放或后台期间暂停同步" : status.syncing ? `正在同步 · ${progress}` : progress || "首次搜索正在准备目录"}</p>
          {status.updatedAt > 0 && <p>最近完整更新：{new Date(status.updatedAt).toLocaleString("zh-CN")}</p>}
        </div>
        <div className="tv-search-actions" data-tv-region="search-catalog-actions" data-tv-columns="2">
          {status.error && <button data-tv-focus="search:retry-catalog" type="button" onClick={() => void retryCatalog(source)}>重试同步</button>}
          <button data-tv-focus="search:refresh-catalog" type="button" onClick={() => void retryCatalog(source, true)}>刷新目录</button>
        </div>
        {visible.error && <p role="alert">{visible.error}</p>}
        <div className="tv-search-grid" data-tv-region="search-results" data-tv-columns="3" aria-busy={visible.loading}>
          {visible.items.filter(item => !preferences.blockReason(item.tags)).map(item => <button key={contentKey(item)} type="button" className={`tv-card ${item.kind === "post" ? "tv-card-wide" : ""}`} data-tv-focus={`search:${contentKey(item)}`} onClick={() => onOpen(item)}>
            {item.cover && <img src={cover(item.cover)} alt="" loading="lazy" />}
            <span className="tv-card-title">{item.title}</span>
            <span className="tv-muted">{item.kind === "post" ? "吃瓜视频" : `${item.episodeCount ?? "—"} 集`}</span>
          </button>)}
        </div>
        {visible.loading && <p role="status">正在搜索并确认当前页视频…</p>}
        {!visible.loading && !visible.items.length && !visible.error && <p>{status.complete ? "当前已收录目录中暂无可展示的匹配内容。" : "当前已收录目录暂无匹配；目录尚未完成，请稍后再试。"}</p>}
        {visible.retryable > 0 && <p>{visible.retryable} 项视频资格尚未确认，可重试。</p>}
        <div className="tv-search-actions" data-tv-region="search-load" data-tv-columns="2">
          {(visible.hasMore || visible.loading) && <button data-tv-focus="search:load-more" disabled={visible.loading} type="button" onClick={() => void load(true)}>继续加载</button>}
          {(visible.retryable > 0 || visible.error) && <button data-tv-focus="search:retry-results" disabled={visible.loading} type="button" onClick={() => void load(false, true)}>重试结果</button>}
        </div>
      </div>
    </div>
  </section>;
}
