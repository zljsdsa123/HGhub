import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { AccountHistoryItem, AccountIdentity, AccountInteractions, User } from "./types";
import type { WatchProgress } from "./store";

type Kind = "video" | "post";
export type GuestData = {
  likes: number[]; favs: number[]; follows: number[]; history: WatchProgress[];
  postLikes?: number[]; postFavs?: number[];
  likeEpisodes?: { video_id: number; ep: number }[];
  localHistory?: number[];
};

/** Share one library-only boundary without losing guest post or episode interactions. */
export function pickGuestData(data: GuestData): GuestData {
  return { likes: data.likes, favs: data.favs, follows: data.follows, history: data.history,
    postLikes: data.postLikes, postFavs: data.postFavs, likeEpisodes: data.likeEpisodes, localHistory: data.localHistory };
}
type AccountData = GuestData & {
  postLikes: number[]; postFavs: number[];
  likeEpisodes?: { video_id: number; ep: number }[];
  dirtyHistory: Record<number, { ep: number; at: number }>;
  localHistory: number[];
};
type SyncState = { busy: boolean; error: string; lastSynced: number; favoritesKnown: boolean };
const ACCOUNT_KEY = "hghubx_accounts_v1";
const empty = (): AccountData => ({ likes: [], favs: [], follows: [], history: [], postLikes: [], postFavs: [], dirtyHistory: {}, localHistory: [] });
const ids = (value: unknown): number[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is number => Number.isSafeInteger(id) && id > 0))] : [];
const validProgress = (value: unknown): value is WatchProgress => {
  const row = value as WatchProgress | null;
  return !!row && Number.isSafeInteger(row.id) && row.id > 0 && Number.isFinite(row.at)
    && Number.isSafeInteger(row.ep) && row.ep > 0 && Number.isFinite(row.t) && row.t >= 0 && Number.isFinite(row.dur) && row.dur >= 0;
};
function sanitize(value: Partial<AccountData> | null | undefined): AccountData {
  const data = { ...empty(), ...value };
  // Account snapshots must never retain unrelated application preferences.
  return { likes: ids(data.likes), favs: ids(data.favs), follows: ids(data.follows), postLikes: ids(data.postLikes), postFavs: ids(data.postFavs),
    history: Array.isArray(data.history) ? data.history.filter(validProgress) : [], localHistory: ids(data.localHistory),
    likeEpisodes: Array.isArray(data.likeEpisodes) ? data.likeEpisodes.filter(row => Number.isSafeInteger(row?.video_id) && row.video_id > 0 && Number.isSafeInteger(row.ep) && row.ep > 0) : undefined,
    dirtyHistory: Object.fromEntries(Object.entries(data.dirtyHistory || {}).filter(([id, row]) => Number.isSafeInteger(Number(id)) && Number(id) > 0 && Number.isSafeInteger(row?.ep) && row.ep > 0 && Number.isFinite(row.at))),
  };
}
const selected = (list: number[], id: number, on: boolean) => on ? [id, ...list.filter(x => x !== id)] : list.filter(x => x !== id);
const message = (error: unknown) => error instanceof Error ? error.message : "账号同步失败，请重试";
function applyInteractions(data: AccountData, incoming?: AccountInteractions): AccountData {
  if (!incoming) return data;
  const next = { ...data };
  for (const [local, remote] of [["likes", "like_video_ids"], ["favs", "favorite_video_ids"], ["follows", "follow_user_ids"], ["postLikes", "like_post_ids"], ["postFavs", "favorite_post_ids"]] as const) {
    if (Array.isArray(incoming[remote])) next[local] = ids(incoming[remote]);
  }
  if (Array.isArray(incoming.like_video_episodes)) next.likeEpisodes = sanitize({ likeEpisodes: incoming.like_video_episodes }).likeEpisodes;
  return next;
}

