import { useState } from "react";
import { fmtTime } from "../shared/api/api";
import type { TvContent } from "./model";
import { useTv } from "./TvProvider";
import { TvModal } from "./ui";
import { LibraryCard } from "./LibraryCard";

function formatPartLabel(kind: TvContent["kind"], part: string) {
  if (kind === "post") {
    const idx = Number(part);
    return Number.isInteger(idx) && idx >= 0 ? `分段 ${idx + 1}` : `分段 ${part}`;
  }
  return `第 ${part} 集`;
}

function formatLibraryProgress(content: TvContent, part: string, seconds: number, duration: number, showNewHint: boolean) {
  const watchedEp = content.kind === "video" ? Number(part) || 0 : 0;
  const finishedPart = duration > 0 && seconds >= Math.max(1, duration - 3);
  const base = finishedPart && watchedEp > 0
    ? `已看完第 ${watchedEp} 集`
    : `${formatPartLabel(content.kind, part)} · ${fmtTime(seconds)}`;
  if (showNewHint && watchedEp > 0 && content.episodeCount && content.episodeCount > watchedEp && finishedPart) {
    return `${base} · 新更 ${content.episodeCount - watchedEp} 集`;
  }
  return base;
}

export default function LibraryPage({onOpen,active=true}:{onOpen:(content:TvContent)=>void;active?:boolean}) {
  const {library,clearHistory}=useTv(),[tab,setTab]=useState("favorites"),[confirm,setConfirm]=useState(false),[error,setError]=useState("");
  const items=library.filter(item=>tab==="favorites"?item.favorite:!!item.progress).sort((a,b)=>(b.progress?.updatedAt||0)-(a.progress?.updatedAt||0));
  return <><header className="tv-page-heading"><h1>我的片库</h1></header>
    <div className="tv-tabs" data-tv-region="library-tabs"><button data-tv-focus="favorites" aria-pressed={tab==="favorites"} onClick={()=>setTab("favorites")}>本地收藏</button><button data-tv-focus="history" aria-pressed={tab==="history"} onClick={()=>setTab("history")}>观看历史与续播</button>{tab==="history"&&items.length>0&&<button data-tv-focus="clear-history" onClick={()=>setConfirm(true)}>清空历史</button>}</div>
    <div className="tv-grid" data-tv-region="library-grid" data-tv-columns="5">{items.map(item=><div key={item.key}><LibraryCard content={item.content} onOpen={onOpen} active={active}/>{item.progress&&<small>{formatLibraryProgress(item.content,item.progress.part,item.progress.seconds,item.progress.duration,tab==="favorites")}</small>}</div>)}</div>
    {!items.length&&<p className="tv-status">{tab==="favorites"?"还没有收藏，进入详情即可收藏作品。":"观看后会在这里保存进度。"}</p>}
    {confirm&&<TvModal id="clear-history" title="清空本机观看历史？" onClose={()=>setConfirm(false)}><p>收藏将保留，已迁移的旧历史不会重新导入。</p>{error&&<p role="alert">{error}</p>}<button data-tv-focus="confirm-clear-history" onClick={()=>void clearHistory().then(()=>setConfirm(false)).catch(e=>setError(String(e)))}>确认清空</button></TvModal>}
  </>;
}
