import { useEffect, useRef, useState } from "react";
import { api } from "../shared/api/api";
import type { TagGroup, TopicCard } from "../shared/api/types";
import { useContentPreferences } from "../shared/model/contentPreferences";
import { type TvContent, contentKey } from "./model";
import { videoCard, rankCard, postCard } from "./catalogCards";
import { qualifyVisiblePosts } from "./postEligibility";
import { indexMetadata } from "./search/catalog";
import { useTv } from "./TvProvider";
import { TvCard, TvStatus } from "./ui";
import { useRemoteScope } from "./remote";
const channels = [{id:"ai-duanju",label:"短剧"},{id:"ai-manju",label:"漫剧"},{id:"original",label:"原创"},{id:"rank",label:"排行"},{id:"topics",label:"专题"},{id:"tags",label:"标签"},{id:"posts",label:"吃瓜视频"}];
export default function BrowsePage({ onOpen, active=true }: { onOpen: (content: TvContent) => void; active?: boolean }) {
  const { source, sourceKey } = useTv(), preferences = useContentPreferences();
  const [channel,setChannel]=useState("ai-duanju"), [selection,setSelection]=useState(""), [items,setItems]=useState<TvContent[]>([]), [topics,setTopics]=useState<TopicCard[]>([]), [tags,setTags]=useState<TagGroup[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[retryable,setRetryable]=useState(0),[done,setDone]=useState(false);
  const route=`${sourceKey}:${channel}:${selection}:${preferences.revision}`;
  const [request,setRequest]=useState({route:"",page:1,retry:0});
  const routeRef=useRef(route); routeRef.current=route;
  const activeRef=useRef(active); activeRef.current=active;
  const fulfilled=useRef<typeof request | null>(null);
  const seq=useRef(0), prefsRef=useRef(preferences); prefsRef.current=preferences;
  const seenPages=useRef(new Map<number,string>()), candidates=useRef<TvContent[]>([]), nextPage=useRef(2);
  useEffect(()=>{
    setItems([]);setTopics([]);setTags([]);setError("");setDone(false);setRetryable(0);
    seenPages.current.clear();candidates.current=[];nextPage.current=2;
    setRequest({route,page:1,retry:0});
  },[route]);
  useEffect(()=>{
    // A route change renders once with the previous request. Only its reset
    // request may start I/O, so changing channel on page 4 never fetches page 4.
    if(request.route!==route || !source || !active)return;
    if(fulfilled.current===request){setBusy(false);return;}
    const token=++seq.current; let disposed=false;
    const current=()=>!disposed && token===seq.current && routeRef.current===route && activeRef.current;
    setBusy(true);setError("");setRetryable(0);
    void (async()=>{
      try {
        if(channel==="topics"&&!selection){const result=await api.topics();if(current()){setTopics(result.items);setDone(true);fulfilled.current=request;}return;}
        if(channel==="tags"&&!selection){const result=await api.tags();if(current()){setTags(result.categories);setDone(true);fulfilled.current=request;}return;}
        if(channel==="rank"){const result=await api.rank("hot");if(current()){const next=result.items.map(rankCard);setItems(next);setDone(true);fulfilled.current=request;void indexMetadata(source,next).catch(()=>{});}return;}
        let page=request.page, added:TvContent[]=[], pending:TvContent[]=[], retryCount=0, finished=false;
        const pages=new Map(seenPages.current);
        for(let extra=0;extra<3;extra++){
          const response=channel==="posts"?await api.posts(page,20,"latest"):channel==="original"?await api.originalVideos("all",page,20,"new"):channel==="topics"?(await api.topic(selection,page,20)).videos:channel==="tags"?await api.tagVideos(selection,page,20):await api.category(channel,page,20,"latest");
          if(!current())return;
          const paging=response.pagination;
          if(!paging || !Number.isSafeInteger(paging.page) || paging.page!==page || !Number.isSafeInteger(paging.pages) || paging.pages<0)throw new Error("目录分页未推进，请重试");
          const meta=channel==="posts"?(response.items as Parameters<typeof postCard>[0][]).map(postCard):(response.items as Parameters<typeof videoCard>[0][]).map(videoCard);
          const signature=meta.map(contentKey).sort().join(",");
          if(meta.length && [...pages].some(([previous,value])=>previous!==page&&value===signature))throw new Error("目录返回重复页，请重试");
          if(!meta.length && page<paging.pages)throw new Error("目录返回空页，请重试");
          if(paging.pages<page && !(page===1&&!meta.length&&paging.pages===0))throw new Error("目录分页发生变化，请重试");
          pages.set(page,signature); void indexMetadata(source,meta).catch(()=>{});
          let allowed=meta.filter(content=>!prefsRef.current.blockReason(content.tags));
          if(channel==="posts"){
            pending.push(...allowed);
            const result=await qualifyVisiblePosts(allowed,{source,isCurrent:current,allowed:content=>!prefsRef.current.blockReason(content.tags)},request.retry>0);
            if(!current())return; allowed=result.items;retryCount+=result.retryable;
          }
          added.push(...allowed); finished=page>=paging.pages;
          if(channel!=="posts"||added.length||finished||extra===2)break;
          page++;
        }
        if(current()){
          setItems(previous=>{const map=new Map((request.page===1?[]:previous).map(item=>[contentKey(item),item]));for(const item of added)map.set(contentKey(item),item);return [...map.values()];});
          setDone(finished);
          if(channel==="posts"){
            const addedKeys=new Set(added.map(contentKey));
            const mergedCandidates=[...new Map([...(request.page===1?[]:candidates.current),...pending].filter(c=>!addedKeys.has(contentKey(c))).map(c=>[contentKey(c),c])).values()];
            candidates.current=mergedCandidates;
            setRetryable(prev=>request.page===1?retryCount:prev+retryCount);
          }else{
            candidates.current=[];
            setRetryable(0);
          }
          seenPages.current=pages;nextPage.current=page+1;fulfilled.current=request;
        }
      }catch(e){if(current())setError(String(e));}finally{if(current())setBusy(false);}
    })(); return()=>{disposed=true;seq.current++;};
  },[request,route,source,channel,selection,active]);
  useRemoteScope({ id: "browse-subpage", priority: 10, onKey: key => { if (active && selection && key === "back") { setSelection(""); return true; } } });
  const retry=async()=>{
    if(busy)return;
    if(channel==="posts"&&retryable&&candidates.current.length){
      const token=++seq.current, key=route;setBusy(true);setError("");
      const current=()=>token===seq.current&&routeRef.current===key&&activeRef.current;
      try{const result=await qualifyVisiblePosts(candidates.current,{source,isCurrent:current,allowed:c=>!prefsRef.current.blockReason(c.tags)},true);
        if(current()){
          const resolvedKeys=new Set(result.items.map(contentKey));
          candidates.current=candidates.current.filter(c=>!resolvedKeys.has(contentKey(c)));
          setItems(prev=>[...new Map([...prev,...result.items].map(c=>[contentKey(c),c])).values()]);
          setRetryable(result.retryable);
        }}
      catch(e){if(current())setError(String(e));}
      finally{if(current())setBusy(false);}return;
    }
    setRequest(r=>({...r,retry:r.retry+1}));
  };
  return <><header className="tv-page-heading"><h1>浏览</h1></header>
    <div className="tv-tabs" data-tv-region="browse-channels">{channels.map(c=><button key={c.id} data-tv-focus={`channel-${c.id}`} aria-pressed={channel===c.id} onClick={()=>{setChannel(c.id);setSelection("");}}>{c.label}</button>)}</div>
    {selection&&<button data-tv-focus="browse-up" onClick={()=>setSelection("")}>返回{channel==="tags"?"标签":"专题"}</button>}
    <TvStatus busy={busy} error={error} onRetry={()=>void retry()}/>
    {topics.length>0&&<div className="tv-grid" data-tv-region="topics" data-tv-columns="5">{topics.map(topic=><button className="tv-collection" data-tv-focus={`topic-${topic.slug}`} key={topic.slug} onClick={()=>setSelection(topic.slug)}><strong>{topic.title}</strong><small>{topic.video_count||0} 部</small></button>)}</div>}
    {tags.map(group=><section key={group.name}><h2>{group.name}</h2><div className="tv-tags" data-tv-region={`tags-${group.name}`} data-tv-columns="5">{group.tags.filter(tag=>!preferences.isTagBlocked(tag.name)).map(tag=><button data-tv-focus={`tag-${tag.id}`} key={tag.id} onClick={()=>setSelection(tag.name)}>{tag.name}</button>)}</div></section>)}
    <div className={`tv-grid ${channel==="posts"?"tv-grid-wide":""}`} data-tv-region="browse-grid" data-tv-columns={channel==="posts"?3:5}>{items.filter(c=>!preferences.blockReason(c.tags)).map(content=><TvCard key={contentKey(content)} content={content} onOpen={onOpen}/>)}</div>
    {!busy&&retryable>0&&<p role="status">{retryable} 个候选暂未确认可播放。<button data-tv-focus="post-retry" onClick={()=>void retry()}>重试确认</button></p>}
    {!busy&&!done&&!error&&source&&<button data-tv-focus="browse-more" onClick={()=>setRequest(r=>({route,page:nextPage.current,retry:r.retry}))}>继续加载</button>}
    {!busy&&!error&&!items.length&&!topics.length&&!tags.length&&<p className="tv-status">当前页暂无可展示内容{done?"":"，可继续加载"}</p>}
  </>;
}
