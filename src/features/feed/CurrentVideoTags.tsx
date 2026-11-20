import { useEffect, useRef } from "react";
import { normalizeTag } from "../../shared/model/contentPreferences";
import { Button } from "../../shared/ui/ios/controls";

export function CurrentVideoTags({ tags, onOpen, onBlock }: {
  tags: readonly string[];
  onOpen: (tag: string) => void;
  onBlock: (tag: string) => void;
}) {
  const timer = useRef<number | null>(null);
  const heldTag = useRef<string | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const names = tags.map(tag => typeof tag === "string" ? tag.trim().replace(/\s+/g, " ") : "");
  const unique = names.filter((tag, index) => tag && names.findIndex(name => normalizeTag(name) === normalizeTag(tag)) === index);
  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };
  useEffect(() => () => clearTimer(), []);
  if (!unique.length) return null;
  return <div className="current-video-tags" role="group" aria-label="当前视频标签">
    {unique.map(tag => <Button key={normalizeTag(tag)} className="current-video-tag" aria-label={`查看标签 ${tag}，长按可屏蔽`}
      onPointerDown={event => {
        if (event.button !== 0) return;
        clearTimer();
        heldTag.current = null;
        origin.current = { x: event.clientX, y: event.clientY };
        timer.current = window.setTimeout(() => {
          heldTag.current = tag;
          timer.current = null;
          onBlock(tag);
        }, 520);
      }}
      onPointerMove={event => {
        const start = origin.current;
        if (timer.current === null || !start) return;
        /* A moving finger is scrolling, not holding the tag. */
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clearTimer();
      }}
      onPointerUp={clearTimer} onPointerCancel={clearTimer} onPointerLeave={clearTimer}
      onContextMenu={event => {
        event.preventDefault();
        if (heldTag.current !== tag) {
          heldTag.current = tag;
          onBlock(tag);
        }
      }}
      onKeyDown={event => {
        if (event.key !== "Delete" && event.key !== "Backspace") return;
        event.preventDefault();
        onBlock(tag);
      }}
      onClick={event => {
        if (heldTag.current === tag) {
          event.preventDefault();
          heldTag.current = null;
          return;
        }
        onOpen(tag);
      }}>
      <span aria-hidden="true">#</span>{tag}
    </Button>)}
  </div>;
}
