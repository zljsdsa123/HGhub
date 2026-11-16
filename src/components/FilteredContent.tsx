import { useState, type ReactNode } from "react";
import { useContentPreferences } from "../contentPreferences";
import { Button } from "./ios/controls";

/** A local reveal never changes saved preferences or authorizes playback. */
export function FilteredContent<T extends { tags?: readonly string[] }>({ items, children, scopeKey = "", className = "" }: {
  items: T[]; children: (visibleItems: T[]) => ReactNode; scopeKey?: string | number; className?: string;
}) {
  const { revision, blockReason } = useContentPreferences();
  const [reveal, setReveal] = useState<{ revision: number; scope: string | number } | null>(null);
  const expanded = reveal?.revision === revision && reveal.scope === scopeKey;
  // Discard the old reveal, so navigating away and back never resurrects it.
  if (reveal && !expanded) setReveal(null);
  const allowed = items.filter(item => !blockReason(item.tags));
  const hidden = items.length - allowed.length;
  if (!hidden) return <>{children(items)}</>;
  return <>
    <div className={`mb-3 rounded-(--r-md) bg-s2 px-3 py-2 text-[13px] ${className}`} data-content-filter>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-mut">{expanded ? `临时显示 ${hidden} 项已屏蔽内容` : `已隐藏 ${hidden} 项`}</p>
        <Button style={{ minBlockSize: 44 }} aria-expanded={expanded} onClick={() => setReveal(expanded ? null : { revision, scope: scopeKey })}
          className="min-h-11 px-3 text-primary">{expanded ? "恢复隐藏" : "临时展开"}</Button>
      </div>
      {!expanded && !allowed.length && <p className="mt-1 text-mut">已加载内容均被屏蔽，可临时展开或手动加载更多。</p>}
    </div>
    {children(expanded ? items : allowed)}
  </>;
}