/** Separate guest/account caches. Async responses may commit only to their initiating session. */
export function useAccountData(initialGuest: GuestData, saveGuest: (data: GuestData) => void) {
  const [, redraw] = useState(0);
  const render = () => redraw(n => n + 1);
  const mounted = useRef(true);
  const saveGuestRef = useRef(saveGuest); saveGuestRef.current = saveGuest;
  const state = useRef<{ user: User | null; origin: string; key: string; generation: number; data: AccountData; sync: SyncState } | null>(null);
  const accounts = useRef<Record<string, AccountData>>({});
  const guest = useRef(sanitize(initialGuest));
  if (!state.current) {
    try {
      const saved = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "{}");
      if (saved.version === 1 && saved.accounts && typeof saved.accounts === "object") {
        accounts.current = Object.fromEntries(Object.entries(saved.accounts).map(([key, data]) => [key, sanitize(data as AccountData)]));
      }
    } catch { /* A damaged account cache must not erase legacy guest records. */ }
    state.current = { user: null, origin: "", key: "guest", generation: 0, data: guest.current, sync: { busy: false, error: "", lastSynced: 0, favoritesKnown: false } };
  }
  const pending = useRef(new Map<string, Promise<void>>());
  const mutation = useRef(0);
  const historyMutation = useRef(0);
  const clearVersion = useRef(0);
  const storageError = useRef("");
  const needsResync = useRef(false);
  const synchronizing = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  const upload = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  const sentHistory = useRef(new Map<number, number>());
  const clearing = useRef<number | null>(null);
  const flushTimer = useRef<number | undefined>(undefined);
  const syncTimer = useRef<number | undefined>(undefined);
  const isCurrent = (generation: number) => mounted.current && state.current!.generation === generation;
  const identity = (): AccountIdentity => {
    const s = state.current!;
    if (!s.user || !s.origin) throw new Error("请先登录当前线路的账号");
    return { expectedUserId: s.user.id, expectedOrigin: s.origin };
  };
  const persist = (data: AccountData) => {
    const s = state.current!;
    s.data = data;
    if (!s.user) {
      guest.current = data;
      saveGuestRef.current(pickGuestData(data));
    }
    else {
      accounts.current[s.key] = data;
      try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ version: 1, accounts: accounts.current })); storageError.current = ""; }
      catch { storageError.current = "本机账号缓存保存失败，请检查存储空间"; s.sync = { ...s.sync, error: storageError.current }; }
    }
    if (mounted.current) render();
  };
  const flushHistory = async () => {
    const generation = state.current!.generation;
    if (!state.current!.user || clearing.current === generation) return;
    if (upload.current?.generation === generation) return upload.current.promise;
    const auth = identity();
    const run = (async () => {
      for (const [key, row] of Object.entries(state.current!.data.dirtyHistory)) {
        if (!isCurrent(generation) || clearing.current === generation) return;
        const id = Number(key);
        await api.accountHistoryRecord(auth, id, row.ep);
        if (!isCurrent(generation)) return;
        sentHistory.current.set(id, row.ep);
        const current = state.current!.data;
        if (current.dirtyHistory[id]?.at === row.at) {
          const dirtyHistory = { ...current.dirtyHistory }; delete dirtyHistory[id];
          persist({ ...current, dirtyHistory });
        }
      }
    })();
    upload.current = { generation, promise: run };
    try {
      await run;
      // A timer firing while an upload was in flight joined that upload. Drain new entries afterwards.
      if (isCurrent(generation) && Object.keys(state.current!.data.dirtyHistory).length) scheduleUpload(generation);
    } finally { if (upload.current?.promise === run) upload.current = null; }
  };
  function scheduleUpload(generation: number) {
    if (flushTimer.current || clearing.current === generation) return;
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = undefined;
      if (isCurrent(generation)) void flushHistory().catch(error => {
        if (isCurrent(generation)) { state.current!.sync = { ...state.current!.sync, error: `观看历史待同步：${message(error)}` }; render(); }
      });
    }, 1500);
  }
  const readHistory = async (auth: AccountIdentity, generation: number) => {
    const rows: AccountHistoryItem[] = [];
    const seen = new Set<number>();
    for (let page = 1; page <= 200; page++) {
      const result = await api.accountHistory(auth, page, 100);
      if (!isCurrent(generation)) throw new Error("账号已切换");
      if (!result || !Array.isArray(result.items) || !result.pagination || result.pagination.page !== page
        || !Number.isInteger(result.pagination.pages) || result.pagination.pages < 0 || result.pagination.pages > 200) throw new Error("账号历史返回格式异常");
      for (const row of result.items) if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
      if (page >= result.pagination.pages) return rows;
    }
    throw new Error("账号历史分页过多，请稍后重试");
  };
  const syncRef = useRef<() => Promise<void>>(async () => {});
  const syncAccount = useCallback(async () => {
    const s = state.current!;
    if (!s.user) return;
    const generation = s.generation;
    if (synchronizing.current?.generation === generation) return synchronizing.current.promise;
    if (clearing.current === generation) return;
    const auth = identity();
    s.sync = { ...s.sync, busy: true, error: "" }; render();
    const startMutation = mutation.current;
    const startClear = clearVersion.current;
    const startHistory = new Map(s.data.history.map(row => [row.id, row]));
    const run = (async () => {
      // Only replay observed playback, never silently upload the guest's library.
      const [profile, remote] = await Promise.allSettled([
        api.me(auth),
        (async () => { await flushHistory(); return readHistory(auth, generation); })(),
      ]);
      if (!isCurrent(generation)) return;
      let current = state.current!.data;
      let favoritesKnown = state.current!.sync.favoritesKnown;
      const errors: string[] = [];
      if (profile.status === "fulfilled") {
        const snapshot = profile.value;
        if (snapshot?.origin !== auth.expectedOrigin || snapshot.user?.id !== auth.expectedUserId) errors.push("账号资料身份不匹配，请重新登录");
        else if (mutation.current === startMutation && pending.current.size === 0) {
          state.current!.user = snapshot.user;
          current = applyInteractions(current, snapshot.interactions);
          if (Array.isArray(snapshot.interactions?.favorite_video_ids)) favoritesKnown = true;
          else if (!favoritesKnown) errors.push("账号未返回收藏数据，请重试");
        } else if (pending.current.size === 0) needsResync.current = true;
      } else errors.push(message(profile.reason));
      if (remote.status === "fulfilled" && clearVersion.current === startClear) {
        const localRows = new Map(current.history.map(row => [row.id, row]));
        const changed = (row: WatchProgress) => startHistory.get(row.id) !== row;
        const localOnly = new Set(current.localHistory);
        const merged = new Map(current.history.filter(row => localOnly.has(row.id) || current.dirtyHistory[row.id] || changed(row)).map(row => [row.id, row]));
        for (const row of remote.value) {
          if (row.target_type !== "video" || !Number.isSafeInteger(row.video_id) || row.video_id <= 0) continue;
          const local = localRows.get(row.video_id);
          const timestamp = Date.parse(row.updated_at.replace(" ", "T")) || 0;
          const ep = Math.max(1, row.last_ep || 1);
          if (!local || (timestamp > local.at && !current.dirtyHistory[row.video_id] && !changed(local))) {
            merged.set(row.video_id, { id: row.video_id, ep, t: local?.ep === ep ? local.t : 0, dur: local?.ep === ep ? local.dur : 0, at: timestamp });
          } else merged.set(row.video_id, local);
          if (!current.dirtyHistory[row.video_id] && (!local || !changed(local))) localOnly.delete(row.video_id);
        }
        current = { ...current, history: [...merged.values()].sort((a, b) => b.at - a.at), localHistory: [...localOnly] };
      } else if (remote.status === "rejected") errors.push(message(remote.reason));
      persist(current);
      if (storageError.current) errors.push(storageError.current);
      state.current!.sync = { busy: false, error: errors.join("；"), lastSynced: errors.length ? s.sync.lastSynced : Date.now(), favoritesKnown };
      render();
      if (errors.length) throw new Error(errors.join("；"));
    })();
    synchronizing.current = { generation, promise: run };
    try { await run; } finally {
      if (synchronizing.current?.promise === run) synchronizing.current = null;
      if (isCurrent(generation) && needsResync.current) {
        needsResync.current = false;
        window.clearTimeout(syncTimer.current);
        syncTimer.current = window.setTimeout(() => { if (isCurrent(generation)) void syncRef.current().catch(() => {}); }, 500);
      }
    }
  }, []);
  syncRef.current = syncAccount;
  const setUser = useCallback((user: User | null, origin?: string) => {
    const s = state.current!;
    const nextOrigin = origin ?? s.origin;
    const next = user && Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
    const key = next ? JSON.stringify([nextOrigin, next.id]) : "guest";
    window.clearTimeout(flushTimer.current); flushTimer.current = undefined;
    window.clearTimeout(syncTimer.current);
    s.generation++; mutation.current++; historyMutation.current++;
    s.user = next; s.origin = nextOrigin; s.key = key;
    s.data = next ? accounts.current[key] || applyInteractions(empty(), next.interactions) : guest.current;
    s.sync = { busy: false, error: "", lastSynced: 0, favoritesKnown: false };
    sentHistory.current.clear(); pending.current.clear(); needsResync.current = false; storageError.current = "";
    render();
    if (next) void syncRef.current().catch(() => {});
  }, []);
  const generation = useCallback(() => state.current!.generation, []);
  const restoreSession = useCallback((user: User | null, origin: string, expectedGeneration: number) => {
    if (!isCurrent(expectedGeneration)) return;
    if (!user && !state.current!.user) { state.current!.origin = origin; return; }
    setUser(user, origin);
  }, [setUser]);
  const logout = useCallback(async () => {
    const version = state.current!.generation;
    await api.logout(state.current!.user ? identity() : undefined);
    if (!isCurrent(version)) throw new Error("账号已切换");
    setUser(null);
  }, [setUser]);
  const mutate = (key: string, request: (auth: AccountIdentity) => Promise<unknown>, update: (data: AccountData) => AccountData) => {
    const s = state.current!;
    const version = s.generation;
    if (pending.current.has(key)) return pending.current.get(key)!;
    mutation.current++;
    const run = (async () => {
      if (s.user) await request(identity());
      if (!isCurrent(version)) throw new Error("账号已切换，原操作不会影响当前账号");
      mutation.current++;
      persist(update(state.current!.data));
    })();
    pending.current.set(key, run); render();
    void run.finally(() => {
      if (isCurrent(version) && pending.current.get(key) === run) {
        pending.current.delete(key); render();
        // Pending writes own their follow-up refresh; a slow write must not make sync poll every 500ms.
        if (state.current!.user) {
          window.clearTimeout(syncTimer.current);
          syncTimer.current = window.setTimeout(() => { if (isCurrent(version)) void syncRef.current().catch(() => {}); }, 500);
        }
      }
    }).catch(() => {});
    return run;
  };
  const setCollected = (kind: Kind, id: number, on: boolean) => mutate(`collect:${kind}:${id}`,
    auth => kind === "video" ? api.collect(id, on, auth) : api.postCollect(id, on, auth),
    data => kind === "video" ? { ...data, favs: selected(data.favs, id, on) } : { ...data, postFavs: selected(data.postFavs, id, on) });
  const setLiked = (kind: Kind, id: number, ep: number, on: boolean) => mutate(`like:${kind}:${id}:${ep}`,
    auth => kind === "video" ? api.like(id, ep, on, auth) : api.postLike(id, on, auth), data => {
      if (kind === "post") return { ...data, postLikes: selected(data.postLikes, id, on) };
      const likeEpisodes = (data.likeEpisodes || data.likes.map(video_id => ({ video_id, ep: 1 }))).filter(row => row.video_id !== id || row.ep !== ep);
      if (on) likeEpisodes.push({ video_id: id, ep });
      return { ...data, likeEpisodes, likes: selected(data.likes, id, likeEpisodes.some(row => row.video_id === id)) };
    });
  const setFollowing = (id: number, on: boolean) => {
    if (!state.current!.user) return Promise.reject(new Error("请先登录"));
    return mutate(`follow:${id}`, auth => api.follow(id, on, auth), data => ({ ...data, follows: selected(data.follows, id, on) }));
  };
  const currentGeneration = state.current.generation;
  const currentClearVersion = clearVersion.current;
  const addHistory = useCallback((id: number, ep?: number, time?: number, duration?: number) => {
    if (!isCurrent(currentGeneration) || clearVersion.current !== currentClearVersion || !Number.isSafeInteger(id) || id <= 0) return;
    const s = state.current!;
    if (clearing.current === currentGeneration) return;
    const previous = s.data.history.find(row => row.id === id);
    const nextEp = ep ?? previous?.ep ?? 1;
    const changed = previous && previous.ep !== nextEp;
    const row: WatchProgress = { id, ep: nextEp, t: time ?? (changed ? 0 : previous?.t ?? 0), dur: duration ?? (changed ? 0 : previous?.dur ?? 0), at: Date.now() };
    if (!validProgress(row)) return;
    historyMutation.current++;
    let dirtyHistory = s.data.dirtyHistory;
    if (s.user && time !== undefined && time >= 3 && sentHistory.current.get(id) !== nextEp && dirtyHistory[id]?.ep !== nextEp) {
      dirtyHistory = { ...dirtyHistory, [id]: { ep: nextEp, at: row.at } };
    }
    persist({ ...s.data, history: [row, ...s.data.history.filter(item => item.id !== id)], dirtyHistory, localHistory: selected(s.data.localHistory, id, true) });
    if (s.user && Object.keys(dirtyHistory).length) scheduleUpload(currentGeneration);
  }, [currentGeneration, currentClearVersion]);
  const clearHistory = async () => {
    const version = state.current!.generation;
    if (clearing.current === version) return;
    clearing.current = version;
    historyMutation.current++; clearVersion.current++;
    render();
    window.clearTimeout(flushTimer.current); flushTimer.current = undefined;
    try {
      if (state.current!.user) {
        if (upload.current?.generation === version) await upload.current.promise.catch(() => {});
        if (!isCurrent(version)) throw new Error("账号已切换");
        const auth = identity();
        const rows = await readHistory(auth, version);
        if (!isCurrent(version)) throw new Error("账号已切换");
        const rowIds = rows.filter(row => row.target_type === "video").map(row => row.id);
        // Empty IDs must never mean an implicit delete-all on the server.
        for (let offset = 0; offset < rowIds.length; offset += 100) {
          await api.accountHistoryDelete(auth, rowIds.slice(offset, offset + 100));
          if (!isCurrent(version)) throw new Error("账号已切换");
        }
      }
      if (isCurrent(version)) { historyMutation.current++; clearVersion.current++; sentHistory.current.clear(); persist({ ...state.current!.data, history: [], dirtyHistory: {}, localHistory: [] }); }
    } finally { if (clearing.current === version) clearing.current = null; }
  };
  const localToggle = (field: "likes" | "favs" | "follows", id: number) => {
    const on = !state.current!.data[field].includes(id); mutation.current++;
    persist({ ...state.current!.data, [field]: selected(state.current!.data[field], id, on) }); return on;
  };
  useEffect(() => {
    mounted.current = true;
    const refresh = () => { if (document.visibilityState !== "hidden") void syncRef.current().catch(() => {}); };
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { mounted.current = false; window.clearTimeout(flushTimer.current); window.clearTimeout(syncTimer.current);
      window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  const s = state.current;
  return { user: s.user, setUser, restoreSession, generation, logout, accountScope: `${s.key}:${s.generation}`, accountSync: s.sync,
    syncAccount, likes: s.data.likes, favs: s.data.favs, follows: s.data.follows, history: s.data.history,
    isFav: (id: number, kind: Kind = "video") => (kind === "video" ? s.data.favs : s.data.postFavs).includes(id),
    isLiked: (id: number, ep?: number, kind: Kind = "video") => kind === "post" ? s.data.postLikes.includes(id)
      : ep !== undefined && s.data.likeEpisodes ? s.data.likeEpisodes.some(row => row.video_id === id && row.ep === ep) : s.data.likes.includes(id),
    setCollected, setLiked, setFollowing, addHistory, clearHistory,
    actionPending: (key: string) => pending.current.has(key),
    toggleLikeLocal: (id: number) => localToggle("likes", id), toggleFavLocal: (id: number) => localToggle("favs", id), toggleFollowLocal: (id: number) => localToggle("follows", id),
  };
}
