/** One identity vocabulary for routes, focus, library and catalog metadata. */
export type ContentRef = { kind: "video" | "post"; id: number };
export type TvContent = ContentRef & {
  title: string;
  cover: string;
  tags: string[];
  hot: number;
  score?: number;
  description?: string;
  episodeCount?: number;
  /** Missing marks imported identity-only records; ready also permits absent covers. */
  metadataState?: "missing" | "ready";
};
export const contentKey = (content: ContentRef): string => `${content.kind}:${content.id}`;

export function needsLibraryMetadata(content: TvContent): boolean {
  if (content.metadataState) return content.metadataState === "missing";
  // Recognize placeholders already imported by the first TV redesign build.
  return !content.cover && !content.tags.length &&
    content.title === `${content.kind === "video" ? "影片" : "视频"} ${content.id}`;
}

/** part is the episode number or the stable playback segment index as a string. */
export type TvProgress = {
  key: string;
  content: TvContent;
  part: string;
  seconds: number;
  duration: number;
  updatedAt: number;
};
export type TvLibraryEntry = { key: string; content: TvContent; favorite: boolean; progress?: TvProgress };
export type PendingMigrationIdentity = { origin: string; user_id: number };

/** Explicit allowlist prevents temporary playback URLs leaking into IndexedDB. */
export function metadataOnly(content: TvContent): TvContent {
  if ((content.kind !== "video" && content.kind !== "post") || !Number.isSafeInteger(content.id) || content.id <= 0) {
    throw new Error("内容身份无效");
  }
  return {
    kind: content.kind, id: content.id,
    title: typeof content.title === "string" ? content.title : "",
    cover: typeof content.cover === "string" ? content.cover : "",
    tags: Array.isArray(content.tags) ? content.tags.filter((tag): tag is string => typeof tag === "string") : [],
    hot: Number.isFinite(content.hot) ? content.hot : 0,
    ...(Number.isFinite(content.score) ? { score: content.score } : {}),
    ...(typeof content.description === "string" ? { description: content.description } : {}),
    ...(Number.isSafeInteger(content.episodeCount) ? { episodeCount: content.episodeCount } : {}),
    ...(content.metadataState === "missing" || content.metadataState === "ready" ? { metadataState: content.metadataState } : {}),
  };
}
