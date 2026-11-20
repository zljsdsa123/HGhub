import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import type { TagItem } from "../../shared/api/types";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { useStore } from "../../shared/model/store";
import { IFireF, IRefresh } from "../../shared/ui/icons";
import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";

const BATCH_SIZE = 12;
const heat = (tag: TagItem) => Number.isFinite(tag.hot_score) ? tag.hot_score! : 0;

/** Use the catalog's actual tag names: keyword search is a different endpoint. */
export function SearchTags({ active }: { active: boolean }) {
  const { push } = useStore();
  const { preferences, isTagBlocked } = useContentPreferences();
  const [tags, setTags] = useState<TagItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [batch, setBatch] = useState(0);
  const busy = useRef(false);
  const sequence = useRef(0);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const token = ++sequence.current;
    setLoading(true); setError("");
    try {
      const response = await api.tags();
      if (!Array.isArray(response?.categories)) throw new Error("标签数据格式异常，请重试");
      const sorted = response.categories.flatMap(group => Array.isArray(group.tags) ? group.tags : [])
        .filter(tag => typeof tag?.name === "string" && tag.name.trim().length > 0)
        .sort((a, b) => Number(!!b.is_hot) - Number(!!a.is_hot) || heat(b) - heat(a));
      const seen = new Set<string>();
      const unique = sorted.filter(tag => {
        if (seen.has(tag.name)) return false;
        seen.add(tag.name);
        return true;
      });
      if (sequence.current !== token) return;
      loaded.current = true;
      setTags(unique); setBatch(0);
    } catch (cause) {
      if (sequence.current === token) setError(cause instanceof Error ? cause.message : "标签加载失败，请重试");
    } finally {
      if (sequence.current === token) { busy.current = false; setLoading(false); }
    }
  }, []);

  useEffect(() => () => { sequence.current++; busy.current = false; }, []);
  useEffect(() => { if (active && !loaded.current) void load(); }, [active, load]);
  const totalLoaded = tags?.length ?? 0;
  const available = tags ? (preferences.paused ? tags : tags.filter(tag => !isTagBlocked(tag.name))) : [];
  const count = available.length;
  const batchCount = Math.max(1, Math.ceil(count / BATCH_SIZE));
  const safeBatch = batch % batchCount;
  const visible = available.slice(safeBatch * BATCH_SIZE, (safeBatch + 1) * BATCH_SIZE);

  return <Surface role="region" aria-label="热门题材" aria-busy={loading}
    className="mt-4 rounded-(--r-md) bg-s2 p-3.5 a-rise">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-on/90"><IFireF size={15} className="text-primary" />热门题材</h2>
      <Button onClick={() => push({ kind: "tags" })} className="-mr-2 px-2 inline-flex items-center justify-end min-h-9 text-[12px] text-primary font-semibold pressable">全部标签 ›</Button>
    </div>
    {error && <p role="status" className="mt-2 text-[12px] text-mut break-words">
      {totalLoaded > 0 ? "刷新失败，保留已加载标签。" : "标签暂未加载成功。"}{error}
    </p>}
    {count > 0 ? <div className="flex flex-wrap gap-2 mt-3">
      {visible.map(tag => <Button key={tag.name}
        onClick={() => push({ kind: "tag", tag: tag.name, name: tag.name })}
        style={{ minBlockSize: 40 }} className="ios-filter-pill min-w-11 max-w-full whitespace-normal break-words text-left text-on/90">{tag.name}</Button>)}
    </div> : !error && <p role="status" className="mt-3 text-[13px] text-mut">
      {loading || tags === null ? "正在加载题材…" : totalLoaded > 0 ? "热门题材均已屏蔽，可在内容偏好中调整" : "暂无可用标签"}
    </p>}
    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
      <Button onClick={() => void load()} disabled={loading} aria-label={error ? "重试加载题材" : "刷新题材"}
        className="-ml-2 px-2 min-h-9 inline-flex items-center gap-1 text-[12px] text-mut pressable">
        {loading ? <Loader className="w-3 h-3" /> : <IRefresh size={13} />}{loading ? "加载中…" : error ? "重试" : "刷新"}
      </Button>
      {count > BATCH_SIZE && <Button onClick={() => setBatch(value => (value + 1) % batchCount)}
        className="-mr-2 px-2 min-h-9 inline-flex items-center justify-end text-[12px] text-primary pressable">换一批</Button>}
    </div>
  </Surface>;
}
