import { LiquidIndicator, Loader } from "../shared/ui/ios/effects";
import { Button } from "../shared/ui/ios/controls";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, type Page, type Tab } from "../shared/model/store";
import { isMobile, selfTest } from "../shared/api/api";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { runBack } from "../shared/lib/back";
import { exitDocumentFullscreen, getFullscreenElement } from "../shared/lib/fullscreen";
import Home from "../features/feed/Home";
import LoginModal from "../features/account/LoginModal";
import CalculatorGate from "../shared/ui/CalculatorGate";
import { ToastHost } from "../shared/ui/ui";
import { DesktopRail, DesktopTitleBar } from "./shell/DesktopChrome";
import ResizeHandles from "./shell/ResizeHandles";
import { tracePlayback } from "../shared/diagnostics/playbackDiagnostics";
import { IGrid, IGridF, IHome, IHomeF, ISearch, IUser, IUserF } from "../shared/ui/icons";

// Local chunks load on first visit; visited tabs stay mounted as before.
// Feed (+ hls.js) is separated from the initial shell so cold start mounts chrome and
// starts app_boot / autoLine / api_feed before compiling the 524 kB media engine.
const Feed = lazy(() => import("../features/feed/Feed"));
const Search = lazy(() => import("../features/search/Search"));
const RankPage = lazy(() => import("../features/search/Search").then(module => ({ default: module.RankPage })));
const Category = lazy(() => import("../features/category/Category"));
const ChannelPage = lazy(() => import("../features/category/Category").then(module => ({ default: module.ChannelPage })));
const Profile = lazy(() => import("../features/account/Profile"));
const SettingsPage = lazy(() => import("../features/settings/Settings"));
const PostsPage = lazy(() => import("../features/posts/Posts").then(module => ({ default: module.PostsPage })));
const PostDetail = lazy(() => import("../features/posts/Posts").then(module => ({ default: module.PostDetail })));
const TopicsPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TopicsPage })));
const TopicPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TopicPage })));
const TagsPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TagsPage })));
const TagPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TagPage })));
const FollowingPage = lazy(() => import("../features/account/User").then(module => ({ default: module.FollowingPage })));
const UserPage = lazy(() => import("../features/account/User").then(module => ({ default: module.UserPage })));

function PageLoading() {
  return <div className="absolute inset-0 grid place-items-center bg-bg"><Loader label="页面加载中" /></div>;
}

const SELECTABLE_TEXT = 'input, textarea, [contenteditable="true"], .select-text, .article-body';
const isSelectableText = (target: EventTarget | null) => target instanceof Element && !!target.closest(SELECTABLE_TEXT);

function TabBar() {
  const { tab, setTab } = useStore();
  const items = [
    { key: "home", label: "首页", Icon: IHome, Active: IHomeF },
    { key: "search", label: "搜索", Icon: ISearch, Active: ISearch },
    { key: "category", label: "分类", Icon: IGrid, Active: IGridF },
    { key: "profile", label: "我的", Icon: IUser, Active: IUserF },
  ] as const;
  const index = items.findIndex(item => item.key === tab);
  return <nav className="hg-tabbar ios-mobile-nav" aria-label="主导航" data-over-video={tab === "home"}>
      <div className="hg-glass">
      <div className="hg-drop" aria-hidden="true" style={{ transform: `translateX(${index * 100}%)` }}><LiquidIndicator /></div>
      <div className="ios-mobile-nav-items">
        {items.map(({ key, label, Icon, Active }) => {
          const Glyph = tab === key ? Active : Icon;
          return <Button key={key} className="ios-mobile-nav-item" onClick={() => setTab(key)}
            aria-current={tab === key ? "page" : undefined}>
            <Glyph size={22} /><span>{label}</span>
          </Button>;
        })}
      </div>
    </div>
  </nav>;
}

/* ============ 堆栈页面 ============ */
function StackPage(props: Parameters<typeof StackPageContent>[0]) {
  return <Suspense fallback={<PageLoading />}><StackPageContent {...props} /></Suspense>;
}

