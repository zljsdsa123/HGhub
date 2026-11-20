import { useSyncExternalStore } from "react";
import { api } from "../../shared/api/api";
import type { Post, VideoCard } from "../../shared/api/types";
import type { TvContent } from "../model";
import type { CatalogCheckpoint, CatalogQuery, CatalogStatus, SearchPreferences, WorkerCommand, WorkerResponse } from "./protocol";
import CatalogWorker from "./index.worker?worker";

const DAY = 24 * 60 * 60 * 1000;
const statuses = new Map<string, CatalogStatus>();
const listeners = new Set<() => void>();
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let worker: Worker | undefined, requestId = 0, source = "", generation = 0;
let paused = false, running = false, initialized = false, timer: ReturnType<typeof setTimeout> | undefined;
let lastInteraction = Date.now();
const empty = (origin: string): CatalogStatus => ({ source: origin, channels: [], count: 0, complete: false, updatedAt: 0,
  startedAt: 0, error: "", syncing: false, paused, initialized: false });
function snapshot(origin: string) {
  if (!statuses.has(origin)) statuses.set(origin, empty(origin));
  return statuses.get(origin)!;
}
function publish(origin: string, next: Partial<CatalogStatus>) {
  statuses.set(origin, { ...snapshot(origin), ...next }); listeners.forEach(listener => listener());
}
function getWorker() {
  if (worker) return worker;
  worker = new CatalogWorker();
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const promise = pending.get(event.data.requestId);
    if (!promise) return;
    pending.delete(event.data.requestId);
    if (event.data.error) promise.reject(new Error(event.data.error)); else promise.resolve(event.data.value);
  };
  worker.onerror = () => {
    for (const promise of pending.values()) promise.reject(new Error("搜索索引暂时不可用，请重试"));
    pending.clear(); worker?.terminate(); worker = undefined;
  };
  worker.postMessage({ type: "activate", source, generation, requestId: 0 });
  return worker;
}
function request<T>(command: WorkerCommand): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    try {
      const target = getWorker();
      pending.set(id, { resolve: value => resolve(value as T), reject });
      target.postMessage({ ...command, requestId: id });
    } catch (error) { pending.delete(id); reject(error); }
  });
}
function activate(origin: string) {
  source = origin; generation++;
  if (worker) void request({ type: "activate", source, generation }).catch(() => {});
}
function checkpoint(origin: string): CatalogCheckpoint {
  const value = snapshot(origin);
  return { source: origin, channels: value.channels, count: value.count, complete: value.complete,
    updatedAt: value.updatedAt, startedAt: value.startedAt, error: value.error };
}
function fresh(origin: string): CatalogCheckpoint {
  return { source: origin, channels: [
    { key: "videos", kind: "video", nextPage: 1, pages: null, signatures: [], seenIds: [], complete: false },
    { key: "posts", kind: "post", nextPage: 1, pages: null, signatures: [], seenIds: [], complete: false },
  ], count: snapshot(origin).count, complete: false, updatedAt: snapshot(origin).updatedAt, startedAt: Date.now(), error: "" };
}
function schedule(delay = 1200) {
  clearTimeout(timer);
  if (!initialized) return;
  timer = setTimeout(() => { void sync(); }, delay);
}
const canRun = () => !!source && initialized && !paused && document.visibilityState !== "hidden";
function stale(token: number, origin: string) { return token !== generation || origin !== source; }

