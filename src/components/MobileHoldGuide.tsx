import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { getHoldMenuBounds } from "../mobileHold";
import { Button } from "./ios/controls";
import { GuideFrame } from "./ios/overlays";
import "../styles/mobile-hold-guide.css";

type Props = {
  open: boolean;
  onClose: () => void;
  target: RefObject<HTMLDivElement | null>;
  bottomInset: number;
};
type Layout = { width: number; height: number; left: number; top: number; targetWidth: number; targetHeight: number };

export default function MobileHoldGuide({ open, onClose, target, bottomInset }: Props) {
  return <GuideFrame open={open} onClose={onClose} label="视频长按操作提示">
    <GuideContent target={target} bottomInset={bottomInset} onClose={onClose} />
  </GuideFrame>;
}

function GuideContent({ target, bottomInset, onClose }: Omit<Props, "open">) {
  const root = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const maskId = useId();
  useLayoutEffect(() => {
    const frame = root.current;
    const surface = target.current;
    if (!frame || !surface) return;
    let raf = 0;
    const measure = () => {
      const host = frame.getBoundingClientRect();
      const rect = surface.getBoundingClientRect();
      if (host.width <= 0 || host.height <= 0 || rect.width <= 0 || rect.height <= 0) {
        setLayout(null);
        return;
      }
      const next = { width: host.width, height: host.height, left: rect.left - host.left,
        top: rect.top - host.top, targetWidth: rect.width, targetHeight: rect.height };
      setLayout(previous => previous && Object.keys(next).every(key => previous[key as keyof Layout] === next[key as keyof Layout]) ? previous : next);
    };
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(frame);
    observer.observe(surface);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    // Page-entry transforms can change screen coordinates without changing element size.
    const motionEnd = () => schedule();
    document.addEventListener("animationend", motionEnd, true);
    document.addEventListener("transitionend", motionEnd, true);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.removeEventListener("animationend", motionEnd, true);
      document.removeEventListener("transitionend", motionEnd, true);
    };
  }, [target]);

  const bounds = layout ? getHoldMenuBounds(layout.targetWidth, layout.targetHeight) : null;
  const compact = !!layout && layout.targetWidth > layout.targetHeight;
  const point = (x: number, y: number): CSSProperties => layout
    ? { left: layout.left + layout.targetWidth * x, top: layout.top + layout.targetHeight * y }
    : {};
  return <div ref={root} className="mobile-hold-guide" data-mobile-hold-guide data-ready={!!layout}
    data-compact={compact} style={{ "--hold-guide-bottom": `${Math.max(0, bottomInset)}px` } as CSSProperties}
    onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()}
    onPointerUp={event => event.stopPropagation()} onPointerCancel={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
    {layout && bounds && <>
      <svg className="mobile-hold-guide-map" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
        <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={layout.width} height={layout.height}>
          <rect width={layout.width} height={layout.height} fill="white" />
          <rect x={layout.left + bounds.left} y={layout.top + bounds.top} width={bounds.size} height={bounds.size} fill="black" />
        </mask></defs>
        <rect width={layout.width} height={layout.height} fill="rgb(7 11 21 / .76)" mask={`url(#${maskId})`} />
        <g mask={`url(#${maskId})`}>
          <path d={`M ${layout.left} ${layout.top} H ${layout.left + layout.targetWidth} V ${layout.top + layout.targetHeight} Z`} fill="rgb(112 230 220 / .12)" />
          <path d={`M ${layout.left} ${layout.top} V ${layout.top + layout.targetHeight} H ${layout.left + layout.targetWidth} Z`} fill="rgb(249 199 124 / .12)" />
          <path d={`M ${layout.left} ${layout.top} L ${layout.left + layout.targetWidth} ${layout.top + layout.targetHeight}`} stroke="rgb(255 255 255 / .3)" strokeWidth="1" strokeDasharray="5 7" />
        </g>
        <rect className="mobile-hold-guide-square" x={layout.left + bounds.left} y={layout.top + bounds.top}
          width={bounds.size} height={bounds.size} fill="rgb(15 19 30 / .42)" stroke="white" strokeWidth="2" />
      </svg>
      <div className="mobile-hold-guide-heading">
        <span>长按手势</span>
        <h2>长按，按你的位置操作</h2>
        <p>按住约 0.4 秒，松开恢复原速度</p>
      </div>
      <div className="mobile-hold-guide-zone is-fast" style={point(.76, compact ? .34 : .28)}>
        <strong>2×</strong><span>右上 · 按住加速</span>
      </div>
      <div className="mobile-hold-guide-zone is-slow" style={point(.24, compact ? .66 : .65)}>
        <strong>0.5×</strong><span>左下 · 按住减速</span>
      </div>
      <div className="mobile-hold-guide-zone is-menu" data-hold-guide-menu style={{ ...point(.5, .5), width: bounds.size, height: bounds.size }}>
        <span className="mobile-hold-guide-dot" aria-hidden="true" />
        <strong>不感兴趣</strong><span>只在此处长按</span>
      </div>
    </>}
    <div className="mobile-hold-guide-footer">
      <p>加速时上滑，可锁定 2×</p>
      <Button className="mobile-hold-guide-done" onClick={onClose} data-autofocus>知道了</Button>
    </div>
  </div>;
}
