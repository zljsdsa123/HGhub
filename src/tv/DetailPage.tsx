import { useEffect, useRef, useState } from "react";
import { api, cover } from "../shared/api/api";
import { useContentPreferences } from "../shared/model/contentPreferences";
import type { Detail } from "../shared/api/types";
import type { TvContent, TvProgress } from "./model";
import { useRemoteScope } from "./remote";
import { TvModal } from "./ui";
import { detailContent, failureMessage, postParts, videoParts, type TvPart } from "./player/content";
import "./player/player.css";

type Props = {
  content: TvContent;
  sourceKey: string;
  progress?: TvProgress;
  favorite: boolean;
  onFavorite: (content: TvContent) => void | Promise<void>;
  onPlay: (content: TvContent, part: string, resumeSeconds?: number) => void;
  onBack: () => void;
  onMetadata?: (content: TvContent) => void;
};

type Loaded = { request: string; content: TvContent; parts: TvPart[] };

export default function DetailPage({ content, sourceKey, progress, favorite, onFavorite, onPlay, onBack, onMetadata }: Props) {
  const preferences = useContentPreferences();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [more, setMore] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [favoritePending, setFavoritePending] = useState(false);
  const transportEpoch = useRef(0);
  const key = `${content.kind}:${content.id}`;
  const sourceReady = !!sourceKey.split("@")[0];
  const request = `${sourceKey}:${key}:${preferences.revision}:${retry}`;
  const latest = useRef({ request, onMetadata }); latest.current = { request, onMetadata };
  const displayed = sourceReady && loaded?.request === request ? loaded : null;
  const item = displayed?.content ?? { ...content, title: "正在读取当前来源…", cover: "", description: undefined, score: undefined };
  const blocked = preferences.blockReason(item.tags);

  useEffect(() => {
    const changed = () => { transportEpoch.current++; setLoaded(null); setMore(false); };
    window.addEventListener("hg:line-changed", changed);
    window.addEventListener("hg:proxy-changed", changed);
    return () => { window.removeEventListener("hg:line-changed", changed); window.removeEventListener("hg:proxy-changed", changed); };
  }, []);

  useEffect(() => {
    let alive = true;
    const transport = transportEpoch.current;
    setError("");
    const current = () => alive && latest.current.request === request && transport === transportEpoch.current;
    if (!sourceReady || preferences.blockReason(content.tags)) return;
    void (async () => {
      const value = content.kind === "video" ? await api.video(content.id) : await api.post(content.id);
      if (!current()) return;
      if (value.id !== content.id) throw new Error("详情信息已变化，请重试");
      const resolved = detailContent(content, value);
      latest.current.onMetadata?.(resolved);
      if (preferences.blockReason(resolved.tags)) {
        setLoaded({ request, content: resolved, parts: [] }); return;
      }
      if (content.kind === "video") {
        setLoaded({ request, content: resolved, parts: videoParts(value as Detail) });
      } else {
        // Resolve segment identities only. The URLs stay in this request and are never saved.
        const playback = await api.postPlayback(content.id);
        if (!current() || preferences.blockReason(resolved.tags)) return;
        const parts = postParts(playback.videos);
        if (!parts.length) throw new Error("暂未确认可播放的视频分段，请重试");
        setLoaded({ request, content: resolved, parts });
      }
    })().catch(cause => { if (current()) setError(failureMessage(cause, "详情加载失败，请重试")); });
    return () => { alive = false; };
  }, [request]);

  useEffect(() => { setMore(false); setSelectedTags([]); }, [key, sourceKey, preferences.revision]);
  useRemoteScope({ id: `detail:${key}`, priority: 20, onKey: remote => {
    if (remote === "back") { onBack(); return true; }
    return false;
  } });

  const parts = displayed?.parts ?? [];
  const matchedIndex = progress?.key === key ? parts.findIndex(part => part.id === progress.part) : -1;
  const matchedPart = matchedIndex >= 0 ? parts[matchedIndex] : undefined;
  const resumable = !!matchedPart;
  const finishedCurrent = resumable && !!matchedPart?.duration && matchedPart.duration > 0
    && progress!.seconds >= Math.max(1, matchedPart.duration - 3);
  const nextPart = finishedCurrent ? parts[matchedIndex + 1] : undefined;
  const resumeSeconds = resumable && !finishedCurrent && progress!.seconds > 0 ? progress!.seconds : 0;
  const firstPart = nextPart ? nextPart.id : resumable ? progress!.part : parts[0]?.id;
  const toggleFavorite = async () => {
    if (!displayed || favoritePending) return;
    setFavoritePending(true);
    try { await onFavorite(item); }
    catch (cause) { setError(failureMessage(cause, "收藏保存失败，请重试")); }
    finally { setFavoritePending(false); }
  };

  return <section className="tv-detail" aria-label="作品详情">
    <div data-tv-region="detail-back"><button data-tv-focus={`detail:${key}:back`} onClick={onBack}>返回列表</button></div>
    {blocked ? <div className="tv-detail-message" role="status"><h1>内容已屏蔽</h1><p>{blocked}</p><p>你可以在设置中调整标签偏好。</p></div> : <>
      <div className="tv-detail-hero">
        <div className={`tv-detail-cover ${content.kind === "post" ? "tv-detail-cover-wide" : ""}`}>
          {displayed && item.cover ? <img src={cover(item.cover)} alt={`${item.title}封面`} /> : <span>HGhubX</span>}
        </div>
        <div className="tv-detail-copy">
          <h1>{item.title}</h1>
          <p className="tv-detail-meta">{item.score ? `${item.score.toFixed(1)} 分 · ` : ""}{parts.length ? `${parts.length} ${content.kind === "post" ? "个视频分段" : "集"}` : displayed ? "暂无可播放剧集" : "正在读取详情"}</p>
          {item.description && <p className="tv-detail-description">{item.description}</p>}
          <div className="tv-detail-tags" aria-label="标签">{displayed?.content.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
          <div className="tv-detail-actions" data-tv-region="detail-actions">
            <button data-tv-focus={`detail:${key}:play`} className="tv-primary" disabled={!firstPart} onClick={() => firstPart && onPlay(item, firstPart, resumeSeconds)}>{resumeSeconds > 0 || nextPart ? "继续观看" : resumable && progress!.seconds > 0 ? "重新播放" : "播放"}</button>
            <button data-tv-focus={`detail:${key}:favorite`} aria-pressed={favorite} disabled={!displayed || favoritePending} onClick={() => void toggleFavorite()}>{favorite ? "取消收藏" : "收藏"}</button>
            <button data-tv-focus={`detail:${key}:episodes`} disabled={!parts.length} onClick={() => document.querySelector<HTMLButtonElement>(".tv-detail-episodes [data-tv-focus]")?.focus()}>{content.kind === "post" ? "选择分段" : "选集"}</button>
            <button data-tv-focus={`detail:${key}:more`} disabled={!displayed || !item.tags.length} onClick={() => { setSelectedTags([]); setMore(true); }}>更多</button>
          </div>
        </div>
      </div>
      {error ? <div className="tv-detail-message" role="alert"><p>{error}</p><div data-tv-region="detail-retry"><button data-tv-focus={`detail:${key}:retry`} onClick={() => setRetry(value => value + 1)}>重试</button></div></div> : !displayed ? <p role="status">正在加载详情…</p> : null}
      {!!parts.length && <div className="tv-detail-episodes"><h2>{content.kind === "post" ? "视频分段" : "剧集"}</h2><div className="tv-detail-episode-grid" data-tv-region="detail-episodes" data-tv-columns="5">
        {parts.map(part => {
          const partResume = progress?.key === key && progress.part === part.id
            && !(part.duration && part.duration > 0 && progress.seconds >= Math.max(1, part.duration - 3))
            ? progress.seconds : 0;
          return <button key={part.id} data-tv-focus={`detail:${key}:part:${part.id}`} title={part.label} onClick={() => onPlay(item, part.id, partResume)}><span>{part.label}</span>{resumable && progress!.part === part.id ? <small>上次观看</small> : null}</button>;
        })}
      </div></div>}
    </>}
    {more && !blocked && <TvModal id={`detail-tags:${key}`} title="屏蔽标签" onClose={() => setMore(false)}>
      <p>选择当前作品的标签。屏蔽后，相关内容会立即隐藏。</p>
      <div data-tv-region="detail-tag-options" data-tv-columns="3" className="tv-detail-tag-grid">{item.tags.map(tag => <button key={tag} data-tv-focus={`block:${tag}`} aria-pressed={selectedTags.includes(tag)} onClick={() => setSelectedTags(previous => previous.includes(tag) ? previous.filter(value => value !== tag) : [...previous, tag])}>{selectedTags.includes(tag) ? "已选 · " : ""}{tag}</button>)}</div>
      <div data-tv-region="detail-tag-confirm"><button data-tv-focus="block-confirm" disabled={!selectedTags.length} onClick={() => { preferences.blockTags(selectedTags); setMore(false); }}>屏蔽所选标签</button><button data-tv-focus="block-cancel" onClick={() => setMore(false)}>取消</button></div>
    </TvModal>}
  </section>;
}
