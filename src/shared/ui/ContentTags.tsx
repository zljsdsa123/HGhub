import { useEffect, useRef } from "react";
import { normalizeTag } from "../model/contentPreferences";
import { IChevR } from "./icons";
import { Button } from "./ios/controls";
import "../../styles/video-details.css";

/** Tag labels are routes, not decorative badges. Preserve the provider's display spelling. */
export function ContentTags({ tags, onOpen, onBlock, label = "视频标签" }: {
  tags: readonly string[]; onOpen: (tag: string) => void; onBlock?: (tag: string) => void; label?: string;
}) {
  const timer = useRef<number | null>(null);
  const heldTag = useRef<string | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };
  useEffect(() => () => clearTimer(), []);
  const names = tags.map(tag => typeof tag === "string" ? tag.trim().replace(/\s+/g, " ") : "");
  const unique = names.filter((tag, index) => tag && names.findIndex(name => normalizeTag(name) === normalizeTag(tag)) === index);
  if (!unique.length) return <p className="video-detail-empty-tags">暂未提供标签</p>;
  return <div className="content-tags" role="group" aria-label={label}>
    {unique.map(tag => <Button key={normalizeTag(tag)} aria-label={`查看标签 ${tag}`} className="content-tag-link"
      onPointerDown={event => {
        if (!onBlock || event.button !== 0) return;
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
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clearTimer();
      }}
      onPointerUp={clearTimer} onPointerCancel={clearTimer} onPointerLeave={clearTimer}
      onContextMenu={event => {
        if (!onBlock) return;
        event.preventDefault();
        heldTag.current = tag;
        onBlock(tag);
      }}
      onKeyDown={event => {
        if (!onBlock || (event.key !== "Delete" && event.key !== "Backspace")) return;
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
      <span className="content-tag-hash" aria-hidden="true">#</span>
      <span className="content-tag-name">{tag}</span>
      <IChevR size={13} aria-hidden="true" />
    </Button>)}
  </div>;
}
