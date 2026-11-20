import type { Post, RankItem, VideoCard } from "../shared/api/types";
import type { TvContent } from "./model";
export function videoCard(value: VideoCard): TvContent { return { kind: "video", id: value.id, title: value.title, cover: value.cover, tags: value.tags || [], hot: value.hot || 0, score: value.score, description: value.description, episodeCount: value.episode_count }; }
export function rankCard(value: RankItem): TvContent { return { kind: "video", id: value.video_id, title: value.title, cover: value.cover, tags: value.tags || [], hot: value.metric_value || 0, score: value.score, episodeCount: value.episode_count }; }
export function postCard(value: Post): TvContent { return { kind: "post", id: value.id, title: value.title, cover: value.cover, tags: value.tags || [], hot: value.hot || 0, description: value.desc }; }
