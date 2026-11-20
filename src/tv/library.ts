import { invoke } from "@tauri-apps/api/core";
import { contentKey, metadataOnly, needsLibraryMetadata, type PendingMigrationIdentity, type TvContent, type TvLibraryEntry, type TvProgress } from "./model";

const DATABASE = "hghubx-tv-library-v1";
const MIGRATION_KEY = "legacy-library-v1";
// Read-only legacy keys: importing storage.ts/accountData.ts would run or bundle
// ordinary-edition migration/account behavior in the TV entry point.
const GUEST_KEYS = ["hghubx_app_v1", "hghub_app_v1"];
const ACCOUNT_KEY = "hghubx_accounts_v1";
const listeners = new Set<() => void>();
let opening: Promise<IDBDatabase> | undefined;

export function subscribeLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function changed() { listeners.forEach(listener => listener()); }

function database(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("library", { keyPath: "key" });
        db.createObjectStore("meta");
      };
      request.onerror = () => reject(request.error ?? new Error("TV 片库存储打开失败"));
      request.onblocked = () => reject(new Error("TV 片库存储被旧窗口占用，请重新打开应用"));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = undefined; };
        resolve(db);
      };
    }).catch(error => { opening = undefined; throw error; });
  }
  return opening;
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("TV 片库保存失败，本次更改尚未保存"));
    transaction.onerror = () => { /* Abort reports the final transaction outcome. */ };
  });
}
const validId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
type LegacyData = { favs?: unknown; postFavs?: unknown; history?: unknown };

function readLegacy(key: string): unknown {
  const raw = localStorage.getItem(key); // Storage-denied is a migration failure, not empty data.
  if (raw === null) return undefined;
  try { return JSON.parse(raw); }
  catch { throw new Error("旧片库数据读取失败，原始数据已保留，请重试"); }
}
function legacyObject(raw: unknown): LegacyData {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("旧片库格式异常，原始数据已保留");
  return raw as LegacyData;
}
function legacyContent(kind: "video" | "post", id: number): TvContent {
  return { kind, id, title: kind === "video" ? `影片 ${id}` : `视频 ${id}`, cover: "", tags: [], hot: 0, metadataState: "missing" };
}

function collectLegacy(identity?: PendingMigrationIdentity | null): TvLibraryEntry[] {
  const sources: LegacyData[] = [];
  for (const key of GUEST_KEYS) {
    const guest = readLegacy(key);
    if (guest !== undefined) { sources.push(legacyObject(guest)); break; }
  }
  if (identity) {
    if (!validId(identity.user_id) || typeof identity.origin !== "string" || !identity.origin) throw new Error("待迁移身份无效");
    const saved = readLegacy(ACCOUNT_KEY) as { version?: unknown; accounts?: unknown } | undefined;
    if (saved !== undefined) {
      if (!saved || saved.version !== 1 || !saved.accounts || typeof saved.accounts !== "object" || Array.isArray(saved.accounts)) {
        throw new Error("旧账号片库格式异常，原始数据已保留");
      }
      // Never iterate across accounts or infer an identity from the selected line.
      const selected = (saved.accounts as Record<string, unknown>)[JSON.stringify([identity.origin, identity.user_id])];
      if (selected !== undefined) sources.push(legacyObject(selected));
    }
  }
  const entries = new Map<string, TvLibraryEntry>();
  const entry = (kind: "video" | "post", id: number) => {
    const content = legacyContent(kind, id), key = contentKey(content);
    let row = entries.get(key);
    if (!row) { row = { key, content, favorite: false }; entries.set(key, row); }
    return row;
  };
  for (const source of sources) {
    for (const [field, kind] of [["favs", "video"], ["postFavs", "post"]] as const) {
      const ids = source[field];
      if (ids !== undefined && !Array.isArray(ids)) throw new Error("旧收藏格式异常，原始数据已保留");
      for (const id of (ids as unknown[] | undefined) ?? []) if (validId(id)) entry(kind, id).favorite = true;
    }
    if (source.history !== undefined && !Array.isArray(source.history)) throw new Error("旧历史格式异常，原始数据已保留");
    for (const [position, value] of ((source.history as unknown[] | undefined) ?? []).entries()) {
      const raw = typeof value === "number" ? { id: value, ep: 1, t: 0, dur: 0, at: 0 } : value as Record<string, unknown> | null;
      if (!raw || !validId(raw.id)) continue;
      const ep = Number(raw.ep) || 1, seconds = Number(raw.t) || 0, duration = Number(raw.dur) || 0;
      const updatedAt = Number(raw.at) || 0;
      if (!Number.isSafeInteger(ep) || ep < 1 || !Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(duration) || duration < 0 || !Number.isFinite(updatedAt) || updatedAt < 0) continue;
      const row = entry("video", raw.id);
      const progress: TvProgress = { key: row.key, content: row.content, part: String(ep), seconds, duration,
        // Very old id-only history has no timestamp. Preserve its list order
        // without inventing a recent timestamp that defeats a real account row.
        updatedAt: updatedAt || Math.max(0, 1 - position / 1_000_000) };
      if (!row.progress || row.progress.updatedAt < progress.updatedAt) row.progress = progress;
    }
  }
  return [...entries.values()];
}

