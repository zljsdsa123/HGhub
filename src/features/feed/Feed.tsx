import { Button, Image } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, cover, isMobile, logLine } from "../../shared/api/api";
import type { Detail, Episode, PlayInfo, Post, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { Img } from "../../shared/ui/ui";
import { registerOverlayBack } from "../../shared/lib/back";
import { PlaybackLock, VideoSurface, createPlaybackClock, type VideoHandle } from "../playback";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { TagBlockMenu } from "../../shared/ui/TagBlockMenu";
import { InplaceSearch } from "../search/InplaceSearch";
import { PreferenceStorageNotice } from "../../shared/ui/PreferenceStorageNotice";
import MobileHoldGuide from "./MobileHoldGuide";
import { useFsIdle } from "./fsIdle";
import { useMobileHoldGuide } from "./useMobileHoldGuide";
import { useFeedDetails } from "./useFeedDetails";
import { useFeedViewport, type FeedPanel, type PinchState } from "./useFeedViewport";
import { useFeedTouchGestures } from "./useFeedTouchGestures";
import { useFeedActions, type FeedMeta } from "./useFeedActions";
import FeedItemChrome from "./FeedItemChrome";
import { FeedMobileTopTools, FeedPlayerShellChrome } from "./FeedPlayerShellChrome";

type Props = {
  videoIds: number[];
  startIndex?: number;
  title?: string;
  mode: "home" | "context";
  kind?: "video" | "post";
  active: boolean;
  bottomInset: number;
  onBack?: () => void;
  onNearEnd?: () => void;
  onBlocked?: (id: number) => void;
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

export default function Feed({
  videoIds, startIndex = 0, title = "", mode, kind = "video", active, bottomInset,
  onBack, onNearEnd, onBlocked, startEp, startTime,
}: Props) {
  const store = useStore();
  const {
    isLiked, isFav, setLiked, setCollected, setFollowing, actionPending, accountScope,
    muted, setMuted, volume, setVolume, toast, addHistory, user, setLoginOpen,
    swipeEp, setSwipeEp, preferHevc, setPreferHevc,
  } = store;
  const isDesktop = !isMobile;
  const holdGuide = useMobileHoldGuide();
  const contentPreferences = useContentPreferences();
  const { preferences, revision, blockReason } = contentPreferences;
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [tagMenu, setTagMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const [tagSelection, setTagSelection] = useState<string[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [tagErrors, setTagErrors] = useState<Record<string, string>>({});
  const [originEpoch, setOriginEpoch] = useState(0);
  const playRequests = useRef(new Map<string, Promise<PlayInfo>>());
  const requestPlay = useCallback((id: number, episode: number) => {
    const key = `${accountScope}:${store.lineEpoch}:${id}:${episode}`;
    let request = playRequests.current.get(key);
    if (!request) {
      request = api.play(id, episode).finally(() => {
        if (playRequests.current.get(key) === request) playRequests.current.delete(key);
      });
      playRequests.current.set(key, request);
      if (playRequests.current.size > 12) playRequests.current.delete(playRequests.current.keys().next().value!);
    }
    return request;
  }, [accountScope, store.lineEpoch]);

  const { details, setDetails, detailsRef, posts, setPosts, requestDetail, effectiveVideoIds } = useFeedDetails({
    videoIds, mode, kind, accountScope, lineEpoch: store.lineEpoch, originEpoch, filtering, revision,
    blockReason, checked, tagErrors,
  });

  const playerRootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoHandle>(null);
  const holdTargetRef = useRef<HTMLDivElement>(null);
  const pinchRef = useRef<PinchState | null>(null);

  const [epMap, setEpMap] = useState<Record<number, number>>(() => (startEp ? { [videoIds[startIndex]]: startEp } : {}));
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const [hevcUrls, setHevcUrls] = useState<Record<string, string>>({});
  const [playingKey, setPlayingKey] = useState("");
  const [proxyRetry, setProxyRetry] = useState(0);
  const [relatedByVideo, setRelatedByVideo] = useState<Record<string, VideoCard[]>>({});

  const playbackClock = useMemo(() => createPlaybackClock(), []);
  const [duration, setDuration] = useState(0);
  const [vsize, setVsize] = useState({ key: "", w: 0, h: 0 });
  const [paused, setPaused] = useState(mode === "home");
  const [controlsLocked, setControlsLocked] = useState(false);
  const [rate, setRate] = useState(1);
  const [waiting, setWaiting] = useState(false);
  const [err, setErr] = useState("");
  const [panel, setPanel] = useState<FeedPanel>(null);

  /* 续播：拿到时长后再 seek 一次（只对进入时那一条生效） */
  const resumeRef = useRef<{ key: string; t: number } | null>(
    startTime && startTime > 1 ? { key: `${videoIds[startIndex]}:${startEp || 1}`, t: startTime } : null,
  );
  /* 观看进度：onTime 里节流写回 store，卸载时再兜一次 */
  const liveRef = useRef({ id: 0, ep: 1, dur: 0, t: 0, permissionKey: "", accountScope: "" });
  const historyWriter = useRef(addHistory);
  const lastSaveRef = useRef(0);
  const theater = store.theater;
  const setTheater = store.setTheater;
  const fs = active && store.fs;
  const clean = store.clean;
  const setClean = store.setClean;
  const setFs = store.setFs;

  const [barScrubbing, setBarScrubbing] = useState(false);
  /* 控件闲置隐藏：桌面 2.8s；移动全屏按设置秒数（#146-3） */
  const { idle, setIdle, wake, arm } = useFsIdle(isDesktop, fs, paused, store.fsIdleSecs, boxRef, barScrubbing);

  const episodesByVideo = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const [key, item] of Object.entries(details)) counts[Number(key)] = item?.episodes?.length || 0;
    return counts;
  }, [details]);

  const isItemAllowed = useCallback((id: number | undefined) => {
    if (!filtering) return true;
    const key = `${accountScope}:${store.lineEpoch}:${kind}:${id}`;
    if (!checked[key]) return false;
    const tags = id !== undefined ? (kind === "post" ? posts[id]?.tags : details[id]?.tags) : undefined;
    return !blockReason(tags);
  }, [filtering, accountScope, store.lineEpoch, kind, checked, posts, details, blockReason]);

  const {
    idsRef, index, renderIndex, fullscreen, vpLandscape, portraitFit, setPortraitFit,
    onScroll, go, stepDir, canStep, toggleFull, enterFs, exitFs,
  } = useFeedViewport({
    playerRootRef, boxRef, videoRef, pinchRef, videoIds, effectiveVideoIds, startIndex, mode, kind, active,
    isItemAllowed, isDesktop, fs, setFs, setClean, paused, wake, swipeEp, epMap, setEpMap,
    episodesByVideo, setPanel, onNearEnd,
  });

  const curId = effectiveVideoIds[index];
  const nextVideoId = effectiveVideoIds[index + 1];
  const relatedKey = `${store.lineEpoch}:${curId}`;
  const related = relatedByVideo[relatedKey] || [];
  const detail = details[curId];
  const tagKey = `${accountScope}:${store.lineEpoch}:${kind}:${curId}`;
  const permissionKey = `${tagKey}:${revision}`;
  const currentTags = kind === "post" ? posts[curId]?.tags : detail?.tags;
  const tagsReady = !!checked[tagKey];
  const blocked = filtering && tagsReady ? blockReason(currentTags) : null;
  const allowed = !filtering || (tagsReady && !blocked);
  const closePanels = () => { setPanel(null); setTagMenu(false); };
  const openPreferences = () => { closePanels(); store.push({ kind: "settings", section: "内容偏好" }); };
  const openTagMenu = (selected: string[] = []) => { setTagSelection(selected); setPanel(null); setTagMenu(true); };
  const openTag = (tag: string) => { closePanels(); store.push({ kind: "tag", tag, name: tag }); };
  const lockControls = () => { setPanel(null); setControlsLocked(true); };
  const toggleSwipeEp = () => {
    const next = !swipeEp;
    setSwipeEp(next);
    toast(next ? "上下划切集已开启" : "上下划切集已关闭", "info");
  };

  useEffect(() => { setTagMenu(false); setTagSelection([]); }, [curId, store.lineEpoch, accountScope]);
  useEffect(() => { if (!active) setSearching(false); }, [active]);
  useEffect(() => {
    store.setLocked(active && controlsLocked);
    return () => { if (active) store.setLocked(false); };
  }, [active, controlsLocked, store.setLocked]);
  useEffect(() => { if (blocked && mode === "home" && active) onBlocked?.(curId); }, [blocked, mode, active, curId, onBlocked]);
  useEffect(() => { if (!allowed) { setPanel(null); setTagMenu(false); } }, [allowed]);

  const curEp = epMap[curId] || 1;
  const actionContext = useRef({ accountScope, lineEpoch: store.lineEpoch, id: curId, ep: curEp, kind });
  actionContext.current = { accountScope, lineEpoch: store.lineEpoch, id: curId, ep: curEp, kind };
  const progressScope = useRef(accountScope);
  useLayoutEffect(() => {
    if (progressScope.current === accountScope) return;
    progressScope.current = accountScope;
    resumeRef.current = null;
    lastSaveRef.current = 0;
    liveRef.current = { id: 0, ep: 1, dur: 0, t: 0, permissionKey: "", accountScope };
  }, [accountScope]);

  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const playKey = `${accountScope}:${curId}:${curEp}`;
  const playGuard = useRef({ allowed, id: curId, permissionKey, playKey });
  playGuard.current = { allowed, id: curId, permissionKey, playKey };
  const isCurrentPlayback = () => playGuard.current.allowed && playGuard.current.id === curId
    && playGuard.current.permissionKey === permissionKey && playGuard.current.playKey === playKey;

  const mainUrl = playUrls[playKey] || "";
  const hevcUrl = hevcUrls[playKey] || "";
  const playUrl = preferHevc && hevcUrl ? hevcUrl : mainUrl;
  const measurementKey = JSON.stringify([accountScope, store.lineEpoch, permissionKey, playKey, playUrl]);
  const videoSize = vsize.key === measurementKey ? vsize : { key: measurementKey, w: 0, h: 0 };
  // 等播放画面就绪再提示，启动动画/协议、加载失败和其他面板不叠加教程。
  const showHoldGuide = !isDesktop && !holdGuide.seen && active && allowed
    && !!playUrl && duration > 0 && !err && !panel && !tagMenu && !controlsLocked;

  useEffect(() => {
    const onProxyChanged = () => {
      setErr("");
      // Resolved media is retried in VideoSurface. Only an unresolved API call
      // needs another lookup, so a working stream keeps its episode and position.
      if (!playUrl) {
        if (active) setWaiting(true);
        setProxyRetry(value => value + 1);
      } else if (active) {
        setWaiting(true);
      }
    };
    const onLineChanged = () => {
      setOriginEpoch(value => value + 1);
      // Keep an actively playing, healthy stream uninterrupted while purging all
      // prefetched/inactive/errored URLs from the previous line.
      if (active && playingKey === playKey && !err && playUrl) {
        setPlayUrls(prev => (prev[playKey] ? { [playKey]: prev[playKey] } : {}));
        setHevcUrls(prev => (prev[playKey] ? { [playKey]: prev[playKey] } : {}));
        return;
      }
      setPlayUrls({});
      setHevcUrls({});
      setPlayingKey("");
      setErr("");
      if (active) setWaiting(true);
      setProxyRetry(value => value + 1);
    };
    window.addEventListener("hg:proxy-changed", onProxyChanged);
    window.addEventListener("hg:line-changed", onLineChanged);
    return () => {
      window.removeEventListener("hg:proxy-changed", onProxyChanged);
      window.removeEventListener("hg:line-changed", onLineChanged);
    };
  }, [active, playUrl, playingKey, playKey, err]);

  useEffect(() => { videoRef.current?.trace("page.active", { active, view: mode, video_id: curId, episode: curEp }); }, [active, mode, curId, curEp]);
  const episodes = detail?.episodes || [];
  const post = posts[curId];

  /* 观看进度：onTime 里每 5 秒落一次；退出播放页时再用 liveRef 兜一次 */
  const onTimeTick = (t: number) => {
    if (!isCurrentPlayback()) return;
    // Keep the writer from this observation; a later clear must invalidate old cleanup data.
    if (active) historyWriter.current = addHistory;
    liveRef.current = { id: curId, ep: curEp, dur: duration, t, permissionKey, accountScope };
    playbackClock.publish(t);
    const now = Date.now();
    if (duration > 0 && now - lastSaveRef.current > 5000) {
      lastSaveRef.current = now;
      if (kind === "video" && active) addHistory(curId, curEp, t, duration);
    }
  };

  /* 拿到时长后再续播：只对进入时那一条生效，且不跳到片尾 */
  const onDurationTick = (d: number) => {
    if (!isCurrentPlayback()) return;
    setDuration(d);
    liveRef.current = {
      id: curId, ep: curEp, dur: d,
      t: historyWriter.current === addHistory && liveRef.current.id === curId && liveRef.current.ep === curEp && liveRef.current.accountScope === accountScope ? liveRef.current.t : 0,
      permissionKey, accountScope,
    };
    const r = resumeRef.current;
    if (r && r.key === `${curId}:${curEp}` && r.t > 1 && (!d || r.t < d - 3)) {
      resumeRef.current = null;
      videoRef.current?.seek(r.t, "history_resume");
      playbackClock.publish(r.t);
    }
  };

  /** 统一视图模型：短剧与吃瓜帖子共用同一套播放界面 */
  const meta: FeedMeta = kind === "post"
    ? {
        title: post?.title || "",
        cover: post?.cover || "",
        desc: post?.content || post?.desc || "",
        author: post?.author?.name || "吃瓜",
        authorId: post?.author?.id || -1,
        tags: post?.tags || [],
        score: 0,
        like: post?.counts?.like ?? 0,
        comment: post?.counts?.comment ?? 0,
        collect: post?.counts?.collect ?? 0,
        episodes: [] as Episode[],
      }
    : {
        title: detail?.title || "",
        cover: detail?.cover?.trim() || "",
        desc: detail?.description || "",
        author: detail?.author?.name || "HGhubX",
        authorId: detail?.author?.id || -1,
        tags: detail?.tags || [],
        score: detail?.score || 0,
        like: detail?.counts?.like ?? 0,
        comment: detail?.counts?.comment ?? 0,
        collect: detail?.counts?.collect ?? 0,
        episodes: detail?.episodes || [],
      };

  const posterUrl = cover(meta.cover, 900);
  const articleHtml = kind === "post" && !post?.video_url ? (post?.content || "") : "";

  /* 沉浸全屏 + 横屏视频 → 舞台旋转 90°，看起来就是横屏 */
  const rotated = !isDesktop && fs && videoSize.w > videoSize.h && videoSize.h > 0 && !vpLandscape;
  const landscapeVideo = videoSize.w > 0 && videoSize.h > 0 && videoSize.w > videoSize.h;

  const {
    zoom, setZoom, holdSpeed, holdSlow, speedLock, setSpeedLock, lockArmed, speedLockTargetRef,
    scrub, barRef, barPct, onDown, onMove, onUp, onBarDown, onBarMove, onBarUp,
  } = useFeedTouchGestures({
    boxRef, videoRef, pinchRef, playbackClock, isDesktop, active, controlsLocked, showHoldGuide,
    rotated, fs, clean, setClean, idle, setIdle, arm, wake, swipeEp, kind, curId, epMap, setEpMap,
    episodesLength: episodes.length, effectiveLength: effectiveVideoIds.length, go,
    duration, playUrl, playKey, setPanel, setTagMenu, toast,
  });
  useEffect(() => { setBarScrubbing(barPct !== null || scrub !== null); }, [barPct, scrub]);

  const {
    liked, collected, likePending, collectPending, followPending, heartBurst,
    likeCount, collectCount, onLike, onFav, onFollow, togglePip,
  } = useFeedActions({
    videoRef, mounted, actionContext, accountScope, lineEpoch: store.lineEpoch,
    curId, curEp, kind, meta, detail, posts, user, setLoginOpen, follows: store.follows,
    isLiked, isFav, setLiked, setCollected, setFollowing, actionPending, toast,
  });

  /* 倍速：中心小方块打开偏好，右上长按 2x 起、左右滑换挡，左下 0.5x。 */
  const effRate = holdSpeed || speedLock || (holdSlow ? 0.5 : rate);
  /* 竖屏快捷胶囊的显隐：不卸载、只改 opacity，这样淡入淡出都能过渡（#19） */
  const capsuleOn = !fs && !clean && !isDesktop && (landscapeVideo || zoom.s > 1.05);

  /* 若用户在视频首帧宽高解析出来前已点进全屏，解析出横屏后自动补发横屏方向请求 */
  useEffect(() => {
    if (!active || isDesktop || !fs || !landscapeVideo) return;
    try { void invoke("set_orientation", { landscape: true }); } catch { /* ignore */ }
    try {
      (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape")?.catch(() => {});
    } catch { /* ignore */ }
  }, [active, isDesktop, fs, landscapeVideo]);

  /* With filtering enabled, details are the gate: no media is requested before tags settle. */
  useEffect(() => {
    if (!active) return;
    const epoch = store.lineEpoch;
    const candidates = filtering
      ? [effectiveVideoIds[index], effectiveVideoIds[index + 1], effectiveVideoIds[index - 1]]
      : [effectiveVideoIds[index]];
    const need = candidates.filter((id): id is number => id !== undefined);
    need.forEach(id => {
      const key = `${accountScope}:${epoch}:${kind}:${id}`;
      if (checked[key] || tagErrors[key]) return;
      const request = kind === "post" ? api.post(id) : requestDetail(id);
      request.then(value => {
        if (!mounted.current || actionContext.current.accountScope !== accountScope || actionContext.current.lineEpoch !== epoch) return;
        if (!value) {
          setTagErrors(previous => ({ ...previous, [key]: "标签暂不可用，请重试" }));
          return;
        }
        if (kind === "post") setPosts(previous => ({ ...previous, [id]: value as Post }));
        else setDetails(previous => ({ ...previous, [id]: value as Detail }));
        setTagErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
        setChecked(previous => ({ ...previous, [key]: true }));
      }).catch(error => {
        if (mounted.current && actionContext.current.accountScope === accountScope && actionContext.current.lineEpoch === epoch) {
          setTagErrors(previous => ({ ...previous, [key]: error instanceof Error ? error.message : "标签暂不可用，请重试" }));
        }
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, kind, index, effectiveVideoIds, proxyRetry, store.lineEpoch, accountScope, checked, tagErrors, requestDetail, filtering]);

  /* 相关推荐只在用户打开详情时拉取，避免和首播抢占网络。 */
  useEffect(() => {
    if (!active || !curId || kind !== "video" || !allowed || panel !== "detail" || relatedByVideo[relatedKey]) return;
    const id = curId;
    api.related(id).then((r) => {
      if (mounted.current) setRelatedByVideo(previous => ({ ...previous, [relatedKey]: r?.items || [] }));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, curId, kind, allowed, panel, relatedKey, relatedByVideo]);

  /* 拉播放地址 */
  useEffect(() => {
    if (!active || !curId || !allowed) return;
    if (playUrls[playKey]) return;
    let alive = true;
    requestPlay(curId, curEp)
      .then((info) => {
        if (!alive || !isCurrentPlayback()) return;
        const hevcStream = info?.streams?.hevc || info?.video_url_hevc || "";
        const streamUrl = info?.streams?.main || info?.video_url || hevcStream;
        const raw = info as unknown as Record<string, unknown>;
        const streams = (raw.streams ?? {}) as Record<string, unknown>;
        const streamKind = streams.main ? "main" : info?.video_url ? "video_url" : hevcStream ? "hevc" : "-";
        let host = "?";
        try { host = new URL(streamUrl || "").host || "?"; } catch { /* 空地址或非 URL */ }
        logLine(
          `[play] id=${curId} ep=${curEp} src=${streamUrl ? "y" : "n"} kind=${streamKind} host=${host}` +
          (streamUrl ? "" : ` status=${String(raw.status ?? "?")} msg=${String(raw.msg ?? "")}`),
        );
        tracePlayback("play.resolve", {
          video_id: curId, episode: curEp, resolved: !!streamUrl, kind: streamKind, host,
          status: raw.status ?? null, msg: String(raw.msg ?? "") || null,
        });
        if (!streamUrl) throw new Error("暂无播放地址");
        setPlayUrls((m) => ({ ...m, [playKey]: streamUrl }));
        if (hevcStream) setHevcUrls((m) => ({ ...m, [playKey]: hevcStream }));
        if (kind === "video") addHistory(curId, curEp);
      })
      .catch((e) => { if (alive) setErr((e as Error).message || "取播放地址失败"); });
      return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, curId, curEp, proxyRetry, allowed, permissionKey, requestPlay]);

  /* 当前集拿到地址后再预取下一集，避免首帧加载期间争抢网络。 */
  useEffect(() => {
    if (!active || !curId || kind !== "video" || !allowed || playingKey !== playKey || episodes.length === 0) return;
    let alive = true;
    const ep = epMap[curId] || 1;
    const nextEpisode = ep + 1;
    if (nextEpisode > episodes.length) return;
    const key = `${accountScope}:${curId}:${nextEpisode}`;
    if (playUrls[key]) return;
    requestPlay(curId, nextEpisode)
      .then((info) => {
        if (!alive || !playGuard.current.allowed || playGuard.current.permissionKey !== permissionKey) return;
        const h = info?.streams?.hevc || info?.video_url_hevc || "";
        const u = info?.streams?.main || info?.video_url || h;
        if (u) setPlayUrls((m) => ({ ...m, [key]: u }));
        if (h) setHevcUrls((m) => ({ ...m, [key]: h }));
      })
      .catch(() => { /* 预热失败不影响当前播放 */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, curId, curEp, episodes.length, allowed, permissionKey, playingKey, playKey, requestPlay]);

  /* 当前视频首帧请求完成后，再验证并预取下一部，屏蔽规则始终先于播放地址。 */
  useEffect(() => {
    const nextId = nextVideoId;
    if (!active || !curId || !nextId || kind !== "video" || !allowed || playingKey !== playKey) return;
    let alive = true;
    const currentId = curId;
    const currentPermission = permissionKey;
    const nextKey = `${accountScope}:${nextId}:1`;
    if (playUrls[nextKey]) return;
    const stillRelevant = () => alive && mounted.current && playGuard.current.id === currentId
      && playGuard.current.permissionKey === currentPermission && idsRef.current[index + 1] === nextId;
    void (async () => {
      try {
        const nextDetail = detailsRef.current[nextId] || await requestDetail(nextId);
        if (!stillRelevant()) return;
        if (!detailsRef.current[nextId]) {
          setDetails(previous => ({ ...previous, [nextId]: nextDetail }));
          setChecked(previous => ({ ...previous, [`${accountScope}:${store.lineEpoch}:${kind}:${nextId}`]: true }));
        }
        if (filtering && blockReason(nextDetail.tags)) {
          if (mode === "home") onBlocked?.(nextId);
          return;
        }
        const info = await requestPlay(nextId, 1);
        if (!stillRelevant()) return;
        const hevc = info?.streams?.hevc || info?.video_url_hevc || "";
        const url = info?.streams?.main || info?.video_url || hevc;
        if (url) setPlayUrls(previous => ({ ...previous, [nextKey]: url }));
        if (hevc) setHevcUrls(previous => ({ ...previous, [nextKey]: hevc }));
      } catch {
        // The next item resolves normally when selected.
      }
    })();
    return () => { alive = false; };
  }, [active, curId, index, nextVideoId, kind, mode, allowed, playingKey, playKey, playUrls[`${accountScope}:${nextVideoId}:1`], permissionKey, accountScope, store.lineEpoch, filtering, blockReason, onBlocked, requestDetail, requestPlay, idsRef, detailsRef, setDetails]);

  /* 切换条目/集数时重置播放状态 */
  useEffect(() => {
    setDuration(0); setErr(""); setWaiting(true); setPaused(mode === "home");
    setPlayingKey("");
    playbackClock.publish(0);
    setPortraitFit("contain");
  }, [playKey, playbackClock, setPortraitFit]);

  /* 音量/静音同步 */
  useEffect(() => { videoRef.current?.mute(muted); }, [muted]);
  useEffect(() => { videoRef.current?.volume(volume); }, [volume]);
  /* 倍速同步（长按 2x / 锁定 2x / 基准倍速） */
  useEffect(() => { videoRef.current?.rate(effRate); }, [effRate, playKey]);

  /* 离开播放页时把最后位置落盘 */
  useEffect(() => () => {
    const s = liveRef.current;
    if (kind === "video" && s.id && s.dur && playGuard.current.allowed && playGuard.current.id === s.id
      && actionContext.current.accountScope === s.accountScope
      && playGuard.current.permissionKey === s.permissionKey) historyWriter.current(s.id, s.ep, s.t, s.dur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 键盘 */
  useEffect(() => {
    if (!active || !allowed || controlsLocked || showHoldGuide || tagMenu || searching) return;
    const seekRelative = (delta: number) => {
      const current = videoRef.current?.el()?.currentTime ?? 0;
      videoRef.current?.seek(Math.max(0, current + delta), "keyboard_shortcut");
    };
    const fn = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (panel) { if (e.key === "Escape" && !e.repeat) setPanel(null); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); seekRelative(-5); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); seekRelative(5); return; }
      if (e.repeat) return;
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); stepDir(1); break;
        case "ArrowUp": e.preventDefault(); stepDir(-1); break;
        case " ":
          if (t?.closest?.('button, summary, [role="button"], a[href], select')) return;
          e.preventDefault();
          videoRef.current?.toggle();
          break;
        case "f": case "F": toggleFull(); break;
        case "t": case "T": setTheater((v) => !v); break;
        case "m": case "M": setMuted((v) => !v); break;
        case "l": case "L": void onLike(); break;
        case "s": case "S": void onFav(); break;
        case "c": case "C": setPanel("comments"); break;
        case "e": case "E": if (kind === "video") setPanel("episodes"); break;
        default: break;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, allowed, controlsLocked, showHoldGuide, tagMenu, searching, panel, index, stepDir, accountScope, curEp, kind, liked, collected, likePending, collectPending]);

  /* 安卓返回键：面板打开时先关面板（按活跃实例栈式注册，不覆盖其他页面拦截器） */
  useEffect(() => {
    if (!active || !panel) return undefined;
    return registerOverlayBack(() => { setPanel(null); return true; });
  }, [active, panel]);

  const pickEp = (ep: number) => {
    setEpMap((m) => ({ ...m, [curId]: ep }));
    setPanel(null);
  };

  if (curId && mode === "home" && blocked) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center" inert={!active || undefined} aria-hidden={!active || undefined}>
      <Loader className="w-9 h-9 spinner" label="正在跳过内容" />
    </div>;
  }

  if (curId && filtering && !tagsReady && !tagErrors[tagKey]) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center" inert={!active || undefined} aria-hidden={!active || undefined}>
      <Loader className="w-9 h-9 spinner" label="正在加载内容" />
    </div>;
  }

  if (curId && filtering && !tagsReady && tagErrors[tagKey]) {
    return <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-3" inert={!active || undefined} aria-hidden={!active || undefined}>
      <span className="text-[13px] text-white/70">暂时无法加载内容</span>
      <Button onClick={() => {
        setTagErrors(previous => { const next = { ...previous }; delete next[tagKey]; return next; });
        setProxyRetry(value => value + 1);
      }} className="min-h-11 rounded-full bg-white/10 px-4 text-white">重试</Button>
    </div>;
  }

  if (!effectiveVideoIds.length) {
    return <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-3" inert={!active || undefined} aria-hidden={!active || undefined}>
      <span className="text-[14px] text-white/70">当前列表没有可播放内容</span>
      <PreferenceStorageNotice className="mx-4 max-w-sm" />
      {onBack && <Button onClick={onBack} className="min-h-11 rounded-full bg-white/10 px-5 text-white">返回</Button>}
    </div>;
  }

  return (
    <div
      ref={playerRootRef}
      className={`hg-player-ui ${rotated ? "fs-landscape" : (!isDesktop && fs ? "fs-immersive" : "absolute inset-0")} overflow-hidden bg-black player-root ${controlsLocked ? "is-locked" : ""} ${isDesktop ? "player-surface" : ""} ${theater ? "is-theater" : ""} ${isDesktop && idle ? "is-idle" : ""}`}
      data-clean={clean}
      inert={!active || undefined}
      aria-hidden={!active || undefined}
      onFocusCapture={() => { if (active && isDesktop) wake(); }}
      onPointerMove={() => { if (isDesktop) wake(); }}>
      <div className="absolute inset-0" inert={controlsLocked}>
        {/* 氛围背景 */}
        {!isDesktop && posterUrl && (
          <div className="absolute inset-0 scale-110 blur-3xl opacity-25 pointer-events-none">
            <Image src={posterUrl} alt="" className="w-full h-full object-cover" />
          </div>
        )}

        <div ref={boxRef} onScroll={onScroll}
          className={`absolute inset-y-0 left-0 no-bar ${fs ? "overflow-hidden" : "overflow-y-scroll snap-y snap-mandatory overscroll-y-contain"}`}
          style={{ right: isDesktop && panel ? 372 : 0, transition: "right .3s cubic-bezier(.2,0,0,1)" }}>
          {effectiveVideoIds.map((vid, i) => {
            const isActive = i === index;
            const sectionClass = `${fs && !isActive ? "hidden" : "relative w-full h-full"} snap-start snap-always overflow-hidden`;
            // Preserve snap geometry while keeping only the active item and its
            // neighbours mounted; distant cards otherwise create many idle controls.
            if (Math.abs(i - index) > 1 && Math.abs(i - renderIndex) > 1) {
              return <section key={vid} className={sectionClass} aria-hidden="true" />;
            }
            if (filtering && !isActive && (!checked[`${accountScope}:${store.lineEpoch}:${kind}:${vid}`] || tagErrors[`${accountScope}:${store.lineEpoch}:${kind}:${vid}`] || blockReason(kind === "post" ? posts[vid]?.tags : details[vid]?.tags))) {
              return <section key={vid} className={sectionClass} aria-hidden="true" />;
            }
            return (
              <section key={vid} className={sectionClass} inert={!isActive || undefined} aria-hidden={!isActive || undefined}>
                {isActive ? (
                  <div ref={holdTargetRef} data-mobile-hold-target={!isDesktop || undefined}
                    className="absolute inset-0" style={{ touchAction: fs || swipeEp ? "none" : "pan-y" }}
                    onPointerDown={onDown} onPointerMove={onMove} onPointerUp={(e) => onUp(false, e)} onPointerCancel={(e) => onUp(true, e)} onLostPointerCapture={(e) => onUp(true, e)}>
                    {playUrl ? (
                      <>
                        {/* 老 WebView 不认识 inset 简写；四边写法保证缩放舞台铺满（#138）。 */}
                    <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, transform: isDesktop ? undefined : `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.s})`, transformOrigin: "center center", transition: isDesktop || zoom.g ? "none" : "transform .18s ease-out" }}>
                      <VideoSurface ref={videoRef} src={playUrl} poster={posterUrl} autoPlay={mode !== "home"} active={active && !tagMenu && !showHoldGuide && !searching} muted={muted}
                        diagnosticContext={{ active: active && !tagMenu && !showHoldGuide && !searching, view: mode, kind, video_id: curId, episode: curEp }}
                        volume={volume} rate={effRate}
                        measurementKey={measurementKey}
                        fit={!isDesktop && landscapeVideo && !fs && !vpLandscape ? portraitFit : "contain"}
                        onClick={() => { if (isDesktop) videoRef.current?.toggle(); }}
                        onTime={onTimeTick}
                        onDuration={onDurationTick}
                        onSize={(w, h, key) => {
                          if (key !== measurementKey || !isCurrentPlayback()) return false;
                          setVsize((prev) => (prev.key === key && prev.w === w && prev.h === h ? prev : { key, w, h }));
                          return true;
                        }}
                        onPlaying={() => { if (isCurrentPlayback()) { setPaused(false); setWaiting(false); setErr(""); setPlayingKey(playKey); } }}
                        onPause={() => { if (isCurrentPlayback()) setPaused(true); }}
                        onWaiting={() => { if (isCurrentPlayback()) setWaiting(true); }}
                        onEnded={() => { if (!isCurrentPlayback()) return; const next = episodes.find((e) => e.ep_num === curEp + 1); if (next) pickEp(next.ep_num); }}
                        onError={(m) => {
                          if (!isCurrentPlayback()) return;
                          setErr(m); setWaiting(false);
                          if (preferHevc && hevcUrl) {
                            setPreferHevc(false);
                            toast("高清播不了，已切回标准", "info");
                          }
                        }} />
                      </div>
                      </>
                    ) : (
                      <div className="absolute inset-0">
                        {(!filtering || checked[`${accountScope}:${store.lineEpoch}:${kind}:${vid}`]) &&
                          <Img src={details[vid]?.cover || posts[vid]?.cover || ""} eager />}
                        <div className="absolute inset-0" style={{ background: "rgba(0,0,0,.25)" }} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="absolute inset-0">
                    {(!filtering || checked[`${accountScope}:${store.lineEpoch}:${kind}:${vid}`]) &&
                      <Img src={details[vid]?.cover || posts[vid]?.cover || ""} eager={Math.abs(i - index) <= 1} />}
                    <div className="absolute inset-0" style={{ background: "rgba(0,0,0,.25)" }} />
                  </div>
                )}

                <FeedItemChrome
                  isActive={isActive} isDesktop={isDesktop} fs={fs} clean={clean} mode={mode} kind={kind}
                  title={title} index={index} effectiveLength={effectiveVideoIds.length} bottomInset={bottomInset}
                  curEp={curEp} duration={duration} meta={meta} post={post} hevcUrl={hevcUrl}
                  preferHevc={preferHevc} setPreferHevc={setPreferHevc}
                  landscapeVideo={landscapeVideo} capsuleOn={capsuleOn} zoom={zoom} setZoom={setZoom}
                  portraitFit={portraitFit} setPortraitFit={setPortraitFit}
                  liked={liked} collected={collected} likePending={likePending} collectPending={collectPending}
                  heartBurst={heartBurst} likeCount={likeCount} collectCount={collectCount}
                  paused={paused} waiting={waiting} err={err} scrub={scrub} barRef={barRef} barPct={barPct}
                  onPlay={() => videoRef.current?.play()}
                  playbackClock={playbackClock} onBack={onBack} enterFs={enterFs} stepDir={stepDir} canStep={canStep}
                  onLike={onLike} onFav={onFav} setPanel={setPanel} openTag={openTag} openTagMenu={openTagMenu}
                  muted={muted} onToggleMuted={() => setMuted(value => !value)}
                  swipeEnabled={kind === "video" && episodes.length > 1} swipeEp={swipeEp} onToggleSwipe={toggleSwipeEp}
                  onLock={lockControls}
                  onBarDown={onBarDown} onBarMove={onBarMove} onBarUp={onBarUp}
                  onRetryStream={() => {
                    setErr(""); setWaiting(true);
                    if (playUrl && videoRef.current) videoRef.current.retry();
                    else setProxyRetry(value => value + 1);
                  }}
                  toast={toast}
                />
              </section>
            );
          })}
        </div>

        <FeedPlayerShellChrome
          videoRef={videoRef} speedLockTargetRef={speedLockTargetRef} barRef={barRef} playbackClock={playbackClock}
          isDesktop={isDesktop} active={active} fs={fs} idle={idle} rotated={rotated} vpLandscape={vpLandscape}
          theater={theater} setTheater={setTheater} fullscreen={fullscreen} controlsLocked={controlsLocked}
          paused={paused} duration={duration} rate={rate} setRate={setRate} effRate={effRate}
          holdSpeed={holdSpeed} holdSlow={holdSlow} speedLock={speedLock} setSpeedLock={setSpeedLock} lockArmed={lockArmed}
          muted={muted} setMuted={setMuted} volume={volume} setVolume={setVolume} swipeEp={swipeEp} setSwipeEp={setSwipeEp}
          preferHevc={preferHevc} setPreferHevc={setPreferHevc} portraitFit={portraitFit} setPortraitFit={setPortraitFit}
          playKey={playKey} curId={curId} curEp={curEp} index={index} effectiveLength={effectiveVideoIds.length}
          kind={kind} meta={meta} likeCount={likeCount} collectCount={collectCount}
          episodes={episodes} related={related} follows={store.follows} followPending={followPending}
          post={post} articleHtml={articleHtml} panel={panel} setPanel={setPanel}
          scrub={scrub} barPct={barPct} onBarDown={onBarDown} onBarMove={onBarMove} onBarUp={onBarUp}
          pickEp={pickEp} go={go} togglePip={togglePip} lockControls={lockControls} toggleFull={toggleFull} exitFs={exitFs}
          onFollow={onFollow} openTag={openTag} openTagMenu={openTagMenu} closePanels={closePanels} pushPage={store.push} toast={toast}
        />
      </div>

      <FeedMobileTopTools
        isDesktop={isDesktop} controlsLocked={controlsLocked} active={active && !searching} fs={fs} idle={idle}
        rotated={rotated} clean={clean} currentQuality={playUrl ? (preferHevc && hevcUrl && playUrl === hevcUrl ? "HD" : "SD") : null}
        searchLabel={kind === "post" ? "搜吃瓜帖" : "搜短剧"}
        onSearch={mode === "context" ? () => { closePanels(); setSearching(true); } : undefined}
      />
      {searching && mode === "context" && active && (
        <InplaceSearch kind={kind} wide={isDesktop} onClose={() => setSearching(false)}
          onOpenVideo={(v, list, kw) => store.push({ kind: "feed", videoIds: list.map(x => x.id), index: list.findIndex(x => x.id === v.id), title: kw ? `搜索 · ${kw}` : "搜索" })}
          onOpenPost={(p) => store.push({ kind: "post", id: p.id })} />
      )}
      <TagBlockMenu open={active && tagMenu} tags={meta.tags} initialSelected={tagSelection} onClose={() => setTagMenu(false)} onSettings={openPreferences} />
      {!isDesktop && <MobileHoldGuide open={showHoldGuide} onClose={holdGuide.dismiss} target={holdTargetRef} bottomInset={bottomInset} />}
      {controlsLocked && <PlaybackLock active={active} rotated={rotated} immersive={!isDesktop && fs && !rotated} onUnlock={() => { setControlsLocked(false); wake(); }} />}
    </div>
  );
}
