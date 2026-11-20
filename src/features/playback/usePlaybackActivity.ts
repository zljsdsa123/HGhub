import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type Hls from "hls.js";

/** Keep asynchronous autoplay and error recovery subject to the latest page activity. */
export function usePlaybackActivity(
  videoRef: RefObject<HTMLVideoElement | null>, hlsRef: RefObject<Hls | null>,
  { active, autoPlay, src, trace }: { active: boolean; autoPlay: boolean; src: string; trace: (event: string, data?: Record<string, unknown>) => void },
) {
  const latest = useRef({ active, trace }); latest.current = { active, trace };
  const wanted = useRef(autoPlay);
  const mounted = useRef(true);
  const previous = useRef(active);
  useLayoutEffect(() => { wanted.current = autoPlay; }, [src, autoPlay]);

  const inPip = (v: HTMLVideoElement | null) => typeof document !== "undefined" && !!v && document.pictureInPictureElement === v;

  const play = useCallback((source: string, automatic = false) => {
    const v = videoRef.current;
    if (!v) return;
    if (!mounted.current || (!latest.current.active && !inPip(v)) || (automatic && !wanted.current)) {
      latest.current.trace("play.blocked", { source, inactive: !latest.current.active, play_wanted: wanted.current });
      return;
    }
    wanted.current = true;
    const hls = hlsRef.current;
    if (hls?.levels.length && !hls.loadingEnabled) {
      const target = v.currentTime > 0 ? v.currentTime : (hls.config.startPosition >= 0 ? hls.config.startPosition : -1);
      hls.startLoad(target);
    }
    latest.current.trace("play.request", { source });
    v.play().then(() => {
      // The page may have changed while play() was pending.
      if (!mounted.current || (!latest.current.active && !inPip(v))) v.pause();
    }).catch(e => latest.current.trace("play.rejected", { source, error_name: e?.name }));
  }, [videoRef, hlsRef]);

  const pause = useCallback((source = "handle") => {
    wanted.current = false;
    latest.current.trace("pause.request", { source });
    videoRef.current?.pause();
  }, [videoRef]);

  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    mounted.current = true;
    const hls = hlsRef.current;
    if (!active) {
      // Keep Picture-in-Picture playing across tab/page navigation until PiP exits.
      if (inPip(v)) {
        previous.current = active;
        return;
      }
      // Include pauses made through native/PiP controls, which bypass our buttons.
      if (v.readyState >= 2) wanted.current = !v.paused;
      v.pause();
      // Let an in-flight manifest finish, but stop fragment loading for hidden pages.
      if (hls?.levels.length) hls.stopLoad();
      latest.current.trace("page.suspended", { play_wanted: wanted.current });
    } else if (!previous.current) {
      if (hls?.levels.length && !hls.loadingEnabled) {
        const target = v.currentTime > 0 ? v.currentTime : (hls.config.startPosition >= 0 ? hls.config.startPosition : -1);
        hls.startLoad(target);
      }
      if (wanted.current && (hls?.levels.length || v.readyState > 0)) play("page_active", true);
    }
    previous.current = active;
  }, [active, play, videoRef, hlsRef]);

  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const guard = () => {
      if (latest.current.active || inPip(v)) return;
      latest.current.trace("play.blocked", { source: "media_event", inactive: true });
      v.pause();
      if (hlsRef.current?.levels.length) hlsRef.current.stopLoad();
    };
    const onLeavePip = () => {
      if (latest.current.active) return;
      wanted.current = !v.paused;
      v.pause();
      if (hlsRef.current?.levels.length) hlsRef.current.stopLoad();
      latest.current.trace("page.suspended", { play_wanted: wanted.current, source: "pip_exit" });
    };
    v.addEventListener("play", guard);
    v.addEventListener("playing", guard);
    v.addEventListener("leavepictureinpicture", onLeavePip);
    return () => {
      mounted.current = false;
      v.removeEventListener("play", guard);
      v.removeEventListener("playing", guard);
      v.removeEventListener("leavepictureinpicture", onLeavePip);
      v.pause();
    };
  }, [videoRef, hlsRef]);

  return {
    play,
    pause,
    setPlayWanted: (on: boolean) => { wanted.current = on; },
    isActive: () => mounted.current && (latest.current.active || inPip(videoRef.current)),
    isPlayWanted: () => wanted.current,
  };
}