function StackPageContent({ page, onBack, wide, top, bottomInset, loginOpen }: {
  page: Page; onBack: () => void; wide: boolean; top: boolean; bottomInset: number; loginOpen: boolean;
}) {
  if (page.kind === "feed") {
    return (
      <Feed videoIds={page.videoIds} startIndex={page.index} title={page.title} kind={page.feedKind || "video"}
        startEp={page.startEp} startTime={page.startTime}
        mode="context" active={top && !loginOpen} bottomInset={bottomInset} onBack={onBack} />
    );
  }
  if (page.kind === "channel") return <ChannelPage cate={page.cate} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "ranks") return <RankPage onBack={onBack} wide={wide} />;
  if (page.kind === "settings") return <SettingsPage onBack={onBack} wide={wide} initialSection={page.section} />;
  if (page.kind === "posts") return <PostsPage onBack={onBack} wide={wide} />;
  if (page.kind === "post") return <PostDetail id={page.id} onBack={onBack} active={top && !loginOpen} />;
  if (page.kind === "topics") return <TopicsPage onBack={onBack} wide={wide} />;
  if (page.kind === "topic") return <TopicPage slug={page.slug} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "tags") return <TagsPage onBack={onBack} wide={wide} />;
  if (page.kind === "tag") return <TagPage tag={page.tag} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "following") return <FollowingPage onBack={onBack} wide={wide} />;
  if (page.kind === "user") return <UserPage id={page.id} name={page.name} onBack={onBack} wide={wide} />;
  return null;
}

/* ============ 应用主体 ============ */
function MainTabs({ wide, pageActive, covered, bottomInset }: { wide: boolean; pageActive: boolean; covered: boolean; bottomInset: number }) {
  const { tab } = useStore();
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set());
  useEffect(() => {
    if (pageActive) setVisited(previous => previous.has(tab) ? previous : new Set([...previous, tab]));
  }, [tab, pageActive]);
  const mounted = (key: Tab) => visited.has(key) || (pageActive && tab === key);
  const visible = (key: Tab) => tab === key ? `absolute inset-0 ${key === "home" ? "" : "ios-tab-active"}` : "absolute inset-0 hidden pointer-events-none";
  // First visits mount on demand; subsequent switches preserve queries, scroll and playback state.
  // DialogFrame's syncBackground() owns modal inertness so portals inside fullscreenElement never inherit ancestor inert.
  return <>
    <div className={visible("home")} inert={covered || tab !== "home"} aria-hidden={!pageActive || tab !== "home"}>{mounted("home") && <Home active={pageActive && tab === "home"} bottomInset={bottomInset} />}</div>
    <div className={visible("search")} inert={covered || tab !== "search"} aria-hidden={!pageActive || tab !== "search"}>{mounted("search") && <Suspense fallback={<PageLoading />}><Search active={pageActive && tab === "search"} wide={wide} /></Suspense>}</div>
    <div className={visible("category")} inert={covered || tab !== "category"} aria-hidden={!pageActive || tab !== "category"}>{mounted("category") && <Suspense fallback={<PageLoading />}><Category wide={wide} active={pageActive && tab === "category"} /></Suspense>}</div>
    <div className={visible("profile")} inert={covered || tab !== "profile"} aria-hidden={!pageActive || tab !== "profile"}>{mounted("profile") && <Suspense fallback={<PageLoading />}><Profile wide={wide} active={pageActive && tab === "profile"} /></Suspense>}</div>
  </>;
}

