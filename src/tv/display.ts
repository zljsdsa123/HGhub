import { useSyncExternalStore } from "react";
import { isTv } from "../edition";

export type TvDisplay = { horizontal: number; top: number; bottom: number };
const KEY = "hghubx_tv_display_v1";
const LEGACY_KEY = "hghubx.tv.display.v1";
const defaults: TvDisplay = { horizontal: 3, top: 3, bottom: 3 };
const clamp = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value)
  ? Math.min(12, Math.max(0, Math.round(value))) : fallback;
function read(): TvDisplay {
  try {
    let raw = localStorage.getItem(KEY);
    if (raw === null) {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy !== null) {
        raw = legacy;
        try {
          localStorage.setItem(KEY, legacy);
          if (localStorage.getItem(KEY) === legacy) localStorage.removeItem(LEGACY_KEY);
        } catch { /* retain legacy on write failure */ }
      }
    } else {
      try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
    }
    const value = JSON.parse(raw || "null");
    return { horizontal: clamp(value?.horizontal, 3), top: clamp(value?.top, 3), bottom: clamp(value?.bottom, 3) };
  } catch { return { ...defaults }; }
}
let current = isTv ? read() : defaults;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => current;

function apply() {
  const style = document.documentElement.style;
  style.setProperty("--tv-inset-x", `${current.horizontal}vw`);
  style.setProperty("--tv-inset-top", `${current.top}vh`);
  style.setProperty("--tv-inset-bottom", `${current.bottom}vh`);
}

/** Shared safe padding for controls and reading surfaces; never shrink video. */
export function installTvDisplay() {
  if (!isTv) return;
  document.documentElement.dataset.appEdition = "tv";
  document.title = "HGhubX TV";
  apply();
  window.addEventListener("storage", event => {
    if (event.key !== KEY && event.key !== null) return;
    current = read(); apply(); listeners.forEach(listener => listener());
  });
}

export function setTvDisplay(value: TvDisplay): boolean {
  current = { horizontal: clamp(value.horizontal, 3), top: clamp(value.top, 3), bottom: clamp(value.bottom, 3) };
  apply();
  let saved = true;
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { saved = false; }
  listeners.forEach(listener => listener());
  return saved;
}
export const useTvDisplay = () => useSyncExternalStore(subscribe, snapshot, snapshot);
