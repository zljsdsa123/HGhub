import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isMobile } from "../../shared/api/api";
import { registerOverlayBack } from "../../shared/lib/back";
import {
  exitDocumentFullscreen, getFullscreenElement, onFullscreenChange,
  requestElementFullscreen, setTauriWindowFullscreen,
} from "../../shared/lib/fullscreen";

type Activity = {
  play: (source: string, automatic?: boolean) => void;
  isActive: () => boolean;
  isPlayWanted: () => boolean;
};
type Options = {
  active: boolean;
  src: string;
  scopeKey?: string | number;
  videoRef: RefObject<HTMLVideoElement | null>;
  activity: Activity;
};

/** One persistent portal target keeps the media element and HLS instance alive in both layouts. */
export function useInlinePlayerFullscreen({ active, src, scopeKey, videoRef, activity }: Options) {
  const slotRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "inline-player-host";
    return element;
  });
  const [fallback, setFallback] = useState(false);
  const [nativeFull, setNativeFull] = useState(false);
  const resolvedScope = scopeKey ?? src;
  const latest = useRef({ active, src, resolvedScope, activity });
  latest.current = { active, src, resolvedScope, activity };
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const nativeIntent = useRef(false);
  const fallbackRef = useRef(false);
  const restoreFrame = useRef(0);
  const scope = useRef({ active, resolvedScope });

  const exitNative = useCallback((target = wrapRef.current) => {
    if (!target || getFullscreenElement() !== target) return;
    try { void exitDocumentFullscreen().catch(() => {}); } catch { /* A detached WebView can reject synchronously. */ }
  }, []);

  const close = useCallback(() => {
    generation.current++;
    pending.current = false;
    nativeIntent.current = false;
    if (fallbackRef.current) {
      fallbackRef.current = false;
      if (!isMobile) setTauriWindowFullscreen(false);
    }
    setFallback(false);
    exitNative();
  }, [exitNative]);

  const toggleFull = useCallback(() => {
    if (!mounted.current || !latest.current.active) return;
    const target = wrapRef.current;
    if (!target) return;
    if (fallbackRef.current || getFullscreenElement() === target || pending.current) { close(); return; }
    const token = ++generation.current;
    const scopeId = latest.current.resolvedScope;
    pending.current = true;
    nativeIntent.current = true;
    const current = () => mounted.current && generation.current === token && latest.current.active && latest.current.resolvedScope === scopeId;
    const useFallback = () => {
      if (!current()) return;
      nativeIntent.current = false;
      fallbackRef.current = true;
      setFallback(true);
      setNativeFull(false);
      if (!isMobile) setTauriWindowFullscreen(true);
    };
    void (async () => {
      try {
        await requestElementFullscreen(target);
        if (!current()) {
          // Do not close a newer request on this same player.
          if (!nativeIntent.current) exitNative(target);
          return;
        }
        if (getFullscreenElement() === target) setNativeFull(true);
        else useFallback();
      } catch { useFallback(); }
      finally { if (generation.current === token) pending.current = false; }
    })();
  }, [close, exitNative]);

  useLayoutEffect(() => {
    mounted.current = true;
    const target = wrapRef.current;
    const onFullscreen = () => {
      const own = !!wrapRef.current && getFullscreenElement() === wrapRef.current;
      if (own && (!latest.current.active || !nativeIntent.current)) { exitNative(); return; }
      setNativeFull(own);
      if (!own && !pending.current) nativeIntent.current = false;
    };
    const removeFullscreen = onFullscreenChange(onFullscreen);
    return () => {
      mounted.current = false;
      generation.current++;
      pending.current = false;
      nativeIntent.current = false;
      if (fallbackRef.current) {
        fallbackRef.current = false;
        if (!isMobile) setTauriWindowFullscreen(false);
      }
      cancelAnimationFrame(restoreFrame.current);
      exitNative(target);
      removeFullscreen();
      host.remove();
    };
  }, [host, exitNative]);

  useLayoutEffect(() => {
    if (scope.current.resolvedScope !== resolvedScope || !active) close();
    scope.current = { active, resolvedScope };
  }, [active, resolvedScope, close]);

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
    // 老 WebView 不认识 inset 简写与 dvh；用四边写法并探测 dvh（#138 兼容移植）。
    Object.assign(host.style, expanded
      ? { position: "fixed", top: "0", right: "0", bottom: "0", left: "0", width: "100%", height: CSS.supports("height", "100dvh") ? "100dvh" : "100vh", zIndex: "90", background: "#000", overflow: "hidden" }
      : { position: "relative", top: "", right: "", bottom: "", left: "", width: "100%", height: "100%", zIndex: "", background: "", overflow: "" });
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
  useEffect(() => {
    if (!isMobile || !full) return;
    let locked = false;
    const syncOrientation = () => {
      const v = videoRef.current;
      if (!v || v.videoHeight <= 0 || v.videoWidth <= v.videoHeight) return;
      locked = true;
      try { void invoke("set_orientation", { landscape: true }).catch(() => {}); } catch { /* ignore */ }
      try {
        (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape")?.catch(() => {});
      } catch { /* ignore */ }
    };
    syncOrientation();
    const v = videoRef.current;
    v?.addEventListener("loadedmetadata", syncOrientation);
    return () => {
      v?.removeEventListener("loadedmetadata", syncOrientation);
      if (locked) {
        try { void invoke("set_orientation", { landscape: false }).catch(() => {}); } catch { /* ignore */ }
        try {
          (screen.orientation as unknown as { unlock?: () => void })?.unlock?.();
        } catch { /* ignore */ }
      }
    };
  }, [full, src, videoRef]);

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
