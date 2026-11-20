import { useSyncExternalStore, type HTMLAttributes } from "react";
import { fmtTime } from "../../shared/api/api";
import type { PlaybackClock } from "./playbackClock";

/** Only these small subscribers repaint on timeupdate, not the entire Feed. */
export function PlaybackProgress({ clock, duration, preview, position = false, ...props }: HTMLAttributes<HTMLDivElement> & {
  clock: PlaybackClock; duration: number; preview: number | null; position?: boolean;
}) {
  const time = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  const value = Math.max(0, Math.min(1, preview ?? (duration > 0 ? time / duration : 0)));
  return <div {...props} style={{ ...props.style, [position ? "left" : "width"]: `${value * 100}%` }} />;
}

export function PlaybackTime({ clock, duration, padMinutes = false, ...props }: HTMLAttributes<HTMLSpanElement> & {
  clock: PlaybackClock;
  /** When provided, renders "current / total" in one label. */
  duration?: number;
  padMinutes?: boolean;
}) {
  const time = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  const format = (value: number) => {
    if (!padMinutes) return fmtTime(value);
    const safe = Number.isFinite(value) && value > 0 ? value : 0;
    const minutes = Math.floor(safe / 60).toString().padStart(2, "0");
    const seconds = Math.floor(safe % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
  };
  return <span {...props}>{format(time)}{duration !== undefined && <> / {format(duration)}</>}</span>;
}
