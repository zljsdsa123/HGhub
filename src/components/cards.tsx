import { fmt } from "../api";
import type { VideoCard } from "../types";
import { IHeartF, IPlayF, IStarF } from "../icons";
import { Img } from "./ui";
import { Button } from "./ios/controls";
import { FilteredContent } from "./FilteredContent";

function ScoreBadge({ score }: { score: number }) {
  return Number.isFinite(score) && score > 0 ? <span className="ios-score-badge" aria-label={`评分 ${score.toFixed(1)}`}>
    <IStarF size={12} />{score.toFixed(1)}
  </span> : null;
}

export function MediaCard({ title, cover, subtitle, badge, progress, score, priority = false, onOpen, blockedReason }: {
  title: string; cover: string; subtitle?: string; badge?: string; progress?: string; score?: number; priority?: boolean; onOpen: () => void; blockedReason?: string | null;
}) {
  if (blockedReason) return <Button onClick={onOpen} className="ios-poster" aria-label="该内容命中屏蔽标签，查看提示">
    <span className="ios-poster-art flex flex-col items-center justify-center gap-3 px-3 text-center text-mut">
      <span className="text-[14px] font-semibold">该内容命中屏蔽标签</span>
      <span className="text-[12px] break-words">{blockedReason}</span>
      <span className="text-[13px] text-primary">查看提示</span>
    </span>
    <span className="ios-poster-title">已屏蔽内容</span>
    {progress && <span className="ios-poster-subtitle">{progress}</span>}
  </Button>;
  return <Button onClick={onOpen} className="ios-poster" aria-label={title}>
    <span className={`ios-poster-art ${badge ? "has-poster-badge" : ""}`}>
      <Img src={cover} alt="" eager={priority} />
      {badge && <span className="ios-poster-badge">{badge}</span>}
      {typeof score === "number" && <ScoreBadge score={score} />}
      {progress && <span className="ios-poster-progress"><IPlayF size={12} />{progress}</span>}
      <span className="ios-poster-play" aria-hidden="true"><IPlayF size={23} /></span>
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
  videos: VideoCard[]; onOpen: (v: VideoCard) => void; wide?: boolean; gap?: string; scopeKey?: string | number;
}) {
  return <FilteredContent items={videos} scopeKey={scopeKey}>{visible => <div className={`ios-media-grid ${wide ? "is-wide" : ""}`} data-ui="media-grid">
    {visible.map((v, index) => <WaterfallCard key={v.id} v={v} priority={index < 2} onOpen={() => onOpen(v)} />)}
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
