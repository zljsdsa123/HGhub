import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from "react";
import type { PlaybackClock, VideoHandle } from "../playback";
import type { Toast } from "../../shared/model/store";
import { createHoldSpeed, getHoldPoint, getHoldZone, isInsideHoldTarget, shiftHoldSpeed, HOLD_DELAY_MS, type HoldRect, type HoldRotation, type HoldSpeed, type HoldZone } from "./mobileHold";
import { resolveFullscreenEpisodeSwipe } from "./fullscreenEpisodeSwipe";
import type { FeedPanel, PinchState } from "./useFeedViewport";

type Args = {
  boxRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<VideoHandle | null>;
  pinchRef: MutableRefObject<PinchState | null>;
  playbackClock: PlaybackClock;
  isDesktop: boolean;
  active: boolean;
  controlsLocked: boolean;
  showHoldGuide: boolean;
  rotated: boolean;
  fs: boolean;
  clean: boolean;
  setClean: (v: boolean) => void;
  idle: boolean;
  setIdle: Dispatch<SetStateAction<boolean>>;
  arm: () => void;
  wake: () => void;
  swipeEp: boolean;
  kind: "video" | "post";
  curId: number;
  epMap: Record<number, number>;
  setEpMap: Dispatch<SetStateAction<Record<number, number>>>;
  episodesLength: number;
  effectiveLength: number;
  go: (dir: number) => void;
  duration: number;
  playUrl: string;
  playKey: string;
  setPanel: Dispatch<SetStateAction<FeedPanel>>;
  setTagMenu: Dispatch<SetStateAction<boolean>>;
  toast: (msg: string, icon?: Toast["icon"], tag?: string) => void;
};

