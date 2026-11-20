import { useEffect, useRef, useState } from "react";
import { api, fmtTime } from "../shared/api/api";
import VideoSurface, { type VideoHandle } from "../features/playback/VideoSurface";
import { useContentPreferences } from "../shared/model/contentPreferences";
import type { Detail } from "../shared/api/types";
import type { TvContent, TvProgress } from "./model";
import { useRemoteScope } from "./remote";
import { TvModal } from "./ui";
import { detailContent, failureMessage, playStreams, postParts, videoParts, type TvPart, type TvStreams } from "./player/content";
import "./player/player.css";

type Quality = "main" | "hevc";
type Props = {
  content: TvContent;
  sourceKey: string;
  part: string;
  resumeSeconds?: number;
  favorite: boolean;
  rate?: number;
  quality?: Quality;
  autoNext?: boolean;
  onFavorite: (content: TvContent) => void | Promise<void>;
  onProgress: (progress: TvProgress) => void | Promise<void>;
  onBack: () => void;
  onMetadata?: (content: TvContent) => void;
  onPartChange?: (part: string) => void;
  onPreferencesChange?: (preferences: { rate: number; quality: Quality }) => void | Promise<void>;
};

type Prepared = { request: string; content: TvContent; parts: TvPart[]; streams: TvStreams; serial: number; transportEpoch: number };
type Clock = { key: string; content: TvContent; part: string; seconds: number; duration: number; ready: boolean };
const finiteSeconds = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, value || 0) : 0;

