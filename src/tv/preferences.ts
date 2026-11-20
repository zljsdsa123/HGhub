import { useSyncExternalStore } from "react";
type PlaybackPreferences = { rate: number; quality: "main" | "hevc"; autoplayNext: boolean };
const KEY = "hghubx_tv_playback_v1";
const LEGACY_KEY = "hghubx-tv-playback-v1";
function read(): PlaybackPreferences {
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
    const value = JSON.parse(raw || "{}");
    return { rate: [0.75, 1, 1.25, 1.5, 2].includes(value.rate) ? value.rate : 1, quality: value.quality === "hevc" ? "hevc" : "main", autoplayNext: value.autoplayNext !== false };
  }
  catch { return { rate: 1, quality: "main", autoplayNext: true }; }
}
let state = read();
const listeners = new Set<() => void>();
export function setPlaybackPreferences(value: Partial<PlaybackPreferences>) { state = { ...state, ...value }; try { localStorage.setItem(KEY, JSON.stringify(state)); } finally { listeners.forEach(fn => fn()); } }
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const usePlaybackPreferences = () => useSyncExternalStore(subscribe, () => state);