function AppBody() {
  const { platform, tab, setTab, stack, pop, loginOpen, setLoginOpen, fs, setFs, clean, locked } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  /* 全局键盘 */
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") { if (runBack()) return; if (fs) { setFs(false); return; } if (getFullscreenElement()) { void exitDocumentFullscreen().catch(() => {}); return; } if (stack.length) pop(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        setTab((["home", "search", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen, fs, setFs]);

  const pageActive = stack.length === 0 && !loginOpen;
  const bottomInset = fs || clean || locked ? 0 : 78;
  /* 栈页（从搜索/分类/我的进入的播放页、图文页）没有底栏，
     底部只让出安全区。之前多留了 20px，视频底边会露出一条
     「底栏」似的窄缝（底部的压暗渐变到不了屏幕最底）。 */
  const stackInset = 0;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      <div ref={mainRef} className="relative flex-1 min-w-0 overflow-hidden win-main">
        <MainTabs wide={wide} pageActive={pageActive} covered={stack.length > 0} bottomInset={bottomInset} />

        {stack.map((p, i) => (
          <div key={p.key} inert={i !== stack.length - 1} aria-hidden={i !== stack.length - 1 || loginOpen} className="absolute inset-0 z-30 bg-bg a-page-in" style={{ boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={stackInset} loginOpen={loginOpen} />
          </div>
        ))}

        {!fs && !clean && !locked && stack.length === 0 && <TabBar />}
      </div>
    </div>
  );
}

/* ============ 桌面窗口壳（Windows / macOS / Linux）============ */
function DesktopShell() {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 1100);
  useEffect(() => {
    const query = matchMedia("(max-width: 1099px)");
    const update = () => setCollapsed(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const { theater, platform } = useStore();
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas win-root plat-${platform}`}>
      <DesktopTitleBar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="relative flex-1 min-h-0">
        <ShellInner collapsed={collapsed || theater} theater={theater} />
      </div>
      {/* 边缘缩放热区只对无边框窗口（Windows / Linux）有效，macOS 走原生窗口边框 */}
      {(platform === "windows" || platform === "linux") && <ResizeHandles />}
    </div>
  );
}

function ShellInner({ collapsed, theater }: { collapsed: boolean; theater: boolean }) {
  const { stack, pop, loginOpen, setLoginOpen, tab, setTab, platform, fs, setFs, setTheater } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") {
        if (runBack()) return;
        if (fs) { setFs(false); return; }
        if (getFullscreenElement()) { void exitDocumentFullscreen().catch(() => {}); return; }
        if (stack.length) { pop(); return; }
        if (theater) { setTheater(false); return; }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        setTab((["home", "search", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen, fs, setFs, theater, setTheater]);

  const pageActive = stack.length === 0 && !loginOpen;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!theater && <DesktopRail collapsed={collapsed} />}
      <div ref={mainRef} className={`relative flex-1 min-w-0 overflow-hidden win-main ${theater ? "is-theater-main" : ""}`}>
        <MainTabs wide={wide} pageActive={pageActive} covered={stack.length > 0} bottomInset={14} />
        {stack.map((p, i) => (
          <div key={p.key} inert={i !== stack.length - 1} aria-hidden={i !== stack.length - 1 || loginOpen} className="absolute inset-0 z-30 bg-bg win-page-in" style={{ boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={14} loginOpen={loginOpen} />
          </div>
        ))}
      </div>
    </div>
  );
}

const supportsCssMax = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("top", "max(1px, 2px)");

/* ============ 移动端（无壳） ============ */
function MobileShell() {
  const { platform } = useStore();
  const minBottom = platform === "android" ? "24px" : "16px";
  const safeStyle = supportsCssMax
    ? {
        "--sat": "max(var(--native-sat, 0px), env(safe-area-inset-top, 0px), 12px)",
        "--sab": `max(var(--native-sab, 0px), env(safe-area-inset-bottom, 0px), ${minBottom})`,
        "--sal": "max(var(--native-sal, 0px), env(safe-area-inset-left, 0px))",
        "--sar": "max(var(--native-sar, 0px), env(safe-area-inset-right, 0px))",
      }
    : {
        "--sat": "var(--native-sat, 12px)",
        "--sab": `var(--native-sab, ${minBottom})`,
        "--sal": "var(--native-sal, 0px)",
        "--sar": "var(--native-sar, 0px)",
      };
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas plat-${platform}`}
      style={safeStyle as React.CSSProperties}>
      <div className="relative flex-1 min-h-0">
        <AppBody />
      </div>
    </div>
  );
}

/* ============ 入口 ============ */
export default function App() {
  const { platform, loginOpen, setLoginOpen, tab, setTab, stack, pop, fs, setFs, setClean } = useStore();
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    tracePlayback("navigation.change", { tab, stack: stack.map(p => ({ page: p.kind, key: p.key })), login_open: loginOpen });
  }, [tab, stack, loginOpen]);

