import { normalizeTag } from "../contentPreferences";
import { IChevR } from "../icons";
import { Button } from "./ios/controls";
import "../styles/video-details.css";

/** Tag labels are routes, not decorative badges. Preserve the provider's display spelling. */
export function ContentTags({ tags, onOpen, label = "视频标签" }: {
  tags: readonly string[]; onOpen: (tag: string) => void; label?: string;
}) {
  const names = tags.map(tag => typeof tag === "string" ? tag.trim().replace(/\s+/g, " ") : "");
  const unique = names.filter((tag, index) => tag && names.findIndex(name => normalizeTag(name) === normalizeTag(tag)) === index);
  if (!unique.length) return <p className="video-detail-empty-tags">暂未提供标签</p>;
  return <div className="content-tags" role="group" aria-label={label}>
    {unique.map(tag => <Button key={normalizeTag(tag)} aria-label={`查看标签 ${tag}`} onClick={() => onOpen(tag)} className="content-tag-link">
      <span className="content-tag-hash" aria-hidden="true">#</span>
      <span className="content-tag-name">{tag}</span>
      <IChevR size={13} aria-hidden="true" />
    </Button>)}
  </div>;
}