export default function PlayerPage({ content, sourceKey, part: initialPart, resumeSeconds = 0, favorite, rate: initialRate = 1, quality: initialQuality = "main", autoNext = true, onFavorite, onProgress, onBack, onMetadata, onPartChange, onPreferencesChange }: Props) {
  const preferences = useContentPreferences();
  const key = `${content.kind}:${content.id}`;
  const [part, setPart] = useState(initialPart);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [denied, setDenied] = useState<{ request: string; content: TvContent } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [preferenceError, setPreferenceError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [time, setTime] = useState(finiteSeconds(resumeSeconds));
  const [duration, setDuration] = useState(0);
  const [controls, setControls] = useState(true);
  const [activity, setActivity] = useState(0);
  const [seek, setSeek] = useState<number | null>(null);
  const [modal, setModal] = useState<"parts" | "options" | "ended" | null>(null);
  const [rate, setRate] = useState(initialRate);
  const [quality, setQuality] = useState<Quality>(initialQuality);
  const [foreground, setForeground] = useState(!document.hidden);
  const [favoritePending, setFavoritePending] = useState(false);
  const video = useRef<VideoHandle>(null);
  const wanted = useRef(true);
  const mounted = useRef(true);
  const serial = useRef(0);
  const transportEpoch = useRef(0);
  const endedSession = useRef("");
  const restoredSession = useRef("");
  const pendingRestore = useRef(finiteSeconds(resumeSeconds));
  const clock = useRef<Clock>({ key, content, part: initialPart, seconds: finiteSeconds(resumeSeconds), duration: 0, ready: false });
  const lastSaved = useRef(0);
  const prefetched = useRef(new Map<string, { streams: TvStreams; at: number }>());
  const sourceReady = !!sourceKey.split("@")[0];
  const request = `${sourceKey}:${key}:${part}:${preferences.revision}:${attempt}`;
  const loaded = sourceReady && prepared?.request === request ? prepared : null;
  const item = denied?.request === request ? denied.content : loaded?.content ?? { ...content, title: "正在读取当前来源…", cover: "", description: undefined };
  const blocked = preferences.blockReason(item.tags);
  const mediaSrc = loaded ? (quality === "hevc" ? loaded.streams.hevc || loaded.streams.main : loaded.streams.main) : "";
  const session = loaded ? `${request}:${loaded.serial}:${quality}` : "";
  const latest = useRef({ request, session, blocked, onProgress, onMetadata, onBack, onPartChange, onPreferencesChange });
  latest.current = { request, session, blocked, onProgress, onMetadata, onBack, onPartChange, onPreferencesChange };

  const persist = () => {
    const current = clock.current;
    if (!current.ready) return;
    const progress: TvProgress = { key: current.key, content: current.content, part: current.part, seconds: finiteSeconds(current.seconds), duration: finiteSeconds(current.duration), updatedAt: Date.now() };
    lastSaved.current = Date.now();
    try {
      Promise.resolve(latest.current.onProgress(progress)).then(() => { if (mounted.current) setSaveError(""); }).catch(cause => {
        if (mounted.current) setSaveError(failureMessage(cause, "观看进度保存失败，请重试"));
      });
    } catch (cause) { if (mounted.current) setSaveError(failureMessage(cause, "观看进度保存失败，请重试")); }
  };
  const persistRef = useRef(persist); persistRef.current = persist;
  const currentSession = (token: string) => mounted.current && !!token && token === latest.current.session && !!loaded && loaded.transportEpoch === transportEpoch.current && !latest.current.blocked && !preferences.blockReason(loaded.content.tags);
  const interact = () => { setControls(true); setActivity(value => value + 1); };
  const showControls = () => {
    interact();
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-tv-focus="player:play"]')?.focus({ preventScroll: true }));
  };

  useEffect(() => {
    mounted.current = true;
    const visibility = () => {
      if (document.hidden) persistRef.current();
      setForeground(!document.hidden);
    };
    const pagehide = () => persistRef.current();
    const sourceChanged = () => {
      persistRef.current(); transportEpoch.current++; setPrepared(null); setDenied(null);
      setPlaying(false); setWaiting(true); setModal(null); setSeek(null); setControls(true);
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("hg:line-changed", sourceChanged);
    window.addEventListener("hg:proxy-changed", sourceChanged);
    const timer = window.setInterval(() => { if (!document.hidden) persistRef.current(); }, 5000);
    return () => {
      persistRef.current(); mounted.current = false;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("hg:line-changed", sourceChanged);
      window.removeEventListener("hg:proxy-changed", sourceChanged);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const transport = transportEpoch.current;
    const current = () => alive && mounted.current && latest.current.request === request && transport === transportEpoch.current;
    setError(""); setWaiting(true); setPlaying(false); setSeek(null); setModal(null); setControls(true);
    persistRef.current();
    if (clock.current.key !== key || clock.current.part !== part) {
      clock.current = { key, content, part, seconds: 0, duration: 0, ready: false };
      setTime(0); setDuration(0); wanted.current = true;
    }
    pendingRestore.current = clock.current.seconds;
    restoredSession.current = "";
    if (!sourceReady) return;
    if (preferences.blockReason(content.tags)) { setWaiting(false); return; }
    void (async () => {
      const value = content.kind === "video" ? await api.video(content.id) : await api.post(content.id);
      if (!current()) return;
      if (value.id !== content.id) throw new Error("作品信息已变化，请返回详情重试");
      const resolved = detailContent(content, value);
      latest.current.onMetadata?.(resolved);
      if (preferences.blockReason(resolved.tags)) {
        setDenied({ request, content: resolved }); setWaiting(false); return;
      }
      let parts: TvPart[], streams: TvStreams;
      if (content.kind === "video") {
        parts = videoParts(value as Detail);
        if (!parts.some(candidate => candidate.id === part)) throw new Error("当前剧集已变化，请返回详情重新选集");
        const cacheKey = `${sourceKey}:${key}:${preferences.revision}:${part}`;
        const cached = prefetched.current.get(cacheKey);
        streams = cached && Date.now() - cached.at < 120000 ? cached.streams : playStreams(await api.play(content.id, Number(part)), content.id, part);
        prefetched.current.delete(cacheKey);
      } else {
        // Fresh resolution on every entry/change. No temporary URL goes into progress or IndexedDB.
        const result = await api.postPlayback(content.id);
        parts = postParts(result.videos);
        const segment = result.videos?.find(candidate => String(candidate.index) === part && candidate.url?.trim());
        if (!segment || !parts.some(candidate => candidate.id === part)) throw new Error("当前视频分段暂不可用，请重试或返回详情选择分段");
        streams = { main: segment.url };
      }
      if (!current() || preferences.blockReason(resolved.tags)) return;
      clock.current.content = resolved;
      setPrepared({ request, content: resolved, parts, streams, serial: ++serial.current, transportEpoch: transport });
    })().catch(cause => {
      if (current()) { setError(failureMessage(cause, "播放地址加载失败，请重试")); setWaiting(false); }
    });
    return () => { alive = false; };
  }, [request]);

  useEffect(() => { prefetched.current.clear(); }, [sourceKey, key, preferences.revision]);

  useEffect(() => {
    if (!playing || !foreground || !loaded || blocked || content.kind !== "video") return;
    const index = loaded.parts.findIndex(candidate => candidate.id === part);
    const next = loaded.parts[index + 1];
    if (!next) return;
    let alive = true;
    const cacheKey = `${sourceKey}:${key}:${preferences.revision}:${next.id}`;
    const timer = window.setTimeout(() => {
      if (document.hidden || !currentSession(session) || prefetched.current.has(cacheKey)) return;
      void api.play(content.id, Number(next.id)).then(info => {
        if (!alive || !currentSession(session) || document.hidden) return;
        prefetched.current.clear();
        prefetched.current.set(cacheKey, { streams: playStreams(info, content.id, next.id), at: Date.now() });
      }).catch(() => { /* The current episode is unaffected; selecting next retries normally. */ });
    }, 1200);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [playing, foreground, session, blocked]);

  useEffect(() => {
    if (!controls || !playing || waiting || !foreground || seek !== null || modal || error || blocked) return;
    const timer = window.setTimeout(() => setControls(false), 4000);
    return () => window.clearTimeout(timer);
  }, [controls, playing, waiting, foreground, seek, modal, activity, error, blocked]);

  const changePart = (next: string) => {
    if (!loaded?.parts.some(candidate => candidate.id === next) || next === part) return;
    persist(); wanted.current = true; setPart(next); setModal(null); setSeek(null); interact();
    latest.current.onPartChange?.(next);
  };
  const stepPart = (delta: number) => {
    if (!loaded) return;
    const index = loaded.parts.findIndex(candidate => candidate.id === part);
    const target = loaded.parts[index + delta];
    if (target) changePart(target.id);
  };
  const exit = () => { persist(); wanted.current = false; video.current?.pause(); latest.current.onBack(); };
  const pause = () => { wanted.current = false; video.current?.pause(); setPlaying(false); interact(); persist(); };
  const play = () => {
    if (session && endedSession.current === session) { replay(); return; }
    wanted.current = true; video.current?.play(); interact();
  };
  const toggle = () => { if (playing || wanted.current && waiting) pause(); else play(); };
  const previewSeek = (delta: number) => {
    interact();
    if (!duration || !loaded || blocked) return;
    setSeek(previous => Math.max(0, Math.min(Math.max(0, duration - .15), (previous ?? time) + delta)));
  };
  const commitSeek = () => {
    if (seek === null) return;
    try {
      video.current?.seek(seek, "tv_remote"); clock.current.seconds = seek; setTime(seek); setSeek(null); persist(); interact();
    } catch { setError("跳转未完成，请重试"); }
  };
  const retryPlayback = () => { persist(); setAttempt(value => value + 1); interact(); };
  const replay = () => {
    clock.current.seconds = 0; pendingRestore.current = 0; wanted.current = true;
    setTime(0); setAttempt(value => value + 1); setModal(null); interact();
  };
  const onEnded = (token: string) => {
    if (!currentSession(token) || endedSession.current === token || document.hidden || !wanted.current) return;
    const element = video.current?.el();
    // VideoSurface also emits near-end from timeupdate. A paused seek/background
    // clock update must not navigate; the actual ended event remains eligible.
    if (!element || element.paused && !element.ended) return;
    endedSession.current = token;
    clock.current.seconds = clock.current.duration || clock.current.seconds;
    persist(); setPlaying(false); setWaiting(false); interact();
    const index = loaded!.parts.findIndex(candidate => candidate.id === part);
    const next = loaded!.parts[index + 1];
    if (next && autoNext) changePart(next.id);
    else { wanted.current = false; setModal("ended"); }
  };
  const restore = (token: string, value: number) => {
    if (!currentSession(token) || !Number.isFinite(value) || value <= 0) return;
    clock.current.duration = value; clock.current.ready = true; setDuration(value);
    if (restoredSession.current === token) return;
    try {
      const target = pendingRestore.current >= Math.max(1, value - 3)
        ? 0
        : Math.min(pendingRestore.current, Math.max(0, value - .15));
      if (target > 0) video.current?.seek(target, "tv_resume");
      clock.current.seconds = target; setTime(target); restoredSession.current = token; setWaiting(false);
      if (!wanted.current) video.current?.pause();
    } catch { /* Loaded-data/time callbacks may retry while the media is still attaching. */ }
  };
  const persistPreferences = (next: { rate: number; quality: Quality }) => {
    setPreferenceError("");
    try {
      Promise.resolve(latest.current.onPreferencesChange?.(next)).catch(cause => {
        if (mounted.current) setPreferenceError(`本次设置已生效，但保存失败：${failureMessage(cause, "请重试")}`);
      });
    } catch (cause) { setPreferenceError(`本次设置已生效，但保存失败：${failureMessage(cause, "请重试")}`); }
  };
  const changeQuality = (next: Quality) => {
    if (next === quality || next === "hevc" && !loaded?.streams.hevc) return;
    persist(); pendingRestore.current = clock.current.seconds; restoredSession.current = "";
    setPlaying(false); setWaiting(true); setQuality(next);
    persistPreferences({ rate, quality: next });
  };
  const changeRate = (next: number) => {
    setRate(next); video.current?.rate(next); persistPreferences({ rate: next, quality });
  };
  const toggleFavorite = async () => {
    if (favoritePending) return;
    setFavoritePending(true);
    try { await onFavorite(item); }
    catch (cause) { setSaveError(failureMessage(cause, "收藏保存失败，请重试")); }
    finally { if (mounted.current) setFavoritePending(false); }
  };

  useRemoteScope({ id: `player:${key}`, priority: 60, onKey: remote => {
    if (remote === "back") {
      if (seek !== null) { setSeek(null); interact(); }
      else if (modal) setModal(null);
      else if (controls && !blocked && !error) setControls(false);
      else exit();
      return true;
    }
    if (modal) return false;
    if (remote === "playPause") { toggle(); return true; }
    if (remote === "play") { play(); return true; }
    if (remote === "pause") { pause(); return true; }
    if (remote === "next" || remote === "previous") { stepPart(remote === "next" ? 1 : -1); return true; }
    if (seek !== null) {
      if (remote === "left" || remote === "right") previewSeek(remote === "left" ? -10 : 10);
      else if (remote === "confirm") commitSeek();
      return true;
    }
    if (!controls) {
      if (remote === "left" || remote === "right") { previewSeek(remote === "left" ? -10 : 10); return true; }
      if (remote === "confirm" || remote === "up" || remote === "down") { showControls(); return true; }
    }
    if ((remote === "left" || remote === "right") && document.activeElement?.getAttribute("data-tv-focus") === "player:progress") {
      previewSeek(remote === "left" ? -10 : 10); return true;
    }
    interact();
    return false;
  } });

  const partLabel = loaded?.parts.find(candidate => candidate.id === part)?.label || (content.kind === "post" ? "视频分段" : `第 ${part} 集`);
  const displayTime = seek ?? time;
  const percent = duration > 0 ? Math.max(0, Math.min(100, displayTime / duration * 100)) : 0;
  const nextExists = loaded ? loaded.parts.findIndex(candidate => candidate.id === part) < loaded.parts.length - 1 : false;

  return <section className="tv-player" data-tv-modal={`player:${key}`} aria-label={`${item.title}播放器`}>
    {!blocked && loaded && mediaSrc && <VideoSurface key={session} ref={video} src={mediaSrc} active={foreground} autoPlay={wanted.current} rate={rate} measurementKey={session}
      diagnosticContext={{ view: "tv_player", content_kind: content.kind, content_id: content.id, part, playback_session: loaded.serial }} className="tv-player-surface"
      onDuration={value => restore(session, value)}
      onTime={value => {
        if (!currentSession(session)) return;
        if (restoredSession.current !== session) { restore(session, video.current?.el()?.duration || 0); return; }
        clock.current.seconds = finiteSeconds(value); clock.current.ready = true; setTime(value);
        if (Date.now() - lastSaved.current >= 5000) persist();
      }}
      onPlaying={() => { if (currentSession(session)) { setPlaying(true); setWaiting(false); setError(""); } }}
      onPause={() => { if (currentSession(session)) { setPlaying(false); setControls(true); persist(); } }}
      onWaiting={() => { if (currentSession(session)) { setWaiting(true); setControls(true); } }}
      onEnded={() => onEnded(session)}
      onError={message => { if (currentSession(session)) { setError(message); setWaiting(false); setPlaying(false); setControls(true); } }}
      onClick={showControls} />}
    {blocked ? <div className="tv-player-message" role="status"><h1>内容已屏蔽</h1><p>{blocked}</p><div data-tv-region="player-blocked"><button data-tv-focus="player:blocked-back" onClick={exit}>返回详情</button></div></div> : <>
      {waiting && !error && <div className="tv-player-loading" role="status">正在加载…</div>}
      {error && <div className="tv-player-message" role="alert"><h2>播放暂时中断</h2><p>{error}</p><div data-tv-region="player-error"><button data-tv-focus="player:retry" onClick={retryPlayback}>重试当前{content.kind === "post" ? "分段" : "剧集"}</button><button data-tv-focus="player:error-back" onClick={exit}>返回详情</button></div></div>}
      <div className="tv-player-controls" hidden={!controls}>
        <div className="tv-player-heading"><h1>{item.title}</h1><span>{partLabel}</span></div>
        {seek !== null && <p className="tv-player-seek-hint" role="status">跳转预览 {fmtTime(seek)} · 确认跳转 · 返回取消</p>}
        {saveError && <p role="alert">{saveError}</p>}
        {preferenceError && <p role="alert">{preferenceError}</p>}
        <div data-tv-region="player-progress" className="tv-player-progress-row">
          <button data-tv-focus="player:progress" data-seeking={seek !== null || undefined} className="tv-player-progress" disabled={!duration} aria-label={`播放进度 ${fmtTime(displayTime)}，总时长 ${fmtTime(duration)}。左右预览，确认跳转`} onClick={() => { if (seek !== null) commitSeek(); else { setSeek(time); interact(); } }}>
            <span className="tv-player-progress-track"><span style={{ width: `${percent}%` }} /></span><span className="tv-player-progress-time">{fmtTime(displayTime)} / {fmtTime(duration)}</span>
          </button>
        </div>
        <div data-tv-region="player-controls" className="tv-player-control-row">
          <button data-tv-focus="player:play" data-tv-initial disabled={!loaded || !!error} onClick={toggle}>{playing ? "暂停" : "播放"}</button>
          <button data-tv-focus="player:parts" disabled={!loaded?.parts.length} onClick={() => { setModal("parts"); interact(); }}>{content.kind === "post" ? "分段" : "选集"}</button>
          <button data-tv-focus="player:options" onClick={() => { setModal("options"); interact(); }}>选项</button>
        </div>
      </div>
    </>}
    {modal === "parts" && !blocked && loaded && <TvModal id="player-parts" title={content.kind === "post" ? "视频分段" : "选择剧集"} onClose={() => setModal(null)}>
      <div data-tv-region="player-parts" data-tv-columns="4" className="tv-player-parts">{loaded.parts.map(candidate => <button key={candidate.id} data-tv-focus={`player:part:${candidate.id}`} aria-pressed={part === candidate.id} onClick={() => { if (part === candidate.id) setModal(null); else changePart(candidate.id); }}>{candidate.label}{part === candidate.id ? " · 当前" : ""}</button>)}</div>
    </TvModal>}
    {modal === "options" && !blocked && <TvModal id="player-options" title="播放选项" onClose={() => setModal(null)}>
      {preferenceError && <div role="alert"><p>{preferenceError}</p><div data-tv-region="player-preference-retry"><button data-tv-focus="player:preference-retry" onClick={() => persistPreferences({ rate, quality })}>重新保存设置</button></div></div>}
      <h3>倍速</h3><div data-tv-region="player-rates" className="tv-player-options-row">{[.75, 1, 1.25, 1.5, 2].map(value => <button key={value} data-tv-focus={`player:rate:${value}`} aria-pressed={rate === value} onClick={() => changeRate(value)}>{value}×</button>)}</div>
      <h3>清晰度</h3><div data-tv-region="player-quality" className="tv-player-options-row"><button data-tv-focus="player:quality:main" aria-pressed={quality === "main"} onClick={() => changeQuality("main")}>默认线路</button><button data-tv-focus="player:quality:hevc" disabled={!loaded?.streams.hevc} aria-pressed={quality === "hevc"} onClick={() => changeQuality("hevc")}>HEVC 高清</button></div>
      <div data-tv-region="player-options-actions" className="tv-player-options-row"><button data-tv-focus="player:favorite" aria-pressed={favorite} disabled={!loaded || favoritePending} onClick={() => void toggleFavorite()}>{favorite ? "取消收藏" : "收藏作品"}</button><button data-tv-focus="player:detail" onClick={exit}>返回详情</button></div>
      <p>音量由系统遥控器控制。</p>
    </TvModal>}
    {modal === "ended" && !blocked && <TvModal id="player-ended" title={nextExists ? "本集播放结束" : "已播放完毕"} onClose={() => setModal(null)}>
      <p>{nextExists ? "继续观看下一集，或重播当前内容。" : "当前作品已播放到最后。"}</p><div data-tv-region="player-ended" className="tv-player-options-row">{nextExists && <button data-tv-focus="player:ended-next" onClick={() => stepPart(1)}>下一{content.kind === "post" ? "段" : "集"}</button>}<button data-tv-focus="player:replay" onClick={replay}>重播</button><button data-tv-focus="player:ended-back" onClick={exit}>返回详情</button></div>
    </TvModal>}
  </section>;
}
