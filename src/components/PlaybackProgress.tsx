import { useSyncExternalStore, type HTMLAttributes } from "react";
import { fmtTime } from "../api";
import type { PlaybackClock } from "../playbackClock";

/** Only these small subscribers repaint on timeupdate, not the entire Feed. */
export function PlaybackProgress({ clock, duration, preview, position = false, ...props }: HTMLAttributes<HTMLDivElement> & {
  clock: PlaybackClock; duration: number; preview: number | null; position?: boolean;
}) {
  const time = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  const value = Math.max(0, Math.min(1, preview ?? (duration > 0 ? time / duration : 0)));
  return <div {...props} style={{ ...props.style, [position ? "left" : "width"]: `${value * 100}%` }} />;
}

export function PlaybackTime({ clock, ...props }: HTMLAttributes<HTMLSpanElement> & { clock: PlaybackClock }) {
  const time = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  return <span {...props}>{fmtTime(time)}</span>;
}
