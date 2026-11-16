import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, platform as envPlatform } from "./api";
import { isStrictSecurity, setStrictSecurity as setHtmlStrictSecurity } from "./html";
import type { User } from "./types";
import { readStorage, STORAGE_KEYS } from "./storage";
import { pickGuestData, useAccountData, type GuestData } from "./accountData";

export type Platform = "android" | "ios" | "windows" | "macos" | "linux";
export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";
export type Tab = "home" | "search" | "category" | "profile";

/** 播放页上下文：ids 是来源列表，index 是当前条目。 */
export type FeedContext = {
  kind: "feed";
  key: string;
  videoIds: number[];
  index: number;
  title: string;
  source: string;
  feedKind?: "video" | "post";
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

export type Page =
  | FeedContext
  | { kind: "channel"; key: string; cate: string; name: string }
  | { kind: "ranks"; key: string }
  | { kind: "settings"; key: string; section?: "内容偏好" }
  | { kind: "posts"; key: string }
  | { kind: "post"; key: string; id: number }
  | { kind: "topics"; key: string }
  | { kind: "topic"; key: string; slug: string; name: string }
  | { kind: "tags"; key: string }
  | { kind: "tag"; key: string; tag: string; name: string }
  | { kind: "following"; key: string }
  | { kind: "user"; key: string; id: number; name?: string };

export type PageInput =
  | { kind: "feed"; videoIds: number[]; index: number; title: string; source?: string; feedKind?: "video" | "post"; startEp?: number; startTime?: number }
  | { kind: "channel"; cate: string; name: string }
  | { kind: "ranks" }
  | { kind: "settings"; section?: "内容偏好" }
  | { kind: "posts" }
  | { kind: "post"; id: number }
  | { kind: "topics" }
  | { kind: "topic"; slug: string; name: string }
  | { kind: "tags" }
  | { kind: "tag"; tag: string; name: string }
  | { kind: "following" }
  | { kind: "user"; id: number; name?: string };

export type Toast = {
  id: number;
  msg: string;
  icon?: "ok" | "heart" | "star" | "info";
  /** 线路切换专用的结构化内容，有这个就不看 msg */
  line?: { region: "cn" | "intl"; host: string; ms: number };
};

/** 观看记录：看到第几集、第几秒（`dur` 用来判断是否已看完） */
export type WatchProgress = { id: number; ep: number; t: number; dur: number; at: number };

type Persist = GuestData & {
  muted: boolean;
  muteOnStartup: boolean;
  volume: number;
  searchHist: string[];
  /** 上下划切集：多集短剧上下滑就换集，而不是换下一部 */
  swipeEp: boolean;
  /** 优先高清：有 HEVC 就用 HEVC，播不了自动回退标准 */
  preferHevc: boolean;
};

const LS = STORAGE_KEYS.app;
const DEFAULTS: Persist = {
  likes: [], favs: [], history: [], follows: [],
  muted: true, muteOnStartup: true, volume: 0.7, searchHist: [], swipeEp: true, preferHevc: false,
};

/** 旧版本 history 是 number[]，读出来时升级成带进度的结构 */
function normalizeHistory(raw: unknown): WatchProgress[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchProgress[] = [];
  raw.forEach((item, i) => {
    if (typeof item === "number") {
      out.push({ id: item, ep: 1, t: 0, dur: 0, at: Date.now() - i });
      return;
    }
    const h = item as Partial<WatchProgress> | null;
    if (h && typeof h.id === "number") {
      out.push({ id: h.id, ep: Number(h.ep) || 1, t: Number(h.t) || 0, dur: Number(h.dur) || 0, at: Number(h.at) || Date.now() - i });
    }
  });
  return out;
}

function loadPersist(): Persist {
  try {
    const raw = readStorage(LS);
    const swipeMigration = readStorage(STORAGE_KEYS.swipeEp);
    if (!raw) return DEFAULTS;
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persist>) };
    // 只在启动时应用；本次使用中取消静音不会关闭此偏好。
    const muteOnStartup = p.muteOnStartup !== false;
    /* 1.2.9 起上下划默认就是切集。老配置里 swipeEp 存的 false 是当年的默认值，
       不是用户主动关的，所以这里做一次性迁移；用户之后自己关掉不会再被改回来。 */
    let swipeEp = p.swipeEp !== false;
    try {
      if (swipeMigration !== "1") {
        swipeEp = true;
        localStorage.setItem(STORAGE_KEYS.swipeEp, "1");
      }
    } catch { /* ignore */ }
    return { ...p, swipeEp, muteOnStartup, muted: muteOnStartup || p.muted === true, history: normalizeHistory(p.history) };
  } catch {
    return DEFAULTS;
  }
}

