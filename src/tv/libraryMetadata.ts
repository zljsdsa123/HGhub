import { api } from "../shared/api/api";
import { hydrateLibraryContent } from "./library";
import { contentKey, type TvContent } from "./model";
import { detailContent } from "./player/content";
import { indexMetadata } from "./search/catalog";

// Shared by the history shelf and library grid. In-flight work holds its slot
// until completion, including after a route/source change.
let active = 0, generation = 0;
const queue: (() => void)[] = [];
type MetadataJob = { promise: Promise<void>; currents: Set<() => boolean> };
const inFlight = new Map<string, MetadataJob>();
window.addEventListener("hg:line-changed", () => { generation++; });
window.addEventListener("hg:proxy-changed", () => { generation++; });
function pump() { while (active < 2 && queue.length) queue.shift()!(); }

export function loadLibraryMetadata(content: TvContent, source: string, isCurrent: () => boolean): Promise<void> {
  const token = generation;
  const requestKey = `${contentKey(content)}:${source}:${token}`;
  const existing = inFlight.get(requestKey);
  if (existing) { existing.currents.add(isCurrent); return existing.promise; }
  const job: MetadataJob = { promise: Promise.resolve(), currents: new Set([isCurrent]) };
  const current = () => token === generation && !document.hidden && [...job.currents].some(test => test());
  job.promise = new Promise<void>((resolve, reject) => {
    queue.push(() => {
      active++;
      void (async () => {
        if (!current()) return;
        const value = content.kind === "video" ? await api.video(content.id) : await api.post(content.id);
        if (!current()) return;
        if (value.id !== content.id || !value.title?.trim()) throw new Error("影片信息暂未加载，请重试");
        const metadata = detailContent(content, value);
        const saved = await hydrateLibraryContent(metadata, current);
        if (saved && current()) void indexMetadata(source, [metadata]).catch(() => {});
      })().then(resolve, reject).finally(() => { active--; pump(); });
    });
  });
  const settle = () => { job.currents.clear(); if (inFlight.get(requestKey) === job) inFlight.delete(requestKey); };
  job.promise.then(settle, settle);
  inFlight.set(requestKey, job);
  pump();
  return job.promise;
}
