import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IHome, IGrid, ISearch, IStar, ISettings, Logo } from "../shared/ui/icons";
import { useContentPreferences } from "../shared/model/contentPreferences";
import { contentKey, type TvContent } from "./model";
import { useTv } from "./TvProvider";
import { rememberFocus, restoreFocus, useRemoteScope } from "./remote";
import { indexMetadata, setCatalogPaused } from "./search/catalog";
import { saveContent } from "./library";
import { setPlaybackPreferences, usePlaybackPreferences } from "./preferences";
import HomePage from "./HomePage";
import BrowsePage from "./BrowsePage";
import SearchPage from "./SearchPage";
import LibraryPage from "./LibraryPage";
import SettingsPage from "./SettingsPage";
import DetailPage from "./DetailPage";
import PlayerPage from "./PlayerPage";
import { TvStatus } from "./ui";
type Tab = "home"|"browse"|"search"|"library"|"settings";
type Route = {kind:"detail";content:TvContent}|{kind:"player";content:TvContent;part:string;seconds:number};
const nav = [{id:"home",label:"首页",Icon:IHome},{id:"browse",label:"浏览",Icon:IGrid},{id:"search",label:"搜索",Icon:ISearch},{id:"library",label:"片库",Icon:IStar},{id:"settings",label:"设置",Icon:ISettings}] as const;
export default function TvApp(){
  const tv=useTv(),prefs=useContentPreferences(),playback=usePlaybackPreferences();
  const [tab,setTab]=useState<Tab>("home"),[visited,setVisited]=useState<Tab[]>(["home"]),[stack,setStack]=useState<Route[]>([]);
  const current=stack[stack.length-1],playing=current?.kind==="player";
  const page=current?`${current.kind}:${contentKey(current.content)}`:tab;
  useEffect(()=>{setCatalogPaused(playing);return()=>setCatalogPaused(false);},[playing]);
  useEffect(()=>{
    if(!tv.ready)return;
    // Clear a restored WebView scroll so the first page opens on its heading.
    const reset=()=>document.querySelectorAll<HTMLElement>(".tv-page-scroll").forEach(element=>{element.scrollTop=0;element.scrollLeft=0;});
    reset();const frame=requestAnimationFrame(reset);return()=>cancelAnimationFrame(frame);
  },[tv.ready]);
  useEffect(()=>{restoreFocus(page);},[page,tv.ready]);
  const back=()=>{
    rememberFocus(page);
    if(stack.length){setStack(s=>s.slice(0,-1));return;}
    if(tab!=="home"){setTab("home");return;}
    void invoke("plugin:app|exit",{code:0});
  };
  useRemoteScope({id:"app",priority:0,onKey:key=>{if(key==="back"){back();return true;}}});
  const open=(content:TvContent)=>{rememberFocus(page);setStack(s=>[...s,{kind:"detail",content}]);};
  const navigate=(next:Tab)=>{rememberFocus(page);setTab(next);setVisited(v=>v.includes(next)?v:[...v,next]);setStack([]);};
  const metadata=(content:TvContent)=>{void indexMetadata(tv.source,[content]).catch(()=>{});void saveContent(content).catch(()=>{});};
  const entry=current?tv.library.find(item=>item.key===contentKey(current.content)):undefined;
  if(!tv.ready)return <main className="tv-boot-status"><h1>正在准备本地片库</h1><TvStatus busy={!tv.error} error={tv.error} onRetry={tv.retry}/></main>;
  return <div className="tv-app">
    {!playing&&<nav className="tv-sidebar" aria-label="主导航" data-tv-region="navigation" data-tv-columns="1"><div className="tv-brand"><Logo size={32}/><span>HGhubX <small>TV</small></span></div>{nav.map(({id,label,Icon})=><button key={id} data-tv-focus={`nav-${id}`} className={id==="settings"?"tv-nav-settings":""} aria-label={label} aria-current={!current&&tab===id?"page":undefined} onClick={()=>navigate(id)}><Icon size={26}/><span>{label}</span></button>)}</nav>}
    <main className="tv-main-area" hidden={!!current}>
      {visited.map(name=><div key={name} hidden={tab!==name} className="tv-page-scroll" data-tv-scroll-id={`page-${name}`}>
        {name==="home"&&<HomePage active={tab==="home"&&!current} onOpen={open}/>}{name==="browse"&&<BrowsePage active={tab==="browse"&&!current} onOpen={open}/>}{name==="search"&&<SearchPage key={tv.sourceKey} source={tv.source} paused={playing||tab!=="search"||!!current} onOpen={open}/>}{name==="library"&&<LibraryPage active={tab==="library"&&!current} onOpen={open}/>}{name==="settings"&&<SettingsPage/>}
      </div>)}
    </main>
    {current?.kind==="detail"&&<div className="tv-detail-route" data-tv-scroll-id={page}><DetailPage key={contentKey(current.content)} content={current.content} sourceKey={tv.sourceKey} progress={entry?.progress} favorite={!!entry?.favorite} onFavorite={tv.toggleFavorite} onBack={back} onMetadata={metadata} onPlay={(content,part,seconds=0)=>{rememberFocus(page);setStack(s=>[...s,{kind:"player",content,part,seconds}]);}}/></div>}
    {current?.kind==="player"&&<PlayerPage key={contentKey(current.content)} content={current.content} sourceKey={tv.sourceKey} part={current.part} resumeSeconds={current.seconds} favorite={!!entry?.favorite} rate={playback.rate} quality={playback.quality} autoNext={playback.autoplayNext} onPreferencesChange={setPlaybackPreferences} onFavorite={tv.toggleFavorite} onProgress={tv.progress} onMetadata={metadata} onBack={back}/>}
    {(tv.error||prefs.storageError)&&<div className="tv-notice" role="alert">{tv.error||prefs.storageError}</div>}
  </div>;
}
