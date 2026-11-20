import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent } from "react";

type Props = {
  time: number; duration: number; enabled?: boolean; resetKey?: string;
  onSeek: (time: number, input: string) => void;
  onInteraction?: (phase: string, input: string, target: number, pointerTarget?: number) => void;
};

/** Preview pointer movement locally; commit a single seek on release. Keyboard stays native. */
export function useSeekInput({ time, duration, enabled = true, resetKey, onSeek, onInteraction }: Props) {
  const [preview, setPreview] = useState<number | null>(null);
  const pointer = useRef<{ id: number; x: number; moved: boolean; target: number; el: HTMLInputElement } | null>(null);
  const latest = useRef({ onSeek, onInteraction }); latest.current = { onSeek, onInteraction };
  const seekable = enabled && Number.isFinite(duration) && duration > 0;
  const release = () => {
    const p = pointer.current; pointer.current = null;
    if (p?.el.hasPointerCapture(p.id)) p.el.releasePointerCapture(p.id);
  };
  const cancel = () => {
    const p = pointer.current;
    if (p) latest.current.onInteraction?.("cancel", p.moved ? "drag" : "click", p.target);
    release(); setPreview(null);
  };
  useEffect(() => { cancel(); }, [seekable, duration, resetKey]);
  useEffect(() => () => { release(); }, []);
  const targetAt = (e: PointerEvent<HTMLInputElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return rect.width ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration : 0;
  };
  const displayTime = preview ?? time;
  return {
    time: displayTime,
    scrubbing: preview !== null,
    inputProps: {
      disabled: !seekable, min: 0, max: seekable ? duration : 1, step: .01,
      value: Math.max(0, Math.min(displayTime, seekable ? duration : 0)),
      style: { touchAction: "none" },
      onPointerDown: (e: PointerEvent<HTMLInputElement>) => {
        if (!seekable || e.button !== 0 || pointer.current) return;
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
        const target = targetAt(e);
        pointer.current = { id: e.pointerId, x: e.clientX, moved: false, target, el: e.currentTarget };
        e.currentTarget.setPointerCapture(e.pointerId);
        setPreview(target);
        latest.current.onInteraction?.("down", "pointer", time, target);
        latest.current.onInteraction?.("change", "click", target);
      },
      onPointerMove: (e: PointerEvent<HTMLInputElement>) => {
        const p = pointer.current;
        if (!p || p.id !== e.pointerId) return;
        if (Math.abs(e.clientX - p.x) > 3) p.moved = true;
        p.target = targetAt(e); setPreview(p.target);
        latest.current.onInteraction?.("change", p.moved ? "drag" : "click", p.target);
      },
      onPointerUp: (e: PointerEvent<HTMLInputElement>) => {
        const p = pointer.current;
        if (!p || p.id !== e.pointerId) return;
        const target = targetAt(e), input = p.moved ? "drag" : "click";
        release(); setPreview(null);
        latest.current.onInteraction?.("up", input, target);
        if (seekable) latest.current.onSeek(target, input);
      },
      onPointerCancel: cancel,
      onLostPointerCapture: () => { if (pointer.current) cancel(); },
      onBlur: cancel,
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        if (!seekable || pointer.current) return;
        const target = Number(e.target.value);
        latest.current.onInteraction?.("change", "keyboard", target);
        latest.current.onSeek(target, "keyboard");
      },
    },
  };
}
