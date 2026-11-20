import { Button } from "../../shared/ui/ios/controls";
import { useEffect, useState } from "react";
import { registerOverlayBack } from "../../shared/lib/back";
import { ILockF } from "../../shared/ui/icons";

/** Shield pointer input, hardware back, and playback/shell shortcuts without pausing the media. */
export default function PlaybackLock({
  active, onUnlock, rotated = false, immersive = false,
}: {
  active: boolean; onUnlock: () => void; rotated?: boolean; immersive?: boolean;
}) {
  const [nudge, setNudge] = useState(false);

  useEffect(() => {
    if (!active) return;
    let timer = 0;
    const pulse = () => {
      setNudge(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setNudge(false), 1200);
    };
    const removeBack = registerOverlayBack(() => { pulse(); return true; });
    const block = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], [data-playback-unlock], [role='dialog']")) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if ([
        " ", "Enter", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
        "Home", "End", "PageUp", "PageDown", "/", "1", "2", "3", "4",
        "f", "t", "m", "l", "s", "c", "e",
      ].includes(key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        pulse();
      }
    };
    window.addEventListener("keydown", block, true);
    return () => {
      window.clearTimeout(timer);
      removeBack();
      window.removeEventListener("keydown", block, true);
    };
  }, [active]);

  const rightInset = rotated
    ? "calc(var(--sab, 0px) + 12px)"
    : immersive
      ? "calc(var(--sar, 0px) + 12px)"
      : undefined;

  return <div data-playback-lock-shield className="absolute inset-0 z-50" style={{ touchAction: "none" }}
    onPointerDown={e => { e.stopPropagation(); setNudge(true); }} onClick={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
    <Button type="button" data-playback-unlock aria-label="解锁播放控制" title="解锁播放控制" aria-pressed
      style={rightInset ? { right: rightInset } : undefined}
      onClick={onUnlock} className={`playback-unlock absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full flex items-center justify-center ${nudge ? "is-nudged" : ""}`}>
      <ILockF size={19} />
    </Button>
  </div>;
}
