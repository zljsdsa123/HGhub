import { Loader } from "../../shared/ui/ios/effects";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import type { VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { ISearch } from "../../shared/ui/icons";
import { Empty } from "../../shared/ui/ui";
import { Button } from "../../shared/ui/ios/controls";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { PreferenceStorageNotice } from "../../shared/ui/PreferenceStorageNotice";

const loadFeed = () => import("./Feed");
const Feed = lazy(loadFeed);

/* Fisher-Yates 洗牌：首页第一页随机打乱，避免每次进来都停在同一个 top1 */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function Home({ active, bottomInset }: { active: boolean; bottomInset: number }) {
  const { toast, lineEpoch, push } = useStore();
  const { preferences, revision, blockReason, storageError } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [excluded, setExcluded] = useState<{ revision: number; epoch: number; ids: number[] }>({ revision, epoch: lineEpoch, ids: [] });
  const autoFill = useRef(1);
  useEffect(() => { autoFill.current = 1; }, [revision, lineEpoch]);
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const mounted = useRef(false);
  const attemptedEpoch = useRef<number | null>(null);
  const [feedMounted, setFeedMounted] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  /* 翻页失败退避：失败后 5 秒内不再因滚动触发重试，连续失败只提示一次 */
  const retryAt = useRef(0);
  const failStreak = useRef(0);
  const lineEpochRef = useRef(lineEpoch);
  lineEpochRef.current = lineEpoch;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const load = useCallback(async (p: number): Promise<void> => {
    if (!activeRef.current || loadingRef.current || (done && p > 1)) return;
    const requestEpoch = lineEpochRef.current;
    if (p === 1) attemptedEpoch.current = requestEpoch;
    let retryAfterLineChange = false;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    if (p === 1) setDone(false);
    try {
      const res = await api.feed(p, 30);
      if (!mounted.current) return;
      if (requestEpoch !== lineEpochRef.current) { retryAfterLineChange = !itemsRef.current.length; return; }
      const list = res?.items || [];
      const ordered = p === 1 ? shuffle(list) : list;
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...ordered.filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      failStreak.current = 0;
      retryAt.current = 0;
      setDone(!list.length || !!(res?.pagination && p >= res.pagination.pages));
    } catch (e) {
      if (!mounted.current) return;
      const message = (e as Error).message || "加载失败";
      const stale = requestEpoch !== lineEpochRef.current;
      if (!stale) {
        setError(message);
        if (p > 1) retryAt.current = Date.now() + 5000;
        if (failStreak.current++ === 0) toast(message, "info");
      }
      /* 请求在旧线路上发出、期间线路已切换：等 finally 里用新线路补拉一次 */
      if (stale && !itemsRef.current.length) retryAfterLineChange = true;
    } finally {
      loadingRef.current = false;
      if (!mounted.current) return;
      setLoading(false);
      if (retryAfterLineChange && activeRef.current) {
        setDone(false);
        setError("");
        void load(1);
      }
    }
  }, [done, toast]);

  /* A never-visited/hidden home does no new work. New-line retries resume on return.
     Loaded pages and an already mounted player remain intact across navigation. */
  useEffect(() => {
    if (!active || items.length || loadingRef.current || attemptedEpoch.current === lineEpoch) return;
    void loadFeed();
    void load(1);
  }, [active, lineEpoch, items.length, load]);
  useEffect(() => { if (active && items.length) setFeedMounted(true); }, [active, items.length]);

  const ids = useMemo(() => {
    const blocked = new Set(excluded.revision === revision && excluded.epoch === lineEpoch ? excluded.ids : []);
    return items.filter(item => !blocked.has(item.id) && !blockReason(item.tags)).map(item => item.id);
  }, [items, excluded, revision, lineEpoch, blockReason]);
  const onBlocked = useCallback((id: number) => setExcluded(previous => {
    const ids = previous.revision === revision && previous.epoch === lineEpoch ? previous.ids : [];
    return ids.includes(id) ? previous : { revision, epoch: lineEpoch, ids: [...ids, id] };
  }), [revision, lineEpoch]);
  const hiddenCount = items.length - ids.length;
  // A fully filtered page may be followed by usable content. Stop after three pages
  // per automatic fill cycle; user-initiated continuation is explicit and bounded.
  useEffect(() => {
    if (!active || !filtering || ids.length || !hiddenCount || loading || loadingRef.current || done || error || autoFill.current >= 3) return;
    autoFill.current++;
    void load(page + 1);
  }, [active, filtering, ids.length, hiddenCount, loading, done, error, page, load, revision]);
  const loadNextFilteredPage = () => { autoFill.current = 1; void load(page + 1); };


  return (
    <div className="absolute inset-0 bg-black flex flex-col">
      {storageError && <div className="shrink-0 bg-bg px-3 pb-2" style={{ paddingTop: "var(--sat, 8px)" }}>
        <PreferenceStorageNotice />
      </div>}
      <div className="relative flex-1 min-h-0">
      {ids.length > 0 && (active || feedMounted) ? (
        <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center"><Loader className="w-9 h-9 spinner" /></div>}>
          <Feed videoIds={ids} mode="home" active={active} bottomInset={bottomInset} onBlocked={onBlocked}
            onNearEnd={() => { if (!loading && !done && Date.now() >= retryAt.current) load(page + 1); }} />
        </Suspense>
      ) : hiddenCount > 0 ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg px-5 pb-24">
          <Empty icon={<ISearch size={26} />} title="已隐藏不感兴趣的内容"
            sub={loading ? "正在补充其他内容…" : error ? `继续加载失败：${error}` : done ? "当前推荐已筛选完，可调整屏蔽标签。" : "已达到本次自动补充上限，可继续加载。"} />
          {loading ? <Loader label="正在补充内容" /> : !done && <Button className="mt-3 px-5 rounded-full bg-s3" onClick={loadNextFilteredPage}>{error ? "重试加载" : "继续加载"}</Button>}
          <Button className="mt-3 px-4 text-primary" onClick={() => push({ kind: "settings", section: "内容偏好" })}>管理屏蔽标签</Button>
        </div>
      ) : !loading && error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Empty icon={<ISearch size={26} />} title="首页加载失败" sub={error} action="重试" onAction={() => void load(1)} />
        </div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg"><Empty icon={<ISearch size={26} />} title="暂无视频" sub="稍后刷新试试" action="刷新" onAction={() => void load(1)} /></div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><Loader className="w-9 h-9 spinner" /></div>
      )}
      </div>
    </div>
  );
}
