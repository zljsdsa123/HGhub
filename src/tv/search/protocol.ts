import type { TvContent } from "../model";

export type CatalogChannel = {
  key: string;
  kind: "video" | "post";
  route?: string;
  nextPage: number;
  pages: number | null;
  signatures: string[];
  seenIds: number[];
  complete: boolean;
};
export type CatalogCheckpoint = {
  source: string;
  channels: CatalogChannel[];
  count: number;
  complete: boolean;
  updatedAt: number;
  startedAt: number;
  error: string;
};
export type CatalogStatus = CatalogCheckpoint & { syncing: boolean; paused: boolean; initialized: boolean };
export type SearchPreferences = { blockedTags: string[]; hideUntagged: boolean; paused: boolean };
export type CatalogQuery = { items: TvContent[]; total: number; nextOffset: number; hasMore: boolean };
export type WorkerCommand =
  | { type: "activate"; source: string; generation: number }
  | { type: "status"; source: string }
  | { type: "save"; source: string; generation: number; checkpoint: CatalogCheckpoint; items: TvContent[] }
  | { type: "metadata"; source: string; generation: number; items: TvContent[] }
  | { type: "query"; source: string; query: string; offset: number; limit: number; preferences: SearchPreferences };
export type WorkerRequest = WorkerCommand & { requestId: number };
export type WorkerResponse = { requestId: number; value?: unknown; error?: string };
