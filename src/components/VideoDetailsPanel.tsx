import { fmt } from "../api";
import type { VideoCard } from "../types";
import { IClose } from "../icons";
import { Button, Surface } from "./ios/controls";
import { Avatar, Img } from "./ui";
import { ContentTags } from "./ContentTags";
import { FilteredContent } from "./FilteredContent";
import { RowCard } from "./cards";
import "../styles/video-details.css";

type VideoMeta = {
  title: string; cover: string; score: number; like: number; collect: number; comment: number;
  author: string; authorId: number; tags: readonly string[]; desc: string;
};

/** One details body for the mobile sheet and desktop dock. */
export default function VideoDetailsPanel({ meta, videoId, episodeCount, related, following, followPending,
  onFollow, onTag, onAuthor, onRelated, onClose, onPreferences }: {
  meta: VideoMeta; videoId: number; episodeCount: number; related: VideoCard[];
  following: boolean; followPending: boolean; onFollow: () => void; onTag: (tag: string) => void;
  onAuthor: () => void; onRelated: (video: VideoCard) => void; onClose?: () => void; onPreferences: () => void;
}) {
  return <div className="video-details-panel" data-video-details>
    {onClose && <div className="video-details-heading">
      <h2>视频详情</h2>
      <Button className="ios-icon-button" aria-label="关闭视频详情" onClick={onClose}><IClose size={18} /></Button>
    </div>}
    <div className="video-details-scroll scroll-y">
      <div className="video-details-overview">
        <Surface className="video-details-cover"><Img src={meta.cover} eager loadingIndicator alt={meta.title} /></Surface>
        <div className="video-details-copy">
          <h3>{meta.title}</h3>
          <div className="video-details-stats">
            {!!meta.score && <span className="text-amber font-bold">{meta.score.toFixed(1)} 分</span>}
            {episodeCount > 0 && <span>共 {episodeCount} 集</span>}
          </div>
          <div className="video-details-stats"><span>点赞 {fmt(meta.like)}</span><span>收藏 {fmt(meta.collect)}</span><span>评论 {fmt(meta.comment)}</span></div>
        </div>
      </div>

      <section className="video-details-section" aria-label="标签导航">
        <div className="video-details-section-heading"><h3>标签 · 点击查看同类</h3>
          <Button className="video-detail-preferences" onClick={onPreferences}>调整内容偏好</Button>
        </div>
        <ContentTags tags={meta.tags} onOpen={onTag} />
      </section>

      <Surface className="video-details-author">
        <Button onClick={onAuthor} disabled={meta.authorId <= 0} className="video-details-author-link">
          <Avatar size={36} name={meta.author} hue={220} />
          <span className="min-w-0"><span className="block text-[14px] font-semibold truncate">{meta.author}</span><span className="text-[12px] text-mut">作者主页</span></span>
        </Button>
        {meta.authorId > 0 && <Button onClick={onFollow} disabled={followPending} aria-busy={followPending} aria-pressed={following}
          className={`video-details-follow ${following ? "bg-s3 text-mut" : "bg-primary text-on-primary"}`}>
          {followPending ? "处理中…" : following ? "已关注" : "+ 关注"}
        </Button>}
      </Surface>

      <section className="video-details-section">
        <h3 className="video-details-section-heading">简介</h3>
        <p className="video-details-description">{meta.desc || "暂无简介"}</p>
      </section>

      {related.length > 0 && <section className="video-details-section">
        <h3 className="video-details-section-heading">相关推荐</h3>
        <FilteredContent items={related.slice(0, 12)} scopeKey={videoId}>{visible => <div className="scroll-x flex gap-2.5 snap-x">
          {visible.map(video => <RowCard key={video.id} v={video} onOpen={() => onRelated(video)} />)}
        </div>}</FilteredContent>
      </section>}
    </div>
  </div>;
}
