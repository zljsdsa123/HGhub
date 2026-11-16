import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Post, VideoCard } from "./types";

type SearchKind = "video" | "post";
type Result = {
  keyword: string; kind: SearchKind; items: (VideoCard | Post)[];
  page: number; pages: number; total: number | null;
};
type Request = { keyword: string; kind: SearchKind; page: number };
const CACHE_TTL = 60_000;
const CACHE_LIMIT = 8;
const CACHE_ITEMS = 200;

/** Keep query identity together with its cards so pending searches never relabel old content. */
export function useSearchResults(scope?: "original") {
  const [result, setResult] = useState<Result | null>(null);
  const [request, setRequest] = useState<Request | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Result | null>(null);
  const attempt = useRef<Request | null>(null);
  const busy = useRef(false);
  const sequence = useRef(0);
  const cache = useRef(new Map<string, { result: Result; at: number }>());
  useEffect(() => () => { sequence.current++; }, []);

  const publish = (value: Result | null) => { current.current = value; setResult(value); };
  const run = async (next: Request, reuse = false) => {
    if (busy.current && (next.page > 1 || (attempt.current?.keyword === next.keyword
      && attempt.current.kind === next.kind && attempt.current.page === next.page))) return;
    const seq = ++sequence.current;
    attempt.current = next;
    setRequest(next);
    setError(null);
    const key = JSON.stringify([scope, next.kind, next.keyword]);
    const cached = cache.current.get(key);
    if (reuse && cached && Date.now() - cached.at < CACHE_TTL) {
      publish(cached.result);
      busy.current = false;
      setLoading(false);
      return;
    }
    // Same-kind searches keep their old cards and original keyword until replacement arrives.
    // Type switches only display results belonging to the selected type.
    if (current.current?.kind !== next.kind) publish(null);
    busy.current = true;
    setLoading(true);
    try {
      const response = await api.search(next.keyword, next.page, 20, next.kind);
      if (sequence.current !== seq) return;
      const old = current.current;
      const base = next.page > 1 && old?.keyword === next.keyword && old.kind === next.kind ? old.items : [];
      const seen = new Set(base.map(item => item.id));
      const incoming = (response?.items || []).filter(item => !(scope === "original" && next.kind === "video") || item.is_original === 1);
      const items = [...base, ...incoming.filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })];
      const total = response?.pagination?.total;
      const value: Result = { keyword: next.keyword, kind: next.kind, items, page: next.page,
        pages: Math.max(next.page, response?.pagination?.pages || next.page),
        total: scope === "original" || !Number.isFinite(total) || total < items.length ? null : total };
      publish(value);
      cache.current.delete(key);
      if (items.length <= CACHE_ITEMS) cache.current.set(key, { result: value, at: Date.now() });
      while (cache.current.size > CACHE_LIMIT) cache.current.delete(cache.current.keys().next().value!);
    } catch (error) {
      if (sequence.current === seq) setError(error instanceof Error ? error.message : "搜索失败，请重试");
    } finally {
      if (sequence.current === seq) { busy.current = false; setLoading(false); }
    }
  };
  const search = (keyword: string, kind: SearchKind, reuse = false) => {
    const trimmed = keyword.trim();
    if (trimmed) void run({ keyword: trimmed, kind, page: 1 }, reuse);
  };
  const loadMore = () => {
    const data = current.current, latest = attempt.current;
    if (!data || !latest || data.keyword !== latest.keyword || data.kind !== latest.kind || data.page >= data.pages) return;
    void run({ keyword: data.keyword, kind: data.kind, page: data.page + 1 });
  };
  const retry = () => { if (!busy.current && attempt.current) void run(attempt.current); };
  const clear = () => {
    sequence.current++;
    busy.current = false; attempt.current = null;
    publish(null); setRequest(null); setLoading(false); setError(null);
  };
  return { result, request, loading, error, search, loadMore, retry, clear };
}