/* 离开应用时暂停并卸载真实首页；每次回到前台都重新显示计算器。 */
  useEffect(() => {
    const lock = () => {
      setUnlocked(false);
      setTab("home");
      setLoginOpen(false);
      setFs(false);
      setClean(false);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") lock();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", lock);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", lock);
    };
  }, [setTab, setLoginOpen, setFs, setClean]);

  /* iOS keeps player gestures free of selection handles while inputs and reading text
     retain native selection/copy. Pointer targeting also handles non-focusable articles. */
  useEffect(() => {
    if (platform !== "ios") return;
    let last: boolean | null = null;
    const setTI = (enabled: boolean) => {
      if (last === enabled) return;
      last = enabled;
      invoke("set_text_interaction", { enabled }).catch(() => { last = null; });
    };
    const onDown = (e: Event) => setTI(isSelectableText(e.target));
    const onFocusOut = (e: FocusEvent) => {
      // A touch on an article can blur an input with relatedTarget=null after pointerdown.
      // Keep that pointer decision; the next control interaction explicitly disables selection.
      if (e.relatedTarget) setTI(isSelectableText(e.relatedTarget));
    };
    document.addEventListener("touchstart", onDown, { capture: true, passive: true });
    document.addEventListener("pointerdown", onDown, { capture: true, passive: true });
    document.addEventListener("focusin", onDown, true);
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      document.removeEventListener("touchstart", onDown, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("focusin", onDown, true);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, [platform]);

  /* —— 安卓硬件返回键 ——
     层级：面板/弹层 → 全屏 → 登录框 → 页面栈 → 回首页 → 退出应用。
     不注册这个监听，Tauri 会直接 webView.goBack() 或退出，表现就是「任意页面返回都回桌面」。 */
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    if (!unlocked) return;                                  // 伪装计算器状态不退出应用
    if (runBack()) return;                                  // 最上层弹窗/播放器面板
    if (fs) { setFs(false); return; }                        // 沉浸全屏
    if (getFullscreenElement()) { void exitDocumentFullscreen().catch(() => {}); return; }
    if (loginOpen) { setLoginOpen(false); return; }
    if (stack.length) { pop(); return; }
    if (tab !== "home") { setTab("home"); return; }
    invoke("plugin:app|exit", { code: 0 }).catch(() => {});
  };

  useEffect(() => {
    if (platform !== "android") return undefined;
    let disposed = false;
    let handle: { unregister: () => Promise<void> } | null = null;
    addPluginListener("app", "back-button", () => backRef.current())
      .then((l) => { if (disposed) l.unregister().catch(() => {}); else handle = l; })
      .catch(() => { /* 非安卓宿主忽略 */ });
    return () => {
      disposed = true;
      handle?.unregister().catch(() => {});
    };
  }, [platform]);

  useEffect(() => {
    const prevent = (e: Event) => { if (!isSelectableText(e.target)) e.preventDefault(); };
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const t = window.setTimeout(() => {
      selfTest().then((r) => { invoke("debug_log", { msg: r }).catch(() => {}); }).catch(() => {});
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  if (!unlocked) return <CalculatorGate onUnlock={() => setUnlocked(true)} />;

  return (
    <>
      {isMobile ? <MobileShell /> : <DesktopShell />}
      <LoginModal />
      <ToastHost />
    </>
  );
}