export function useFeedTouchGestures({
  boxRef, videoRef, pinchRef, playbackClock, isDesktop, active, controlsLocked, showHoldGuide,
  rotated, fs, clean, setClean, idle, setIdle, arm, wake, swipeEp, kind, curId, epMap, setEpMap,
  episodesLength, effectiveLength, go, duration, playUrl, playKey, setPanel, setTagMenu, toast,
}: Args) {
  const [holdSpeed, setHoldSpeed] = useState(0);
  const [holdSlow, setHoldSlow] = useState(false);
  const [speedLock, setSpeedLock] = useState(0);
  const [lockArmed, setLockArmed] = useState(false);
  const holdRef = useRef(false);
  const lockArmedRef = useRef(false);
  const speedLockTargetRef = useRef<HTMLButtonElement>(null);
  const [scrub, setScrub] = useState<{ pct: number; target: number } | null>(null);
  const scrubTarget = useRef<number | null>(null);
  /* 进度条拖动 */
  const barRef = useRef<HTMLDivElement>(null);
  const barScrub = useRef(false);
  const [barPct, setBarPct] = useState<number | null>(null);
  const gesture = useRef<{
    x: number; y: number; startY: number; t: number; timer: number | null;
    mode: "idle" | "hold" | "scrub" | "pan"; base: number; width: number; playing: boolean;
    zone: HoldZone; speed: HoldSpeed | null; rect: HoldRect; rotation: HoldRotation;
  } | null>(null);
  /* 单击 / 双击判定：单击净屏，双击暂停 */
  const lastTapRef = useRef<{ timer: number | null; clean?: boolean; idle?: boolean }>({ timer: null });
  /* 双指缩放：scale 1~4，平移跟手指 */
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0, g: false });
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());

  useEffect(() => {
    setZoom({ s: 1, x: 0, y: 0, g: false });
    pinchRef.current = null;
    pointersRef.current.clear();
  }, [playUrl, pinchRef]);

  /* 锁定命中 = 手指真的移入顶部倍速胶囊（含旋转后的 DOM 矩形）；静止手指压着
     新出现的提示不算移入（先走 12px 位移门槛）。 */
  const isOverSpeedLock = (clientX: number, clientY: number) => {
    const g = gesture.current, target = speedLockTargetRef.current;
    if (!g || g.mode !== "hold" || g.zone !== "fast" || !target) return false;
    const point = getHoldPoint(clientX, clientY, g.rect, g.rotation);
    return Math.hypot(point.x - g.x, point.y - g.y) >= 12
      && isInsideHoldTarget(clientX, clientY, target.getBoundingClientRect());
  };

  /* —— 长按加速（移入顶部胶囊锁定） / 横拖定位 / 单击净屏、双击暂停 —— */
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked || !active || showHoldGuide) return;
    if (e.pointerType === "touch" && e.isPrimary && !pinchRef.current && !gesture.current && pointersRef.current.size > 0) {
      pointersRef.current.clear();
    }
    if (!pointersRef.current.has(e.pointerId) && pointersRef.current.size >= 2) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const rotation: HoldRotation = rotated ? 90 : 0;
    const point = getHoldPoint(e.clientX, e.clientY, rect, rotation);
    pointersRef.current.set(e.pointerId, { x: point.x, y: point.y });
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      pinchRef.current = {
        d0: d,
        mx0: (pts[0].x + pts[1].x) / 2,
        my0: (pts[0].y + pts[1].y) / 2,
        s0: zoom.s,
        x0: zoom.x,
        y0: zoom.y,
      };
      if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
      if (gesture.current?.mode === "scrub") {
        setScrub(null); scrubTarget.current = null;
        if (gesture.current.playing && active) videoRef.current?.play();
      }
      gesture.current = null;
      if (holdRef.current) { holdRef.current = false; setHoldSpeed(0); setHoldSlow(false); }
      lockArmedRef.current = false;
      setLockArmed(false);
      setZoom((z) => ({ ...z, g: true }));
      return;
    }
    if (gesture.current || e.button !== 0) return;
    const width = point.width || 1;
    // 分区/引导共用播放器坐标：CSS 旋转横屏下「视频右上」不再是「屏幕右上」。
    const zone = getHoldZone(point.x, point.y, point.width, point.height);
    const g = {
      x: point.x, y: point.y, startY: point.y, t: Date.now(), base: videoRef.current?.el()?.currentTime ?? playbackClock.getSnapshot(), width,
      mode: "idle" as "idle" | "hold" | "scrub" | "pan",
      zone, speed: null as HoldSpeed | null, rect, rotation,
      playing: videoRef.current?.el()?.paused === false,
      timer: window.setTimeout(() => {
        const cur = gesture.current;
        if (!cur || cur.mode !== "idle") return;
        cur.mode = "hold";
        if (cur.zone === "menu") {
          holdRef.current = false;
          setLockArmed(false);
          lockArmedRef.current = false;
          return;
        }
        holdRef.current = true;
        if (cur.zone === "slow") setHoldSlow(true);
        else { cur.speed = createHoldSpeed(cur.x); setHoldSpeed(cur.speed.rate); }
        setLockArmed(false);
        lockArmedRef.current = false;
        try { navigator.vibrate?.(25); } catch { /* ignore */ }
      }, HOLD_DELAY_MS) as unknown as number,
    };
    gesture.current = g;
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const point = getHoldPoint(e.clientX, e.clientY, g?.rect ?? e.currentTarget.getBoundingClientRect(), g?.rotation ?? (rotated ? 90 : 0));
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: point.x, y: point.y });
    }
    const p = pinchRef.current;
    if (p && pointersRef.current.size >= 2) {
      const pts = [...pointersRef.current.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mx = (pts[0].x + pts[1].x) / 2;
      const my = (pts[0].y + pts[1].y) / 2;
      const s = Math.min(4, Math.max(1, p.s0 * (d / p.d0)));
      setZoom({ s, x: p.x0 + (mx - p.mx0), y: p.y0 + (my - p.my0), g: true });
      return;
    }
    if (!g || isDesktop) return;
    const dx = point.x - g.x, dy = point.y - g.y;

    /* 长按中：加速区左右滑换挡；移入顶部胶囊才 armed，减速/中心区不锁 */
    if (g.mode === "hold") {
      if (g.zone !== "fast") return;
      const step = g.speed && shiftHoldSpeed(g.speed, point.x); if (step) setHoldSpeed(step);
      const armed = isOverSpeedLock(e.clientX, e.clientY);
      if (armed !== lockArmedRef.current) {
        lockArmedRef.current = armed;
        setLockArmed(armed);
      }
      return;
    }

    if (g.mode === "idle") {
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) {
        if (g.timer) window.clearTimeout(g.timer);
        g.mode = "scrub";
        wake();
        videoRef.current?.pause();
      } else {
        if (Math.abs(dy) > 14) {
          if (g.timer) window.clearTimeout(g.timer);
          g.mode = "pan";
        }
        return;
      }
    }

    if (g.mode === "scrub") {
      const rawTotal = duration || videoRef.current?.el()?.duration || 0;
      const total = Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : 0;
      if (!total) return;
      const target = Math.max(0, Math.min(total, g.base + (dx / g.width) * total));
      scrubTarget.current = target;
      setScrub({ pct: (target / total) * 100, target });
    }
  };

  const onUp = (cancelled = false, e?: ReactPointerEvent<HTMLDivElement>) => {
    if (e) pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2 && pinchRef.current) {
      pinchRef.current = null;
      // 松手后小于 1.05x 就归位，避免残留"歪着"的画面
      setZoom((z) => (z.s < 1.05 ? { s: 1, x: 0, y: 0, g: false } : { s: z.s, x: z.x, y: z.y, g: false }));
    }
    const g = gesture.current;
    // 松手位置再验一次命中：armed 之后手指又移出胶囊的，不锁定。
    const releasedOnLock = !cancelled && !!e && isOverSpeedLock(e.clientX, e.clientY);
    gesture.current = null;
    /* 长按状态必须无条件复位：切集 / 组件重建会把手势对象清掉，
       但 holdRef 若留在 true，下面的 touchmove 会一直 preventDefault，
       整个列表就再也滑不动（表现为「播放后不能上滑」）。 */
    if (holdRef.current) { holdRef.current = false; setHoldSpeed(0); setHoldSlow(false); }
    if (lockArmedRef.current) { lockArmedRef.current = false; setLockArmed(false); }
    if (!g) return;
    if (g.timer) window.clearTimeout(g.timer);

    if (g.mode === "hold") {
      holdRef.current = false;
      setHoldSpeed(0);
      setHoldSlow(false);
      if (releasedOnLock) {
        setSpeedLock(g.speed?.rate || 2);
        toast(`已锁定 ${g.speed?.rate || 2}x 倍速 · 点顶部标签解除`, "info");
      }
      lockArmedRef.current = false;
      setLockArmed(false);
      return;
    }
    if (g.mode === "scrub") {
      const target = scrubTarget.current;
      if (!cancelled && target != null) {
        videoRef.current?.seek(target, "mobile_gesture");
        playbackClock.publish(target);
      }
      setScrub(null);
      scrubTarget.current = null;
      if (g.playing && active) videoRef.current?.play();
      return;
    }
    /* 上下划手势（swipeEp 开启时 overlay 是 touch-action:none，
       原生滚动不参与，这里抬手一次性判定；关着时走原生滚动切剧） */
    if (!cancelled && e && g.mode === "pan") {
      const point = getHoldPoint(e.clientX, e.clientY, g.rect, g.rotation);
      const dy = point.y - g.startY;
      const dx2 = point.x - g.x;
      if (Math.abs(dy) > 56 && Math.abs(dy) > Math.abs(dx2)) {
        const ep = epMap[curId] || 1;
        const total = episodesLength;
        if (fs && kind === "video") {
          const result = resolveFullscreenEpisodeSwipe(ep, total, dy);
          if (result && "message" in result) {
            toast(result.message, "info");
            return;
          }
          if (result) {
            const want = result.target;
            setEpMap((m) => ({ ...m, [curId]: want }));
            toast(`第 ${want}集${total ? ` / ${total}` : ""}`, "info", "episode");
            try { navigator.vibrate?.(12); } catch { /* ignore */ }
            return;
          }
        }
        const dir = dy < 0 ? 1 : -1;
        const want = dir === 1 ? (total > 1 && ep < total ? ep + 1 : 0) : (ep > 1 ? ep - 1 : 0);
        if (swipeEp && kind === "video" && want) {
          setEpMap((m) => ({ ...m, [curId]: want }));
          toast(`第 ${want}集${total ? ` / ${total}` : ""}`, "info", "episode");
          try { navigator.vibrate?.(12); } catch { /* ignore */ }
          return;
        }
        if (swipeEp) { go(dir); return; }
      }
    }
    if (!cancelled && g.mode === "idle" && Date.now() - g.t < 260) {
      // 首击立即反馈；第二击恢复首击前的界面，再切换播放。
      if (lastTapRef.current.timer) {
        window.clearTimeout(lastTapRef.current.timer);
        lastTapRef.current.timer = null;
        setClean(lastTapRef.current.clean ?? false);
        if (!isDesktop && fs) setIdle(lastTapRef.current.idle ?? false);
        if (!isDesktop && fs && !lastTapRef.current.idle) arm();
        videoRef.current?.toggle();
      } else {
        lastTapRef.current.clean = clean;
        lastTapRef.current.idle = idle;
        setClean(!clean);
        if (!isDesktop && fs) setIdle(!idle);
        /* Re-arm the auto-hide timer whenever fullscreen controls become visible. */
        if (!isDesktop && fs) arm();
        lastTapRef.current.timer = window.setTimeout(() => {
          lastTapRef.current.timer = null;
        }, 230) as unknown as number;
      }
    }
  };

  useEffect(() => {
    if (!active || controlsLocked || showHoldGuide) {
      if (!active) { setPanel(null); setTagMenu(false); }
      onUp(true);
      pointersRef.current.clear();
      pinchRef.current = null;
      if (lastTapRef.current.timer) window.clearTimeout(lastTapRef.current.timer);
      lastTapRef.current.timer = null;
    }
    // Cancel pending gestures when the page is hidden or controls are locked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controlsLocked, showHoldGuide]);

  useEffect(() => () => {
    if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
    if (lastTapRef.current.timer) window.clearTimeout(lastTapRef.current.timer);
    lastTapRef.current.timer = null;
    gesture.current = null;
    holdRef.current = false;
    lockArmedRef.current = false;
  }, [playKey]);

  /* 长按倍速期间禁止原生滚动，否则上滑会被列表吃掉、锁不住倍速 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const fn = (e: TouchEvent) => { if (holdRef.current && gesture.current?.mode === "hold") e.preventDefault(); };
    el.addEventListener("touchmove", fn, { passive: false });
    return () => el.removeEventListener("touchmove", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, effectiveLength]);

  /* —— 进度条拖动（旋转舞台下按 Y 轴换算） —— */
  const barPctAt = (clientX: number, clientY: number) => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r) return null;
    const span = rotated ? r.height : r.width;
    if (!span) return null;
    const raw = rotated ? (clientY - r.top) / span : (clientX - r.left) / span;
    return Math.max(0, Math.min(1, raw));
  };
  const barSeekTo = (clientX: number, clientY: number) => {
    const pct = barPctAt(clientX, clientY);
    if (pct == null) return null;
    setBarPct(pct);
    return pct;
  };
  useEffect(() => {
    barScrub.current = false;
    setBarPct(null);
  }, [active, fs, clean, playKey]);

  const onBarDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    barRef.current = e.currentTarget;
    videoRef.current?.trace("seek.input.down", { input: "mobile_bar" });
    barScrub.current = true;
    wake();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    barSeekTo(e.clientX, e.clientY);
  };
  const onBarMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    e.stopPropagation();
    wake();
    videoRef.current?.trace("seek.input.move", { input: "mobile_bar" });
    barSeekTo(e.clientX, e.clientY);
  };
  const onBarUp = (e: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!barScrub.current) return;
    barScrub.current = false;
    e.stopPropagation();
    wake();
    const pct = !cancelled ? barPctAt(e.clientX, e.clientY) : null;
    if (pct != null && duration) {
      const target = pct * duration;
      videoRef.current?.trace("seek.input.up", { input: "mobile_bar", target });
      videoRef.current?.seek(target, "mobile_bar");
      playbackClock.publish(target);
    }
    setBarPct(null);
  };

  return {
    zoom,
    setZoom,
    holdSpeed,
    holdSlow,
    speedLock,
    setSpeedLock,
    lockArmed,
    speedLockTargetRef,
    scrub,
    barRef,
    barPct,
    onDown,
    onMove,
    onUp,
    onBarDown,
    onBarMove,
    onBarUp,
  };
}
