import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { registerOverlayBack } from "./back";

type Activity = {
  play: (source: string, automatic?: boolean) => void;
  isActive: () => boolean;
  isPlayWanted: () => boolean;
};
type Options = { active: boolean; src: string; videoRef: RefObject<HTMLVideoElement | null>; activity: Activity };

/** One persistent portal target keeps the media element and HLS instance alive in both layouts. */
export function useInlinePlayerFullscreen({ active, src, videoRef, activity }: Options) {
  const slotRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "inline-player-host";
    return element;
  });
  const [fallback, setFallback] = useState(false);
  const [nativeFull, setNativeFull] = useState(false);
  const latest = useRef({ active, src, activity }); latest.current = { active, src, activity };
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const nativeIntent = useRef(false);
  const fallbackRef = useRef(false);
  const restoreFrame = useRef(0);
  const scope = useRef({ active, src });

  const exitNative = useCallback((target = wrapRef.current) => {
    if (!target || document.fullscreenElement !== target) return;
    try { void document.exitFullscreen?.().catch(() => {}); } catch { /* A detached WebView can reject synchronously. */ }
  }, []);

  const close = useCallback(() => {
    generation.current++;
    pending.current = false;
    nativeIntent.current = false;
    fallbackRef.current = false;
    setFallback(false);
    exitNative();
  }, [exitNative]);

  const toggleFull = useCallback(() => {
    if (!mounted.current || !latest.current.active) return;
    const target = wrapRef.current;
    if (!target) return;
    if (fallbackRef.current || document.fullscreenElement === target || pending.current) { close(); return; }
    const token = ++generation.current;
    const source = latest.current.src;
    pending.current = true;
    nativeIntent.current = true;
    const current = () => mounted.current && generation.current === token && latest.current.active && latest.current.src === source;
    const useFallback = () => {
      if (!current()) return;
      nativeIntent.current = false;
      fallbackRef.current = true;
      setFallback(true);
      setNativeFull(false);
    };
    void (async () => {
      try {
        if (typeof target.requestFullscreen !== "function") { useFallback(); return; }
        await target.requestFullscreen();
        if (!current()) {
          // Do not close a newer request on this same player.
          if (!nativeIntent.current) exitNative(target);
          return;
        }
        if (document.fullscreenElement === target) setNativeFull(true);
        else useFallback();
      } catch { useFallback(); }
      finally { if (generation.current === token) pending.current = false; }
    })();
  }, [close, exitNative]);

  useLayoutEffect(() => {
    mounted.current = true;
    const target = wrapRef.current;
    const onFullscreen = () => {
      const own = !!wrapRef.current && document.fullscreenElement === wrapRef.current;
      if (own && (!latest.current.active || !nativeIntent.current)) { exitNative(); return; }
      setNativeFull(own);
      if (!own && !pending.current) nativeIntent.current = false;
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      mounted.current = false;
      generation.current++;
      pending.current = false;
      nativeIntent.current = false;
      cancelAnimationFrame(restoreFrame.current);
      exitNative(target);
      document.removeEventListener("fullscreenchange", onFullscreen);
      host.remove();
    };
  }, [host, exitNative]);

  useLayoutEffect(() => {
    if (scope.current.src !== src || !active) close();
    scope.current = { active, src };
  }, [active, src, close]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const expanded = fallback && active;
    const destination = expanded ? document.body : slot;
    // Theme colors remain inherited from html; preserve shell-specific safe-area values.
    for (const name of ["--sat", "--sab"]) {
      const value = getComputedStyle(slot).getPropertyValue(name);
      if (expanded && value) host.style.setProperty(name, value);
      else host.style.removeProperty(name);
    }
    Object.assign(host.style, expanded
      ? { position: "fixed", inset: "0", width: "100%", height: "100dvh", zIndex: "90", background: "#000", overflow: "hidden" }
      : { position: "relative", inset: "", width: "100%", height: "100%", zIndex: "", background: "", overflow: "" });
    if (host.parentNode === destination) return;
    const video = videoRef.current;
    const playing = !!video && !video.paused && latest.current.activity.isPlayWanted();
    const source = latest.current.src;
    const token = generation.current;
    destination.appendChild(host);
    cancelAnimationFrame(restoreFrame.current);
    if (playing && video) restoreFrame.current = requestAnimationFrame(() => {
      if (mounted.current && generation.current === token && latest.current.src === source
        && latest.current.active && videoRef.current === video && video.paused
        && latest.current.activity.isActive() && latest.current.activity.isPlayWanted()) {
        latest.current.activity.play("fullscreen_layout_restore", true);
      }
    });
  }, [active, fallback, host, src, videoRef]);

  const full = active && (fallback || nativeFull);
  useLayoutEffect(() => {
    if (!full) return;
    const removeBack = registerOverlayBack(() => { close(); return true; });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      // A newer dialog owns Escape while its controls have focus.
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => { removeBack(); window.removeEventListener("keydown", onKey, true); };
  }, [full, close]);

  return { slotRef, wrapRef, host, full, fallback: active && fallback, toggleFull };
}