/** Atomic library+marker commit. Failure or interruption keeps import retryable. */
export async function initializeLibrary(identity?: PendingMigrationIdentity | null): Promise<void> {
  const db = await database();
  const transaction = db.transaction(["library", "meta"], "readwrite");
  const completed = done(transaction);
  let failure: unknown;
  const meta = transaction.objectStore("meta"), library = transaction.objectStore("library");
  const check = meta.get(MIGRATION_KEY);
  check.onsuccess = () => {
    if (check.result?.complete === true) return;
    try {
      const imported = collectLegacy(identity);
      for (const row of imported) {
        const read = library.get(row.key);
        read.onsuccess = () => {
          try {
            const old = read.result as TvLibraryEntry | undefined;
            const progress = old?.progress && (!row.progress || old.progress.updatedAt >= row.progress.updatedAt) ? old.progress : row.progress;
            library.put({ ...row, content: old?.content ?? row.content, favorite: row.favorite || old?.favorite === true,
              ...(progress ? { progress } : {}) });
          } catch (error) { failure = error; transaction.abort(); }
        };
      }
      meta.put({ complete: true, completedAt: Date.now() }, MIGRATION_KEY);
    } catch (error) { failure = error; transaction.abort(); }
  };
  try { await completed; } catch (error) { throw failure ?? error; }
  changed();
  // An interrupted acknowledgement retries this IPC, never the completed import.
  try {
    await invoke("tv_migration_complete", { identity: identity ?? null });
  } catch (error) {
    // 跨包迁移后端未移植：命令缺失时本地片库照常可用，移植后此路径自动生效。
    // Tauri 2.12.5 对未注册命令固定 reject "Command tv_migration_complete not found"
    // （tauri src/webview/mod.rs）；仅豁免这一种错误，其余 IPC 失败照常抛出保持可重试。
    if (String(error) !== "Command tv_migration_complete not found") throw error;
  }
}

export async function listLibrary(): Promise<TvLibraryEntry[]> {
  const db = await database();
  const transaction = db.transaction("library", "readonly");
  const completed = done(transaction);
  const request = transaction.objectStore("library").getAll();
  await completed;
  return (request.result as TvLibraryEntry[]).filter(row => row.favorite || row.progress)
    .sort((a, b) => (b.progress?.updatedAt ?? 0) - (a.progress?.updatedAt ?? 0) || a.key.localeCompare(b.key));
}

async function update(content: TvContent, mutate: (current: TvLibraryEntry) => TvLibraryEntry): Promise<void> {
  const clean = metadataOnly(content), key = contentKey(clean);
  const db = await database(), transaction = db.transaction("library", "readwrite");
  const completed = done(transaction), store = transaction.objectStore("library");
  let failure: unknown;
  const request = store.get(key);
  request.onsuccess = () => {
    try {
      const previous = request.result as TvLibraryEntry | undefined;
      const current = { ...(previous ?? { key, favorite: false }), content: clean };
      store.put(mutate(current));
    } catch (error) { failure = error; transaction.abort(); }
  };
  try { await completed; } catch (error) { throw failure ?? error; }
  changed();
}

export const saveContent = (content: TvContent): Promise<void> => update(content, current => ({ ...current,
  ...(current.progress ? { progress: { ...current.progress, content: metadataOnly(content) } } : {}) }));

/** Refresh only the metadata of a still-existing unresolved library record.
 * Read inside this transaction: a late response must not recreate cleared
 * history/favorites, overwrite newer details, or rewind a playback position.
 */
export async function hydrateLibraryContent(content: TvContent, isCurrent: () => boolean): Promise<boolean> {
  if (!isCurrent()) return false;
  const clean = metadataOnly({ ...content, metadataState: "ready" }), key = contentKey(clean);
  const db = await database();
  if (!isCurrent()) return false;
  const transaction = db.transaction("library", "readwrite"), completed = done(transaction);
  const store = transaction.objectStore("library"), request = store.get(key);
  let saved = false;
  request.onsuccess = () => {
    const existing = request.result as TvLibraryEntry | undefined;
    if (!isCurrent() || !existing || (!existing.favorite && !existing.progress) || !needsLibraryMetadata(existing.content)) return;
    store.put({ ...existing, content: clean,
      ...(existing.progress ? { progress: { ...existing.progress, content: clean } } : {}) });
    saved = true;
  };
  await completed;
  if (saved) changed();
  return saved;
}
export const setFavorite = (content: TvContent, favorite: boolean): Promise<void> => update(content, current => ({ ...current, favorite }));

export function saveProgress(content: TvContent, progress: TvProgress): Promise<void> {
  const key = contentKey(content);
  if (progress.key !== key || contentKey(progress.content) !== key || typeof progress.part !== "string" || !progress.part
    || !Number.isFinite(progress.seconds) || progress.seconds < 0 || !Number.isFinite(progress.duration) || progress.duration < 0
    || !Number.isFinite(progress.updatedAt) || progress.updatedAt < 0) return Promise.reject(new Error("播放进度身份或数值无效"));
  const clean: TvProgress = { key, content: metadataOnly(content), part: progress.part, seconds: progress.seconds, duration: progress.duration, updatedAt: progress.updatedAt };
  return update(content, current => current.progress && current.progress.updatedAt > clean.updatedAt ? current : { ...current, progress: clean });
}

export async function clearHistory(): Promise<void> {
  const db = await database(), transaction = db.transaction("library", "readwrite");
  const completed = done(transaction), cursor = transaction.objectStore("library").openCursor();
  cursor.onsuccess = () => {
    const item = cursor.result;
    if (!item) return;
    const row = item.value as TvLibraryEntry;
    if (row.favorite) item.update({ key: row.key, content: row.content, favorite: true });
    else item.delete();
    item.continue();
  };
  await completed;
  changed();
}
