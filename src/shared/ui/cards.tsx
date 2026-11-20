import { useEffect, useRef, type ButtonHTMLAttributes } from "react";
import { fmt } from "../api/api";
import type { VideoCard } from "../api/types";
import { ICheck, IHeartF, IPlayF, IStarF } from "./icons";
import { Img } from "./ui";
import { Button } from "./ios/controls";
import { FilteredContent } from "./FilteredContent";

function ScoreBadge({ score }: { score: number }) {
  return Number.isFinite(score) && score > 0 ? <span className="ios-score-badge" aria-label={`评分 ${score.toFixed(1)}`}>
    <IStarF size={12} />{score.toFixed(1)}
  </span> : null;
}

export function MediaCard({ title, cover, subtitle, badge, badgeTone = "default", progress, score, priority = false, onOpen, blockedReason, onLongPress, selectionMode = false, selected = false }: {
  title: string; cover: string; subtitle?: string; badge?: string; badgeTone?: "default" | "update"; progress?: string; score?: number; priority?: boolean; onOpen: () => void; blockedReason?: string | null;
  onLongPress?: () => void; selectionMode?: boolean; selected?: boolean;
}) {
  const pressTimer = useRef<number | undefined>(undefined);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const clearPress = () => {
    window.clearTimeout(pressTimer.current);
    pressTimer.current = undefined;
    pressStart.current = null;
  };
  useEffect(() => clearPress, []);
  const open = () => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    onOpen();
  };
  const triggerLongPress = () => {
    suppressClick.current = true;
    clearPress();
    onLongPress?.();
  };
  const releaseSuppressClick = () => { window.setTimeout(() => { suppressClick.current = false; }, 0); };
  const pressProps: ButtonHTMLAttributes<HTMLButtonElement> = onLongPress ? {
    onPointerDown: event => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      suppressClick.current = false;
      clearPress();
      pressStart.current = { x: event.clientX, y: event.clientY };
      pressTimer.current = window.setTimeout(triggerLongPress, 550);
    },
    onPointerMove: event => {
      const start = pressStart.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clearPress();
    },
    onPointerUp: () => { clearPress(); if (suppressClick.current) releaseSuppressClick(); },
    onPointerCancel: () => { clearPress(); suppressClick.current = false; },
    onContextMenu: event => {
      event.preventDefault();
      if (!suppressClick.current) { triggerLongPress(); releaseSuppressClick(); }
    },
    onDragStart: event => event.preventDefault(),
  } : {};
  const selection = selectionMode ? <span className="ios-poster-select" aria-hidden="true">{selected && <ICheck size={16} strokeWidth={2.4} />}</span> : null;
  const className = `ios-poster${onLongPress ? " has-long-press" : ""}${selected ? " is-selected" : ""}`;
  const ariaLabel = selectionMode ? `${selected ? "取消选择" : "选择"}${title}` : title;
  if (blockedReason) return <Button onClick={open} className={className} aria-label={selectionMode ? ariaLabel : "该内容命中屏蔽标签，查看提示"}
    aria-pressed={selectionMode ? selected : undefined} {...pressProps}>
    <span className="ios-poster-art flex flex-col items-center justify-center gap-3 px-3 text-center text-mut">
      <span className="text-[14px] font-semibold">该内容命中屏蔽标签</span>
      <span className="text-[12px] break-words">{blockedReason}</span>
      <span className="text-[13px] text-primary">查看提示</span>
      {selection}
    </span>
    <span className="ios-poster-title">已屏蔽内容</span>
    {progress && <span className="ios-poster-subtitle">{progress}</span>}
  </Button>;
  const hasScore = typeof score === "number" && Number.isFinite(score) && score > 0;
  return <Button onClick={open} className={className} aria-label={ariaLabel} aria-pressed={selectionMode ? selected : undefined} {...pressProps}>
    <span className={`ios-poster-art${badge ? " has-poster-badge" : ""}${hasScore ? " has-score-badge" : ""}`}>
      <Img src={cover} alt="" eager={priority} />
      {badge && <span className={`ios-poster-badge${badgeTone === "update" ? " is-update" : ""}`}>{badge}</span>}
      {hasScore && <ScoreBadge score={score} />}
      {progress && <span className="ios-poster-progress"><IPlayF size={12} />{progress}</span>}
      <span className="ios-poster-play" aria-hidden="true"><IPlayF size={23} /></span>
      {selection}
    </span>
    <span className="ios-poster-title">{title}</span>
    {subtitle && <span className="ios-poster-subtitle">{subtitle}</span>}
  </Button>;
}

export function WaterfallCard({ v, onOpen, priority = false }: { v: VideoCard; onOpen: () => void; priority?: boolean }) {
  return <MediaCard title={v.title} cover={v.cover} onOpen={onOpen} priority={priority} score={v.score}
    badge={v.is_finished ? "已完结" : `更新至 ${v.episode_count} 集`}
    subtitle={v.tags?.slice(0, 2).join(" · ") || v.author?.name || "HGhubX"}
    progress={`${fmt(v.hot)} 次播放`} />;
}

export function Masonry({ videos, onOpen, wide = false, scopeKey }: {
  videos: VideoCard[]; onOpen: (v: VideoCard, visible: VideoCard[]) => void; wide?: boolean; gap?: string; scopeKey?: string | number;
}) {
  return <FilteredContent items={videos} scopeKey={scopeKey}>{visible => <div className={`ios-media-grid ${wide ? "is-wide" : ""}`} data-ui="media-grid">
    {visible.map((v, index) => <WaterfallCard key={v.id} v={v} priority={index < 2} onOpen={() => onOpen(v, visible)} />)}
  </div>}</FilteredContent>;
}

export function RowCard({ v, onOpen }: { v: VideoCard; onOpen: () => void }) {
  return <div className="ios-row-card"><MediaCard title={v.title} cover={v.cover} score={v.score} onOpen={onOpen}
    badge={v.is_finished ? "完结" : `${v.episode_count} 集`}
    subtitle={v.score ? `${v.score.toFixed(1)} 分 · ${v.tags?.[0] || "短剧"}` : v.tags?.slice(0, 2).join(" · ")} />
  </div>;
}

export function RankRow({ item, onOpen, metricMax }: {
  item: { rank: number; video_id: number; title: string; cover: string; tags: string[]; score: number; metric_value: number; metric_label: string };
  onOpen: () => void; metricMax: number;
}) {
  return <Button className="ios-rank-row" onClick={onOpen}>
    <span className={`ios-rank-number ${item.rank < 4 ? "is-top" : ""}`}>{String(item.rank).padStart(2, "0")}</span>
    <span className="ios-rank-cover"><Img src={item.cover} />{typeof item.score === "number" && <ScoreBadge score={item.score} />}</span>
    <span className="ios-rank-copy"><strong>{item.title}</strong><span>{item.tags?.slice(0, 2).join(" · ")}</span>
      <span className="ios-rank-meter" aria-hidden="true"><span style={{ width: `${Math.max(6, item.metric_value / Math.max(1, metricMax) * 100)}%` }} /></span>
    </span>
    <span className="ios-rank-metric"><IHeartF size={13} />{fmt(item.metric_value)}</span>
  </Button>;
}
