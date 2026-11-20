import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { FeedPanel } from "./useFeedViewport";

const TAB_SWIPE_DISTANCE = 56;
const CLOSE_SWIPE_DISTANCE = 72;
const AXIS_RATIO = 1.35;

type PanelTab = "detail" | "episodes";

/** Finds a horizontally scrollable ancestor so carousels keep their own swipe. */
function findHorizontalScroller(target: Element, boundary: HTMLElement): HTMLElement | null {
  let node: Element | null = target;
  while (node && node !== boundary.parentElement) {
    if (node instanceof HTMLElement) {
      const overflow = getComputedStyle(node).overflowX;
      if ((overflow === "auto" || overflow === "scroll") && node.scrollWidth > node.clientWidth + 1) return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** Finds the nearest vertical scroller that owns the gesture. */
function findVerticalScroller(target: Element, boundary: HTMLElement): HTMLElement | null {
  let node: Element | null = target;
  while (node && node !== boundary.parentElement) {
    if (node instanceof HTMLElement) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 1) return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Swipe navigation for the mobile detail/episodes sheet.
 * Horizontal swipes switch tabs, while a downward pull closes the sheet only
 * when the current content is already at the top. Horizontal carousels and
 * vertical lists keep their native gestures.
 */
export function PanelSwipeArea({ panel, onChange, className = "", children }: {
  panel: PanelTab;
  onChange: (panel: FeedPanel) => void;
  className?: string;
  children: ReactNode;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<{ x: number; y: number; pointerId: number; atTop: boolean } | null>(null);
  const touchStart = useRef<{ x: number; y: number; atTop: boolean; lastX: number; lastY: number } | null>(null);

  const canStart = (target: Element, area: HTMLElement) => {
    if (target.closest("input, textarea, select, [data-panel-swipe-ignore]")) return null;
    if (findHorizontalScroller(target, area)) return null;
    const scroller = findVerticalScroller(target, area);
    return { atTop: !scroller || scroller.scrollTop <= 1 };
  };

  const commit = (x: number, y: number, endX: number, endY: number, atTop: boolean) => {
    const dx = endX - x;
    const dy = endY - y;
    if (Math.abs(dx) >= TAB_SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO) {
      const next: PanelTab = dx < 0 ? "episodes" : "detail";
      if (next !== panel) onChange(next);
      return;
    }
    if (atTop && dy >= CLOSE_SWIPE_DISTANCE && dy > Math.abs(dx) * AXIS_RATIO) onChange(null);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || !e.isPrimary || e.button !== 0) return;
    const start = canStart(e.target as Element, e.currentTarget);
    if (!start) return;
    pointerStart.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, atTop: start.atTop };
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = pointerStart.current;
    pointerStart.current = null;
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    commit(gesture.x, gesture.y, e.clientX, e.clientY, gesture.atTop);
  };

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    /* Touch events use native listeners because Pointer Events are cancelled once the browser
       takes over native scrolling; mouse and pen input still uses the Pointer Events above. */
    const begin = (event: TouchEvent) => {
      if (event.touches.length !== 1) { touchStart.current = null; return; }
      const touch = event.touches[0];
      const start = canStart(event.target as Element, area);
      if (!start) { touchStart.current = null; return; }
      touchStart.current = { x: touch.clientX, y: touch.clientY, atTop: start.atTop, lastX: touch.clientX, lastY: touch.clientY };
    };
    const move = (event: TouchEvent) => {
      const gesture = touchStart.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      /* Stop the native pull/overscroll only when a downward swipe at the top should close the sheet. */
      if (gesture.atTop && dy > 8 && dy > Math.abs(dx) * AXIS_RATIO) event.preventDefault();
    };
    const finish = (event: TouchEvent) => {
      const gesture = touchStart.current;
      touchStart.current = null;
      if (!gesture) return;
      const touch = event.changedTouches[0];
      commit(gesture.x, gesture.y, touch?.clientX ?? gesture.lastX, touch?.clientY ?? gesture.lastY, gesture.atTop);
    };
    area.addEventListener("touchstart", begin, { passive: true });
    area.addEventListener("touchmove", move, { passive: false });
    area.addEventListener("touchend", finish, { passive: true });
    area.addEventListener("touchcancel", finish, { passive: true });
    return () => {
      area.removeEventListener("touchstart", begin);
      area.removeEventListener("touchmove", move);
      area.removeEventListener("touchend", finish);
      area.removeEventListener("touchcancel", finish);
    };
  }, [panel, onChange]);

  return <div
    ref={areaRef}
    className={`video-details-sheet-body flex-1 min-h-0 flex flex-col ${className}`}
    onPointerDown={onPointerDown}
    onPointerUp={onPointerUp}
    onPointerCancel={() => { pointerStart.current = null; }}
  >{children}</div>;
}
