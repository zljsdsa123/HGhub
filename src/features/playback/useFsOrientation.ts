import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Leaving immersive fullscreen from any path (hardware back, Esc, page cover) must restore
    orientation, while playback keepAlive only runs if the player remains active. */
export function useFsOrientation(fs: boolean, isDesktop: boolean, keepAlive: () => void, active = true) {
  const wasFs = useRef(false);
  useEffect(() => {
    const entered = wasFs.current;
    wasFs.current = fs;
    if (!entered || fs || isDesktop) return;
    if (active) keepAlive();
    try { void invoke("set_orientation", { landscape: false }); } catch { /* ignore */ }
    try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
  }, [fs, isDesktop, keepAlive, active]);
}
