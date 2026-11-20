import { clearHistory, hydrateLibraryContent, initializeLibrary, listLibrary, saveProgress, setFavorite } from "../src/tv/library";
import { contentKey, needsLibraryMetadata, type TvContent } from "../src/tv/model";

let passed=0;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`TV library: ${message}`);
  passed++;
}
async function rejects(task: () => Promise<unknown>, message: string) {
  let rejected = false;
  try { await task(); } catch { rejected = true; }
  assert(rejected, message);
}
async function migrationMarkers(): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open("hghubx-tv-library-v1",1);
    request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
  });
  try {
    return await new Promise<unknown[]>((resolve,reject)=>{
      const transaction=db.transaction("meta","readonly"), request=transaction.objectStore("meta").getAll();
      transaction.oncomplete=()=>resolve(request.result); transaction.onabort=()=>reject(transaction.error);
    });
  } finally { db.close(); }
}

/** Run only in the isolated browser profile supplied by the remote TV scenario. */
export async function runTvLibraryTests() {
  passed=0;
  const fixture=(window as unknown as {__tvFixture:{failAck?:boolean}}).__tvFixture;
  assert(fixture, "native IPC fixture is required");
  const identity={origin:"https://library.fixture.invalid",user_id:17};
  const guest={favs:[7,7],postFavs:[7],history:[
    {id:7,ep:3,t:42,dur:120,at:200}, {id:8,ep:1,t:9,dur:60,at:100},
  ]};
  const selected={favs:[7,8],postFavs:[9],history:[
    {id:7,ep:1,t:99,dur:150,at:100}, {id:8,ep:5,t:17,dur:80,at:300},
  ]};
  const accounts={version:1,accounts:{
    [JSON.stringify([identity.origin,identity.user_id])]:selected,
    [JSON.stringify([identity.origin,99])]:{favs:[999],history:[]},
    [JSON.stringify(["https://other.fixture.invalid",identity.user_id])]:{favs:[998],history:[]},
  }};
  const guestRaw=JSON.stringify(guest), accountRaw=JSON.stringify(accounts);
  localStorage.setItem("hghubx_app_v1",guestRaw);
  localStorage.setItem("hghubx_accounts_v1",accountRaw);
  localStorage.setItem("hghub_app_v1",JSON.stringify({favs:[997],history:[]}));

  // Simulate quota failure after the transaction queued its completion marker.
  // The library row callback aborts the entire transaction, including that marker.
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value: unknown,key?:IDBValidKey):IDBRequest<IDBValidKey>{
    if(this.name==="library")throw new DOMException("fixture quota exhausted","QuotaExceededError");
    return key===undefined ? put.call(this,value) : put.call(this,value,key);
  };
  try { await rejects(()=>initializeLibrary(identity),"quota failure must reject import"); }
  finally { IDBObjectStore.prototype.put=put; }
  assert((await listLibrary()).length===0,"failed transaction must contain no partial rows");
  assert((await migrationMarkers()).length===0,"failed transaction must contain no success marker");
  assert(localStorage.getItem("hghubx_app_v1")===guestRaw,"guest source must be untouched");
  assert(localStorage.getItem("hghubx_accounts_v1")===accountRaw,"account source must be untouched");

  // Native acknowledgement may fail after the atomic frontend commit.
  fixture.failAck=true;
  await rejects(()=>initializeLibrary(identity),"native acknowledgement failure must remain retryable");
  const rows=await listLibrary(), byKey=new Map(rows.map(row=>[row.key,row]));
  assert(rows.length===4,"only exact current account and preferred guest cache are imported");
  assert(byKey.has("video:7")&&byKey.has("post:7"),"same numeric video/post IDs remain distinct");
  assert(!byKey.has("video:999")&&!byKey.has("video:998")&&!byKey.has("video:997"),"unrelated accounts and stale guest fallback remain excluded");
  const seven=byKey.get("video:7")!, eight=byKey.get("video:8")!;
  assert(seven.progress?.part==="3"&&seven.progress.seconds===42&&seven.progress.duration===120&&seven.progress.updatedAt===200,"newer guest progress must be selected as a whole row");
  assert(eight.progress?.part==="5"&&eight.progress.seconds===17&&eight.progress.duration===80&&eight.progress.updatedAt===300,"newer account progress must be selected as a whole row");
  assert((await migrationMarkers()).length===1,"committed import needs one durable marker");

  await setFavorite(seven.content,false);
  await clearHistory();
  fixture.failAck=false;
  await initializeLibrary(identity);
  const afterRetry=await listLibrary();
  assert(!afterRetry.some(row=>row.key==="video:7"),"ack retry must not restore a removed favorite");
  assert(afterRetry.every(row=>!row.progress),"ack retry must not restore cleared history");

  const post:TvContent & {video_url:string}={kind:"post",id:7,title:"Mixed 123",cover:"",tags:[],hot:1,video_url:"https://temporary.fixture.invalid/expired.m3u8"};
  const progress={key:contentKey(post),content:post,part:"4",seconds:12,duration:90,updatedAt:400};
  await saveProgress(post,progress);
  await saveProgress(post,{...progress,part:"2",seconds:4,updatedAt:399});
  const saved=(await listLibrary()).find(row=>row.key==="post:7")!;
  assert(saved.progress?.part==="4"&&saved.progress.seconds===12,"stale playback writes must not replace newer segment progress");
  assert(!JSON.stringify(saved).includes("temporary.fixture.invalid"),"temporary playback URLs must never reach persistent metadata");
  await rejects(()=>saveProgress(post,{...progress,key:"video:7"}),"cross-kind progress identity must reject");
  assert(localStorage.getItem("hghubx_app_v1")===guestRaw&&localStorage.getItem("hghubx_accounts_v1")===accountRaw,"migration and edits retain original legacy data");
  // Metadata fills are separate from migration, and never write favorite/progress
  // fields from the stale snapshot that originally scheduled the request.
  const missing: TvContent = { kind:"video", id:20, title:"影片 20", cover:"", tags:[], hot:0, metadataState:"missing" };
  const filled: TvContent = { ...missing, title:"自动补全的作品", cover:"https://cover.fixture.invalid/20", tags:["剧情"], hot:18, metadataState:"ready" };
  const legacyPlaceholder: TvContent = { kind:"video", id:21, title:"影片 21", cover:"", tags:[], hot:0 };
  assert(needsLibraryMetadata(legacyPlaceholder), "already-migrated placeholders without a marker need enrichment");
  assert(!needsLibraryMetadata({...legacyPlaceholder, metadataState:"ready"}), "explicitly resolved titles resembling a placeholder stay resolved");
  await setFavorite(missing,true);
  await saveProgress(missing,{key:"video:20",content:missing,part:"3",seconds:44,duration:120,updatedAt:500});
  assert(await hydrateLibraryContent(filled,()=>true), "active unresolved library item must accept metadata");
  const hydrated=(await listLibrary()).find(row=>row.key==="video:20")!;
  assert(hydrated.favorite && hydrated.content.title===filled.title && hydrated.content.cover===filled.cover, "metadata fills preserve collection state");
  assert(hydrated.progress?.part==="3"&&hydrated.progress.seconds===44&&hydrated.progress.duration===120&&hydrated.progress.updatedAt===500,
    "metadata fills preserve the entire progress row");
  assert(hydrated.progress.content.title===filled.title, "progress metadata refreshes alongside card metadata");
  assert(!await hydrateLibraryContent({...filled,title:"旧请求的晚到信息"},()=>true), "late enrichment cannot replace metadata already resolved elsewhere");
  assert((await listLibrary()).find(row=>row.key==="video:20")?.content.title===filled.title, "newer metadata survives late response");

  await setFavorite(legacyPlaceholder,true);
  let current=true;
  const stale=hydrateLibraryContent({...legacyPlaceholder,title:"过期来源",metadataState:"ready"},()=>current);
  current=false;
  assert(!await stale, "source or preference invalidation cancels a pending metadata write");
  assert(needsLibraryMetadata((await listLibrary()).find(row=>row.key==="video:21")!.content), "invalidated write leaves unresolved metadata for a future retry");
  await setFavorite(legacyPlaceholder,false);
  assert(!await hydrateLibraryContent({...legacyPlaceholder,title:"已取消收藏",metadataState:"ready"},()=>true), "cancelled favorite must not be resurrected by hydration");

  const historyOnly:TvContent={kind:"video",id:22,title:"影片 22",cover:"",tags:[],hot:0,metadataState:"missing"};
  await saveProgress(historyOnly,{key:"video:22",content:historyOnly,part:"2",seconds:8,duration:60,updatedAt:600});
  let release!:()=>void;
  const deferred=new Promise<void>(resolve=>{release=resolve;}).then(()=>hydrateLibraryContent({...historyOnly,title:"晚到的详情",metadataState:"ready"},()=>true));
  await clearHistory(); release();
  assert(!await deferred, "cleared history must not be reinserted when detail arrives later");
  assert(!(await listLibrary()).some(row=>row.key==="video:22"||row.key==="video:21"), "removed records stay removed after late metadata");
  return {passed,scenarios:["atomic-quota-rollback","exact-account-selection","kind-id-isolation","whole-row-newest-history","ack-retry-idempotence","clear-history-marker","segment-progress","url-exclusion","metadata-hydration","preserve-progress-favorites","late-hydration-invalidation","no-deletion-resurrection"]};
}