function readThemePreference(): ThemePreference {
  try {
    const saved = readStorage(STORAGE_KEYS.theme);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
    return "system";
  } catch {
    return "system";
  }
}

function resolveTheme(preference: ThemePreference): Theme {
  if (preference !== "system") return preference;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("theme-light", theme === "light");
  document.documentElement.style.colorScheme = theme;
  root.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === "light" ? "#eeece7" : "#121212";
}

let themeTransitionTimer = 0;
function beginThemeTransition() {
  const root = document.documentElement;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.style.setProperty("--theme-transition-surface", getComputedStyle(root).getPropertyValue("--p-bg").trim());
  root.classList.add("theme-transitioning");
  window.clearTimeout(themeTransitionTimer);
  themeTransitionTimer = window.setTimeout(() => root.classList.remove("theme-transitioning"), 420);
}

type Store = {
  platform: Platform;
  theme: Theme; themePreference: ThemePreference; setTheme: (t: ThemePreference) => void;
  tab: Tab; setTab: (t: Tab) => void;
  stack: Page[]; push: (p: PageInput) => void; pop: () => void;
  user: User | null; setUser: (u: User | null, origin?: string) => void;
  accountScope: string; accountSync: { busy: boolean; error: string; lastSynced: number; favoritesKnown: boolean };
  syncAccount: () => Promise<void>;
  setCollected: (kind: "video" | "post", id: number, on: boolean) => Promise<void>;
  setLiked: (kind: "video" | "post", id: number, ep: number, on: boolean) => Promise<void>;
  setFollowing: (id: number, on: boolean) => Promise<void>;
  actionPending: (key: string) => boolean;
  loginOpen: boolean; setLoginOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  likes: number[]; favs: number[]; history: WatchProgress[]; follows: number[];
  isLiked: (id: number, ep?: number, kind?: "video" | "post") => boolean; isFav: (id: number, kind?: "video" | "post") => boolean;
  toggleLikeLocal: (id: number) => boolean;
  toggleFavLocal: (id: number) => boolean;
  /** 记一条观看记录；`ep/t/dur` 省略时保留原进度，`ep` 变了就把进度归零 */
  addHistory: (id: number, ep?: number, t?: number, dur?: number) => void;
  clearHistory: () => Promise<void>;
  toggleFollowLocal: (uid: number) => boolean;
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  /** 移动端「净屏」：只留画面，UI 全隐 */
  clean: boolean; setClean: (v: boolean | ((p: boolean) => boolean)) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  muteOnStartup: boolean; setMuteOnStartup: (on: boolean) => void;
  swipeEp: boolean; setSwipeEp: (on: boolean) => void;
  preferHevc: boolean; setPreferHevc: (on: boolean) => void;
  volume: number; setVolume: (v: number) => void;
  searchHist: string[]; addSearch: (q: string) => void; clearSearchHist: () => void;
  strictSecurity: boolean; strictSecurityReady: boolean; securityPending: boolean; cliRelaxed: boolean; setStrictSecurity: (on: boolean) => Promise<void>;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"]) => void;
  /** 线路切换计数：变了就让列表页重挂载，重新拉一遍数据 */
  lineEpoch: number;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [p, setP] = useState<Persist>(loadPersist);
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(readThemePreference);
  const [theme, setThemeState] = useState<Theme>(() => resolveTheme(readThemePreference()));
  const themeRef = useRef(theme);
  const [tab, setTabRaw] = useState<Tab>("home");
  const [stack, setStack] = useState<Page[]>([]);
  // Guest library writes must not roll back sound, quality, gestures or search preferences.
  const account = useAccountData(
    pickGuestData(p),
    data => setP(previous => ({ ...previous, ...pickGuestData(data) })),
  );
  const { user, setUser } = account;
  const accountRef = useRef(account); accountRef.current = account;
  const [loginOpen, setLoginOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lineEpoch, setLineEpoch] = useState(0);
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const [clean, setCleanState] = useState(false);
  const [strictSecurity, setStrictSecurityState] = useState<boolean>(isStrictSecurity);
  const [cliRelaxed, setCliRelaxed] = useState(false);
  const [strictSecurityReady, setStrictSecurityReady] = useState(false);
  const [securityPending, setSecurityPending] = useState(false);
  const toastSeq = useRef(0);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const next = resolveTheme(themePreference);
      if (themeRef.current !== next) beginThemeTransition();
      themeRef.current = next;
      setThemeState(next);
    };
    sync();
    if (themePreference === "system") {
      media.addEventListener?.("change", sync);
      return () => media.removeEventListener?.("change", sync);
    }
  }, [themePreference]);

  useLayoutEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(STORAGE_KEYS.theme, themePreference); } catch { /* ignore */ }
  }, [theme, themePreference]);

  const setTheme = useCallback((next: ThemePreference) => {
    const resolved = resolveTheme(next);
    if (resolved !== themeRef.current) beginThemeTransition();
    themeRef.current = resolved;
    setThemePreferenceState(next);
    setThemeState(resolved);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* ignore */ }
  }, [p]);

  useEffect(() => {
    let request = 0;
    let active = true;
    const readBoot = () => {
      const current = ++request;
      const generation = accountRef.current.generation();
      void api.boot().then((r) => {
        if (!active || current !== request) return;
        accountRef.current.restoreSession(r.user && (r.user as User).id ? r.user as User : null, r.base || "", generation);
        if (typeof r.strict_security === "boolean") {
          setStrictSecurityState(r.strict_security);
          setHtmlStrictSecurity(r.strict_security);
          setStrictSecurityReady(true);
        }
        setCliRelaxed(!!r.cli_relaxed);
      }).catch(() => { /* 离线也能用 */ });
    };
    readBoot();
    const changed = () => { accountRef.current.setUser(null); readBoot(); };
    window.addEventListener("hg:line-changed", changed);
    window.addEventListener("hg:proxy-changed", changed);
    return () => {
      active = false;
      window.removeEventListener("hg:line-changed", changed);
      window.removeEventListener("hg:proxy-changed", changed);
    };
  }, []);

  const setStrictSecurity = useCallback(async (on: boolean) => {
    if (!strictSecurityReady) throw new Error("安全设置尚未读取，请重新启动应用");
    setSecurityPending(true);
    try {
      const saved = await api.securitySet(on);
      setHtmlStrictSecurity(saved);
      setStrictSecurityState(saved);
    } finally {
      setSecurityPending(false);
    }
  }, [strictSecurityReady]);

  const toast = useCallback((msg: string, icon?: Toast["icon"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-2), { id, msg, icon }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2200);
  }, []);
  /** 自动选线切换成功后由 `autoLine.ts` 派发，这里只负责显示 */
  useEffect(() => {
    const onLine = (e: Event) => {
      const d = (e as CustomEvent<{ region: "cn" | "intl"; host: string; ms: number }>).detail;
      if (!d) return;
      const id = ++toastSeq.current;
      setToasts((t) => [...t.slice(-2), { id, msg: "", line: d }]);
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
    };
    window.addEventListener("hg:line", onLine);
    return () => window.removeEventListener("hg:line", onLine);
  }, []);
  /** 自动选线：主站和发布页上的镜像全都不通。
   *
   * 只说一次（60s 节流）——巡检本身 10s 一轮，不节流会一直弹。
   * 以前这种情况会悄悄切到 `.ai`（接口全 404），用户只看到「加载失败」，
   * 根本不知道是网络的事。
   */
  useEffect(() => {
    let last = 0;
    const onDown = () => {
      const now = Date.now();
      if (now - last < 60_000) return;
      last = now;
      const id = ++toastSeq.current;
      setToasts((t) => [...t.slice(-2), { id, msg: "线路全部不可用，请检查网络或代理", icon: "info" }]);
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
    };
    window.addEventListener("hg:line-down", onDown);
    return () => window.removeEventListener("hg:line-down", onDown);
  }, []);
  /** 线路真的换了（自动、手切都算）：
   *
   * 旧数据全是在上一个域名上拉的，留着等于对着一条死链路。但各列表页只在
   * 挂载时拉一次，所以这里给一个递增的 key，让它们重挂载、重新请求。
   */
  useEffect(() => {
    const bump = () => setLineEpoch((n) => n + 1);
    window.addEventListener("hg:line-changed", bump);
    window.addEventListener("hg:proxy-changed", bump);
    return () => {
      window.removeEventListener("hg:line-changed", bump);
      window.removeEventListener("hg:proxy-changed", bump);
    };
  }, []);

  const setTab = useCallback((t: Tab) => { setTabRaw(t); setStack(s => s.length ? [] : s); }, []);
  useEffect(() => { if (tab === "profile") void accountRef.current.syncAccount().catch(() => {}); }, [tab]);
  const push = useCallback((pg: PageInput) => {
    setStack((s) => [...s, { ...pg, key: `p${++seq}` } as Page]);
  }, []);
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);

  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  const logout = useCallback(async () => {
    await accountRef.current.logout();
    toast("已退出登录", "info");
  }, [toast]);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
    // 进出全屏/净屏时把「净屏」收掉，避免退出后 UI 还藏着
    setCleanState(false);
  }, []);

  const setClean = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setCleanState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => ({ ...s, muted: typeof v === "function" ? v(s.muted) : v }));
  }, []);
  const setMuteOnStartup = useCallback((on: boolean) => {
    setP((s) => ({ ...s, muteOnStartup: on }));
  }, []);
  const setSwipeEp = useCallback((on: boolean) => {
    setP((s) => ({ ...s, swipeEp: on }));
  }, []);
  const setPreferHevc = useCallback((on: boolean) => {
    setP((s) => ({ ...s, preferHevc: on }));
  }, []);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);

  const value = useMemo<Store>(() => ({
    platform: envPlatform,
    theme, themePreference, setTheme,
    tab, setTab, stack, push, pop,
    user, setUser, loginOpen, setLoginOpen, logout,
    accountScope: account.accountScope, accountSync: account.accountSync, syncAccount: account.syncAccount,
    likes: account.likes, favs: account.favs, history: account.history, follows: account.follows,
    isLiked: account.isLiked, isFav: account.isFav,
    setCollected: account.setCollected, setLiked: account.setLiked, setFollowing: account.setFollowing, actionPending: account.actionPending,
    toggleLikeLocal: account.toggleLikeLocal, toggleFavLocal: account.toggleFavLocal, toggleFollowLocal: account.toggleFollowLocal,
    addHistory: account.addHistory, clearHistory: account.clearHistory,
    muted: p.muted, setMuted, volume: p.volume, setVolume, theater, setTheater, fs, setFs, clean, setClean,
    muteOnStartup: p.muteOnStartup, setMuteOnStartup,
    swipeEp: p.swipeEp, setSwipeEp,
    preferHevc: p.preferHevc, setPreferHevc,
    searchHist: p.searchHist, addSearch, clearSearchHist,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast, lineEpoch,
  }), [theme, themePreference, setTheme, tab, setTab, stack, push, pop, user, loginOpen, logout,
    p, account,
    setMuted, setMuteOnStartup, setSwipeEp, setPreferHevc, setVolume, addSearch, clearSearchHist, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast, lineEpoch, theater, setTheater, fs, setFs, clean, setClean]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
