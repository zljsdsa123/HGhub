import { useEffect, useRef, useState } from "react";
import { useContentPreferences } from "../shared/model/contentPreferences";
import { contentKey, needsLibraryMetadata, type TvContent } from "./model";
import { loadLibraryMetadata } from "./libraryMetadata";
import { useTv } from "./TvProvider";
import { TvCard } from "./ui";

export function LibraryCard({ content, onOpen, active }: { content: TvContent; onOpen: (content: TvContent) => void; active: boolean }) {
  const { source, sourceKey } = useTv(), preferences = useContentPreferences();
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false), [foreground, setForeground] = useState(!document.hidden);
  const [attempt, setAttempt] = useState(0), [failed, setFailed] = useState("");
  const missing = needsLibraryMetadata(content), key = contentKey(content);
  const request = `${key}:${sourceKey}:${preferences.revision}:${attempt}`;
  // Unknown tags in a legacy record must first be resolved. Once known, the
  // ordinary block rules decide if any title/cover can be mounted.
  const blockedKnownTags = content.tags.length > 0 && !!preferences.blockReason(content.tags);
  const eligible = missing && active && visible && foreground && !!source && !blockedKnownTags;
  const latest = useRef({ request, eligible }); latest.current = { request, eligible };
  const error = failed === request;
  useEffect(() => {
    const changed = () => setForeground(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (!active || !missing || !root.current) { setVisible(false); return; }
    if (typeof IntersectionObserver !== "function") { setVisible(true); return; }
    const element = root.current;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, missing]);
  useEffect(() => {
    if (!eligible || error) return;
    let alive = true;
    const current = () => alive && latest.current.request === request && latest.current.eligible;
    void loadLibraryMetadata(content, source, current).catch(() => { if (current()) setFailed(request); });
    return () => { alive = false; };
  }, [eligible, error, request, source]);
  const unresolved = missing && !blockedKnownTags;
  return <div ref={root} style={{ minWidth: 0 }}>
    {unresolved ? <button className={`tv-card ${content.kind === "post" ? "tv-card-wide" : ""}`} data-tv-focus={key}
      aria-label={error ? "信息加载失败，确认重试" : "正在加载影片信息"}
      onClick={() => { if (error) setAttempt(value => value + 1); else onOpen(content); }}>
      <div className="tv-card-art"><span className="tv-neutral">{error ? "重试" : "加载中…"}</span></div>
      <strong>{error ? "信息加载失败" : "正在加载影片信息…"}</strong>
      {error && <small>确认重试</small>}
    </button> : <TvCard content={content} onOpen={onOpen} placeholder />}
  </div>;
}
