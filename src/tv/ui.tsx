import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cover } from "../shared/api/api";
import { useContentPreferences } from "../shared/model/contentPreferences";
import { contentKey, type TvContent } from "./model";
import { focusElement, focusables, useRemoteScope } from "./remote";

export function TvCard({ content, onOpen, placeholder = false }: { content: TvContent; onOpen: (content: TvContent) => void; placeholder?: boolean }) {
  const { blockReason } = useContentPreferences();
  const blocked = blockReason(content.tags);
  if (blocked && !placeholder) return null;
  return <button className={`tv-card ${content.kind === "post" ? "tv-card-wide" : ""}`} data-tv-focus={contentKey(content)} onClick={() => onOpen(content)} aria-label={blocked ? "已屏蔽的内容" : content.title}>
    <div className="tv-card-art">{blocked ? <span className="tv-neutral">已屏蔽</span> : content.cover ? <img src={cover(content.cover)} alt="" loading="lazy" /> : <span className="tv-neutral">HGhubX</span>}
      {!blocked && !!content.score && <span className="tv-score">{content.score.toFixed(1)}</span>}</div>
    <strong>{blocked ? "已屏蔽的内容" : content.title}</strong><small>{blocked ? "记录已保留" : content.kind === "post" ? "吃瓜视频" : content.episodeCount ? `${content.episodeCount} 集` : "查看详情"}</small>
  </button>;
}
export function TvModal({ id, title, onClose, children }: { id: string; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const trigger = document.activeElement as HTMLElement;
    const root = ref.current!;
    const preferred = root.querySelector<HTMLElement>("[data-tv-initial], [aria-pressed='true'], [aria-current='true']")
      || focusables(root).find(el => !el.closest("header"))
      || focusables(root)[0];
    focusElement(preferred);
    return () => { requestAnimationFrame(() => { if (trigger?.isConnected) focusElement(trigger); }); };
  }, []);
  useRemoteScope({ id, priority: 100, onKey: key => { if (key === "back") { onClose(); return true; } } });
  return <div className="tv-modal-backdrop"><div ref={ref} data-tv-modal={id} className="tv-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
    <header data-tv-region={`${id}-header`}><h2 id={`${id}-title`}>{title}</h2><button data-tv-focus={`${id}-close`} onClick={onClose}>关闭</button></header>{children}
  </div></div>;
}
export function TvStatus({ busy, error, onRetry, empty }: { busy?: boolean; error?: string; onRetry?: () => void; empty?: string }) {
  return <div className="tv-status" role="status">{busy ? "正在加载…" : error || empty}{!busy && error && onRetry && <button data-tv-focus="retry" onClick={onRetry}>重试</button>}</div>;
}
