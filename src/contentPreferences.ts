import { useSyncExternalStore } from "react";

export type ContentPreferences = { blockedTags: string[]; paused: boolean; hideUntagged: boolean };
export const CONTENT_PREFERENCES_KEY = "hghubx_content_preferences_v1";
export const MAX_BLOCKED_TAGS = 200;
export const MAX_TAG_LENGTH = 64;

const displayTag = (value: unknown): string => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
/** Exact tag identity only: punctuation and neighbouring words are not fuzzy matched. */
export const normalizeTag = (value: string): string => displayTag(value).toLowerCase();
function tagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>(), result: string[] = [];
  for (const candidate of value) {
    const name = displayTag(candidate), key = normalizeTag(name);
    if (!name || name.length > MAX_TAG_LENGTH || seen.has(key)) continue;
    seen.add(key); result.push(name);
    if (result.length >= MAX_BLOCKED_TAGS) break;
  }
  return result;
}
function normalizePreferences(value: unknown): ContentPreferences {
  const data = value && typeof value === "object" ? value as Partial<ContentPreferences> : {};
  return { blockedTags: tagList(data.blockedTags), paused: data.paused === true, hideUntagged: data.hideUntagged === true };
}
function readPreferences(): ContentPreferences {
  try { return normalizePreferences(JSON.parse(localStorage.getItem(CONTENT_PREFERENCES_KEY) || "null")); }
  catch { return normalizePreferences(null); }
}

// Preference snapshots are replaced on every edit. Reuse their normalized index
// across cards; WeakMap releases obsolete snapshots without retaining tag history.
const tagIndexes = new WeakMap<ContentPreferences, Map<string, number>>();
function tagIndex(preferences: ContentPreferences) {
  let index = tagIndexes.get(preferences);
  if (!index) {
    index = new Map();
    preferences.blockedTags.forEach((tag, rank) => {
      const key = normalizeTag(tag);
      if (key && !index!.has(key)) index!.set(key, rank);
    });
    tagIndexes.set(preferences, index);
  }
  return index;
}

export function blockReason(tags: readonly string[] | undefined, preferences: ContentPreferences): string | null {
  if (preferences.paused || (!preferences.hideUntagged && !preferences.blockedTags.length)) return null;
  const index = tagIndex(preferences);
  let hasTags = false, first = Infinity;
  for (const tag of Array.isArray(tags) ? tags : []) {
    const key = normalizeTag(tag);
    if (!key) continue;
    hasTags = true;
    const rank = index.get(key);
    if (rank !== undefined && rank < first) first = rank;
  }
  if (!hasTags) return preferences.hideUntagged ? "未提供标签" : null;
  return first < Infinity ? `屏蔽标签：${preferences.blockedTags[first]}` : null;
}

type Snapshot = { preferences: ContentPreferences; revision: number; storageError: string | null };
let snapshot: Snapshot = { preferences: readPreferences(), revision: 0, storageError: null };
const listeners = new Set<() => void>();
const same = (a: ContentPreferences, b: ContentPreferences) => JSON.stringify(a) === JSON.stringify(b);
const emit = () => listeners.forEach(listener => listener());
function update(next: ContentPreferences) {
  const preferences = normalizePreferences(next);
  if (same(snapshot.preferences, preferences) && !snapshot.storageError) return;
  let storageError: string | null = null;
  try { localStorage.setItem(CONTENT_PREFERENCES_KEY, JSON.stringify(preferences)); }
  catch { storageError = "本次偏好已生效，但本机保存失败；重启后可能恢复原设置。"; }
  snapshot = { preferences, revision: snapshot.revision + 1, storageError };
  emit();
}
function onStorage(event: StorageEvent) {
  if (event.key !== CONTENT_PREFERENCES_KEY && event.key !== null) return;
  const preferences = readPreferences();
  if (same(snapshot.preferences, preferences) && !snapshot.storageError) return;
  snapshot = { preferences, revision: snapshot.revision + 1, storageError: null };
  emit();
}
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}
const getSnapshot = () => snapshot;
const actions = {
  blockTags(tags: string[]) { update({ ...snapshot.preferences, blockedTags: [...snapshot.preferences.blockedTags, ...(Array.isArray(tags) ? tags : [])] }); },
  unblockTag(tag: string) { update({ ...snapshot.preferences, blockedTags: snapshot.preferences.blockedTags.filter(name => normalizeTag(name) !== normalizeTag(tag)) }); },
  setPaused(paused: boolean) { if (typeof paused === "boolean") update({ ...snapshot.preferences, paused }); },
  setHideUntagged(hideUntagged: boolean) { if (typeof hideUntagged === "boolean") update({ ...snapshot.preferences, hideUntagged }); },
  clearBlockedTags() { update({ ...snapshot.preferences, blockedTags: [] }); },
  isTagBlocked(tag: string) { return tagIndex(snapshot.preferences).has(normalizeTag(tag)); },
  blockReason(tags: readonly string[] | undefined) { return blockReason(tags, snapshot.preferences); },
};

/** A single stable external snapshot keeps settings, cards and the player in sync. */
export function useContentPreferences() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...current, ...actions };
}
