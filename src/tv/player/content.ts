import type { Detail, PlayInfo, Post } from "../../shared/api/types";
import type { TvContent } from "../model";

export type TvPart = { id: string; label: string; duration?: number };
export type TvStreams = { main: string; hevc?: string };

export function detailContent(base: TvContent, value: Detail | Post): TvContent {
  return {
    kind: base.kind, id: base.id, title: value.title || base.title, metadataState: "ready",
    cover: value.cover || base.cover, tags: Array.isArray(value.tags) ? value.tags : [],
    description: base.kind === "video" ? (value as Detail).description : (value as Post).desc,
    hot: base.kind === "video" ? (value as Detail).counts?.hot ?? base.hot : (value as Post).hot ?? (value as Post).counts?.hot ?? base.hot,
    ...(base.kind === "video" ? { score: (value as Detail).score, episodeCount: (value as Detail).episode_count } : {}),
  };
}

export function videoParts(value: Detail): TvPart[] {
  const seen = new Set<string>();
  const episodes = value.episodes?.length ? value.episodes : Array.from({ length: Number.isSafeInteger(value.episode_count) ? Math.min(10000, Math.max(0, value.episode_count)) : 0 }, (_, index) => ({ ep_num: index + 1, title: "", duration: 0, status: 1 }));
  return episodes.filter(episode => {
    const id = String(episode.ep_num);
    if (!Number.isInteger(episode.ep_num) || episode.ep_num < 1 || seen.has(id)) return false;
    seen.add(id); return true;
  }).sort((a, b) => a.ep_num - b.ep_num).map(episode => {
    const title = episode.title?.trim() || "";
    const hasEpisodePrefix = new RegExp(`^第\\s*${episode.ep_num}\\s*集(?:$|[\\s·:：-])`).test(title);
    const label = hasEpisodePrefix ? title : title ? `第 ${episode.ep_num} 集 · ${title}` : `第 ${episode.ep_num} 集`;
    return { id: String(episode.ep_num), label, duration: episode.duration };
  });
}

export function postParts(videos: { index: number; url: string }[] = []): TvPart[] {
  const seen = new Set<string>();
  return videos.filter(video => {
    const id = String(video.index);
    if (!Number.isInteger(video.index) || !video.url?.trim() || seen.has(id)) return false;
    seen.add(id); return true;
  }).map((video, position) => ({ id: String(video.index), label: `视频分段 ${position + 1}` }));
}

export function playStreams(info: PlayInfo, expectedId: number, expectedPart: string): TvStreams {
  // The current endpoint returns `{ id: "903", ep: 1 }`; the legacy fallback
  // returns numeric `id` and `ep_num`. Normalize both before identity checks.
  const returnedPart = info.ep ?? info.ep_num;
  if (info.id == null || returnedPart == null
      || String(info.id).trim() !== String(expectedId)
      || String(returnedPart).trim() !== expectedPart.trim()) {
    throw new Error("播放信息已变化，请重试当前剧集");
  }
  const main = info.streams?.main || info.video_url;
  const hevc = info.streams?.hevc || info.video_url_hevc;
  if (!main && !hevc) throw new Error("当前剧集暂无可用播放地址，请重试");
  return { main: main || hevc!, hevc: hevc || undefined };
}

export function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
}
