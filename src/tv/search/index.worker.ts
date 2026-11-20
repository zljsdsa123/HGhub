import { pinyin } from "pinyin-pro";
import type { TvContent } from "../model";
import type { CatalogCheckpoint, CatalogQuery, SearchPreferences, WorkerRequest, WorkerResponse } from "./protocol";

// This module is reachable only through the TV edition's worker entry.
type IndexedContent = { source: string; key: string; initials: string; content: TvContent };
const scope = self as unknown as { onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null; postMessage: (value: WorkerResponse) => void };
let database: Promise<IDBDatabase> | undefined;
let activeSource = "", activeGeneration = 0;
const writes = new Set<IDBTransaction>();
const normalize = (text: string) => text.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
const normalizedTag = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

function openDatabase() {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("hghubx-tv-catalog-v1", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const content = db.createObjectStore("content", { keyPath: ["source", "key"] });
      content.createIndex("source", "source", { unique: false });
      db.createObjectStore("checkpoints", { keyPath: "source" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => { database = undefined; reject(request.error || new Error("目录存储打开失败")); };
    request.onblocked = () => { database = undefined; reject(new Error("目录存储正在升级，请重新打开应用")); };
  });
  return database;
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => { writes.delete(transaction); resolve(); };
    transaction.onabort = transaction.onerror = () => { writes.delete(transaction); reject(transaction.error || new Error("目录保存已取消")); };
  });
}
function metadata(value: TvContent): TvContent {
  // Explicit allowlist: playback URLs and post article bodies never reach storage.
  return { kind: value.kind, id: value.id, title: value.title, cover: value.cover || "", tags: [...(value.tags || [])],
    hot: Number.isFinite(value.hot) ? value.hot : 0, score: value.score, description: value.description, episodeCount: value.episodeCount };
}
function indexed(source: string, value: TvContent): IndexedContent {
  const content = metadata(value);
  return { source, key: `${content.kind}:${content.id}`, content,
    initials: normalize(pinyin(content.title, { pattern: "first", toneType: "none", type: "array", nonZh: "consecutive" }).join("")) };
}
function allowed(content: TvContent, preferences: SearchPreferences) {
  if (preferences.paused) return true;
  const tags = content.tags.map(normalizedTag).filter(Boolean);
  if (!tags.length && preferences.hideUntagged) return false;
  const blocked = new Set(preferences.blockedTags.map(normalizedTag));
  return !tags.some(tag => blocked.has(tag));
}
async function handle(message: WorkerRequest): Promise<unknown> {
  if (message.type === "activate") {
    activeSource = message.source; activeGeneration = message.generation;
    for (const tx of writes) { try { tx.abort(); } catch { /* Already committed. */ } }
    writes.clear(); return null;
  }
  const db = await openDatabase();
  if (message.type === "status") {
    const tx = db.transaction(["checkpoints", "content"], "readonly");
    const saved = result(tx.objectStore("checkpoints").get(message.source)) as Promise<CatalogCheckpoint | undefined>;
    const count = result(tx.objectStore("content").index("source").count(IDBKeyRange.only(message.source)));
    const [checkpoint, actualCount] = await Promise.all([saved, count]);
    return checkpoint ? { ...checkpoint, count: actualCount } : {
      source: message.source, channels: [], count: actualCount, complete: false, updatedAt: 0, startedAt: 0, error: "",
    } satisfies CatalogCheckpoint;
  }
  if (message.type === "metadata" || message.type === "save") {
    if (message.source !== activeSource || message.generation !== activeGeneration) throw new Error("来源已改变，丢弃旧目录请求");
    const records = message.items.filter(item => (item.kind === "video" || item.kind === "post") && Number.isFinite(item.id) && item.id > 0 && !!item.title).map(item => indexed(message.source, item));
    const tx = db.transaction(["content", "checkpoints"], "readwrite");
    writes.add(tx);
    const done = completed(tx);
    // Mark rejection handled while IDB requests run; the final await still propagates it.
    void done.catch(() => {});
    const content = tx.objectStore("content");
    for (const row of records) content.put(row);
    const count = await result(content.index("source").count(IDBKeyRange.only(message.source)));
    let checkpoint = message.type === "save" ? message.checkpoint : await result(tx.objectStore("checkpoints").get(message.source)) as CatalogCheckpoint | undefined;
    if (checkpoint) {
      checkpoint = { ...checkpoint, count };
      tx.objectStore("checkpoints").put(checkpoint);
    }
    await done;
    return checkpoint || { count };
  }
  const query = normalize(message.query);
  const tx = db.transaction("content", "readonly");
  const cursor = tx.objectStore("content").index("source").openCursor(IDBKeyRange.only(message.source));
  const matches: { row: IndexedContent; rank: number }[] = [];
  await new Promise<void>((resolve, reject) => {
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const next = cursor.result;
      if (!next) { resolve(); return; }
      const row = next.value as IndexedContent;
      const position = row.initials.indexOf(query);
      if (position >= 0 && allowed(row.content, message.preferences)) matches.push({ row, rank: row.initials === query ? 0 : position === 0 ? 1 : 2 });
      next.continue();
    };
  });
  matches.sort((a, b) => a.rank - b.rank || b.row.content.hot - a.row.content.hot || (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0));
  const offset = Math.max(0, message.offset), end = offset + Math.min(50, Math.max(1, message.limit));
  return { items: matches.slice(offset, end).map(item => item.row.content), total: matches.length,
    nextOffset: Math.min(end, matches.length), hasMore: end < matches.length } satisfies CatalogQuery;
}
scope.onmessage = event => {
  const message = event.data;
  void handle(message).then(value => scope.postMessage({ requestId: message.requestId, value }),
    error => scope.postMessage({ requestId: message.requestId, error: error instanceof Error ? error.message : String(error) }));
};
