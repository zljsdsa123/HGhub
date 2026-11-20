import { api } from "../shared/api/api";
import type { TvContent } from "./model";

export type PostEligibility =
  | { status: "playable"; segments: number[] }
  | { status: "retryable"; message: string }
  | { status: "discarded" };
export type EligibilityContext = {
  source: string;
  isCurrent: () => boolean;
  allowed: (content: TvContent) => boolean;
};
// The queue spans all TV surfaces. Old requests finish before new slots open.
let active = 0, epoch = 0;
const queue: (() => void)[] = [];
const cache = new Map<string, { until: number; value: PostEligibility }>();
function invalidate() { epoch++; cache.clear(); }
window.addEventListener("hg:line-changed", invalidate);
window.addEventListener("hg:proxy-changed", invalidate);
function schedule<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      active++;
      void task().then(resolve, reject).finally(() => { active--; pump(); });
    });
    pump();
  });
}
function pump() { while (active < 2 && queue.length) queue.shift()!(); }

/** Only current visible/search-page candidates call this. It never fetches media. */
export function inspectPost(content: TvContent, context: EligibilityContext, retry = false): Promise<PostEligibility> {
  const token = epoch;
  const current = () => token === epoch && context.isCurrent() && context.allowed(content);
  if (content.kind !== "post" || !current()) return Promise.resolve({ status: "discarded" });
  const key = `${context.source}|post:${content.id}`;
  const known = cache.get(key);
  if (!retry && known && known.until > Date.now()) return Promise.resolve(known.value);
  return schedule<PostEligibility>(async () => {
    if (!current()) return { status: "discarded" };
    try {
      const parsed = await api.postPlayback(content.id);
      if (!current()) return { status: "discarded" };
      const segments = (parsed.videos || []).filter(video => Number.isInteger(video.index) && !!video.url?.trim()).map(video => video.index);
      const value: PostEligibility = segments.length
        ? { status: "playable", segments }
        : { status: "retryable", message: "暂未确认可播放，可重试" };
      // Deliberately retain no URL, response object or negative permanent verdict.
      cache.set(key, { until: Date.now() + (segments.length ? 5 * 60_000 : 15_000), value });
      return value;
    } catch (error) {
      if (!current()) return { status: "discarded" };
      const value: PostEligibility = { status: "retryable", message: error instanceof Error ? error.message : String(error) };
      cache.set(key, { until: Date.now() + 15_000, value });
      return value;
    }
  });
}

export async function qualifyVisiblePosts(contents: TvContent[], context: EligibilityContext, retry = false) {
  const results = await Promise.all(contents.filter(content => content.kind === "post" && context.allowed(content)).map(async content => ({
    content, result: await inspectPost(content, context, retry),
  })));
  return {
    items: results.filter(item => item.result.status === "playable").map(item => item.content),
    retryable: results.filter(item => item.result.status === "retryable").length,
  };
}