/** The provider calls this on boot and on every source/proxy generation change. */
export function setCatalogSource(origin: string) {
  if (source !== origin) {
    if (source) publish(source, { syncing: false });
    activate(origin);
    if (initialized && origin) void loadStatus(origin, generation);
  }
}
/** An in-flight page may finish, but no new page is requested while playing. */
export function setCatalogPaused(value: boolean) {
  paused = value;
  if (source) publish(source, { paused: value || document.visibilityState === "hidden" });
  if (!value) schedule();
}
async function loadStatus(origin: string, token: number) {
  try {
    await request({ type: "activate", source: origin, generation: token });
    const saved = await request<CatalogCheckpoint | undefined>({ type: "status", source: origin });
    if (stale(token, origin)) return;
    publish(origin, { ...(saved || fresh(origin)), initialized: true, syncing: false, paused });
    schedule();
  } catch (error) {
    if (!stale(token, origin)) publish(origin, { initialized: true, syncing: false, error: message(error) });
  }
}
function installLifecycle() {
  const activity = () => { lastInteraction = Date.now(); };
  document.addEventListener("focusin", activity);
  document.addEventListener("pointerdown", activity, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (source) publish(source, { paused: paused || document.visibilityState === "hidden" });
    if (document.visibilityState !== "hidden") schedule();
  });
  const invalidate = () => {
    const previous = source;
    activate(""); // Re-enable only after the provider has read the new actual origin.
    if (previous) publish(previous, { syncing: false });
  };
  window.addEventListener("hg:line-changed", invalidate);
  window.addEventListener("hg:proxy-changed", invalidate);
}
/** First search entry opts this installation into catalog synchronization. */
export function startCatalog(origin: string) {
  if (!origin) return;
  if (!initialized) {
    initialized = true; installLifecycle(); activate(origin);
    void loadStatus(origin, generation);
  } else if (source !== origin) setCatalogSource(origin);
  else schedule();
}
export function useCatalogStatus(origin: string) {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot(origin));
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function videoMetadata(video: VideoCard): TvContent {
  return { kind: "video", id: video.id, title: video.title, cover: video.cover, tags: video.tags || [], hot: video.hot || 0,
    score: video.score, description: video.description, episodeCount: video.episode_count };
}
function postMetadata(post: Post): TvContent {
  return { kind: "post", id: post.id, title: post.title, cover: post.cover, tags: post.tags || [], hot: post.hot ?? post.counts?.hot ?? 0, description: post.desc };
}
async function sync() {
  if (running || !canRun()) return;
  const origin = source, token = generation;
  const current = snapshot(origin);
  if (!current.initialized || current.error) return;
  if (current.complete && Date.now() - current.updatedAt < DAY) { schedule(60_000); return; }
  if (current.complete && Date.now() - lastInteraction < 30_000) { schedule(5000); return; }
  let next = current.complete ? fresh(origin) : checkpoint(origin);
  if (!next.channels.length) next = fresh(origin);
  running = true;
  publish(origin, { ...next, syncing: true, paused: false });
  try {
    const channelIndex = next.channels.findIndex(channel => !channel.complete);
    const channel = next.channels[channelIndex];
    if (!channel) { schedule(60_000); return; }
    const page = channel.nextPage;
    // There is one global runner, including source switches: never overlap pages.
    const response = channel.kind === "video" ? await api.feed(page, 50) : await api.posts(page, 50, "latest");
    if (stale(token, origin)) return;
    const paging = response.pagination;
    if (!paging || !Number.isFinite(paging.page) || paging.page !== page || !Number.isFinite(paging.pages)) {
      throw new Error("目录分页没有推进，已停止本次同步。请重试");
    }
    const items = channel.kind === "video" ? (response.items as VideoCard[]).map(videoMetadata) : (response.items as Post[]).map(postMetadata);
    const signature = items.map(item => item.id).sort((a, b) => a - b).join(",");
    const seen = new Set(channel.seenIds);
    const newIds = items.filter(item => !seen.has(item.id)).map(item => item.id);
    if (items.length && (channel.signatures.includes(signature) || !newIds.length)) throw new Error("上游返回了重复目录页，已停止本次同步。请重试");
    if (!items.length && page < paging.pages) throw new Error("目录页为空但仍有后续分页，已停止本次同步。请重试");
    if (paging.pages < page && !(page === 1 && !items.length && paging.pages === 0)) throw new Error("目录分页发生变化，已停止本次同步。请重试");
    const complete = page >= paging.pages;
    next = { ...next, channels: next.channels.map((value, index) => index === channelIndex ? {
      ...value, nextPage: page + 1, pages: paging.pages, signatures: [...value.signatures, signature],
      seenIds: [...value.seenIds, ...newIds], complete,
    } : value), error: "" };
    next.complete = next.channels.every(value => value.complete);
    if (next.complete) next.updatedAt = Date.now();
    const saved = await request<CatalogCheckpoint>({ type: "save", source: origin, generation: token, checkpoint: next, items });
    if (!stale(token, origin)) publish(origin, { ...saved, syncing: false });
  } catch (error) {
    if (!stale(token, origin)) {
      const failed = { ...checkpoint(origin), complete: false, error: message(error) };
      publish(origin, { ...failed, syncing: false });
      try { await request({ type: "save", source: origin, generation: token, checkpoint: failed, items: [] }); } catch { /* The visible error remains. */ }
    }
  } finally {
    running = false;
    if (!stale(token, origin)) publish(origin, { syncing: false });
    schedule();
  }
}
export async function retryCatalog(origin: string, restart = false) {
  if (!origin) return;
  // Retrying invalidates a page still in flight, including same-origin refreshes.
  activate(origin);
  const token = generation;
  const next = restart ? fresh(origin) : { ...checkpoint(origin), error: "" };
  if (!next.channels.length) Object.assign(next, fresh(origin));
  try {
    await request({ type: "activate", source: origin, generation: token });
    const saved = await request<CatalogCheckpoint>({ type: "save", source: origin, generation: token, checkpoint: next, items: [] });
    if (stale(token, origin)) return;
    publish(origin, { ...saved, initialized: true, syncing: false }); schedule(0);
  } catch (error) { if (!stale(token, origin)) publish(origin, { error: message(error), syncing: false }); }
}
/** Browsing/details supplement metadata without starting directory downloads. */
export async function indexMetadata(origin: string, items: TvContent[]) {
  if (!origin || !items.length || source !== origin) return;
  const token = generation;
  try {
    if (!worker) await request({ type: "activate", source: origin, generation: token });
    const saved = await request<Partial<CatalogCheckpoint>>({ type: "metadata", source: origin, generation: token, items });
    if (!stale(token, origin) && saved.count !== undefined) publish(origin, { count: saved.count });
  } catch (error) { if (!stale(token, origin)) publish(origin, { error: message(error) }); }
}
export function queryCatalog(origin: string, query: string, offset: number, preferences: SearchPreferences) {
  if (!origin) return Promise.resolve<CatalogQuery>({ items: [], total: 0, nextOffset: 0, hasMore: false });
  return request<CatalogQuery>({ type: "query", source: origin, query, offset, limit: 20, preferences });
}
