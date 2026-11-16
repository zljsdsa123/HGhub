import { Button } from "./ios/controls";
import { useEffect } from "react";
import { ILockF } from "../icons";

/** Shield pointer input and playback shortcuts without pausing the media. */
export default function PlaybackLock({ active, onUnlock }: { active: boolean; onUnlock: () => void }) {
  useEffect(() => {
    if (!active) return;
    const block = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], [data-playback-unlock], [role='dialog']")) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if ([" ", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "f", "t", "m", "l", "s", "c", "e"].includes(key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", block, true);
    return () => window.removeEventListener("keydown", block, true);
  }, [active]);

  return <div data-playback-lock-shield className="absolute inset-0 z-50" style={{ touchAction: "none" }}
    onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
    <Button type="button" data-playback-unlock aria-label="解锁播放控制" title="解锁播放控制" aria-pressed
      onClick={onUnlock} className="playback-unlock absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full flex items-center justify-center">
      <ILockF size={19} />
    </Button>
  </div>;
}
