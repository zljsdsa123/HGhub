import { Button } from "./ios/controls";
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore, type Tab } from "../store";
import { APP_VERSION } from "../api";
import { Avatar } from "./ui";
import {
  IClose, IGrid, IGridF, IHome, IHomeF, IMinus, IMoon, IRestore, ISearch, ISettings, ISidebar,
  ISquare, ISun, ITrophy, IUser, IUserF, Logo,
} from "../icons";

const appWindow = () => getCurrentWindow();

export function DesktopTitleBar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { theme, setTheme, setTab, platform } = useStore();
  const [maxed, setMaxed] = useState(false);
  /* macOS 原生全屏：红绿灯被系统隐藏，标题栏左侧 84px 让位要收回（见 index.css） */
  const [nativeFs, setNativeFs] = useState(false);

  useEffect(() => {
    let un: (() => void) | undefined;
    const sync = () => {
      appWindow().isMaximized().then(setMaxed).catch(() => {});
      appWindow().isFullscreen().then(setNativeFs).catch(() => {});
    };
    sync();
    appWindow().onResized(sync)
      .then((f: () => void) => { un = f; }).catch(() => {});
    return () => { un?.(); };
  }, []);

  return (
    <header className={`win-titlebar ${nativeFs ? "is-native-fs" : ""}`} data-tauri-drag-region
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button")) appWindow().toggleMaximize().catch(() => {}); }}>
      <div className="win-wordmark" data-tauri-drag-region>
        <Logo size={24} />
        <span>HG<span className="win-wordmark-light">hub</span>X</span>
      </div>
      <Button className="win-caption-tool" aria-label={collapsed ? "展开侧栏" : "收起侧栏"} onClick={onToggle}>
        <ISidebar size={17} strokeWidth={1.7} />
      </Button>
      <div className="win-drag-region" data-tauri-drag-region />
      <Button className="win-caption-tool" aria-label="切换外观" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        {theme === "dark" ? <ISun size={17} strokeWidth={1.7} /> : <IMoon size={17} strokeWidth={1.7} />}
      </Button>
      <Button className="win-caption-tool" aria-label="搜索" onClick={() => setTab("search")}>
        <ISearch size={17} strokeWidth={1.7} />
      </Button>
      {/* macOS 用系统自带的红绿灯（titleBarStyle: Overlay），不画自绘按钮 */}
      {platform !== "macos" && (
        <div className="win-caption-buttons">
          <Button aria-label="最小化" onClick={() => appWindow().minimize().catch(() => {})}><IMinus size={15} strokeWidth={1.5} /></Button>
          <Button aria-label={maxed ? "还原" : "最大化"} onClick={() => appWindow().toggleMaximize().catch(() => {})}>
            {maxed ? <IRestore size={14} strokeWidth={1.5} /> : <ISquare size={14} strokeWidth={1.5} />}
          </Button>
          <Button className="win-close" aria-label="关闭" onClick={() => appWindow().close().catch(() => {})}><IClose size={16} strokeWidth={1.5} /></Button>
        </div>
      )}
    </header>
  );
}

export function DesktopRail({ collapsed }: { collapsed: boolean }) {
  const { tab, setTab, user, setLoginOpen, push, platform, stack } = useStore();
  /* 从侧栏进入的栈页（排行榜 / 设置）接管高亮，否则「我的」会一直亮着，看起来不像独立页面 */
  const top = stack[stack.length - 1];
  const railPage: "ranks" | "settings" | null =
    top?.kind === "settings" ? "settings" : top?.kind === "ranks" ? "ranks" : null;
  const onTab = (key: Tab | "search") => !railPage && tab === key;
  const items: { key: Tab; label: string; Icon: typeof IHome; Filled: typeof IHomeF }[] = [
    { key: "home", label: "首页", Icon: IHome, Filled: IHomeF },
    { key: "category", label: "分类", Icon: IGrid, Filled: IGridF },
    { key: "profile", label: "我的", Icon: IUser, Filled: IUserF },
  ];
  return (
    <nav className={`win-sidebar ${collapsed ? "is-compact" : ""}`} aria-label="主导航">
      <div className="win-sidebar-inner">
        <Button className={`win-search-launch ${onTab("search") ? "is-selected" : ""}`}
          onClick={() => setTab("search")} aria-label="搜索">
          <ISearch size={19} strokeWidth={1.7} />
          <span className="win-nav-copy">搜索你感兴趣的</span>
          <kbd className="win-nav-key">/</kbd>
        </Button>
        <div className="win-nav-items">
          {items.map(({ key, label, Icon, Filled }) => (
            <Button key={key} aria-label={label} aria-current={onTab(key) ? "page" : undefined}
              className={`win-nav-item ${onTab(key) ? "is-selected" : ""}`}
              onClick={() => setTab(key)}>
              <span className="win-nav-symbol">{onTab(key) ? <Filled size={21} /> : <Icon size={21} strokeWidth={1.7} />}</span>
              <span className="win-nav-copy">{label}</span>
            </Button>
          ))}
          <Button aria-label="排行榜" className={`win-nav-item ${railPage === "ranks" ? "is-selected" : ""}`}
            aria-current={railPage === "ranks" ? "page" : undefined}
            onClick={() => { if (railPage !== "ranks") push({ kind: "ranks" }); }}>
            <span className="win-nav-symbol"><ITrophy size={21} strokeWidth={1.7} /></span>
            <span className="win-nav-copy">排行榜</span>
          </Button>
          <Button aria-label="设置" className={`win-nav-item ${railPage === "settings" ? "is-selected" : ""}`}
            aria-current={railPage === "settings" ? "page" : undefined}
            onClick={() => { if (railPage !== "settings") push({ kind: "settings" }); }}>
            <span className="win-nav-symbol"><ISettings size={21} strokeWidth={1.7} /></span>
            <span className="win-nav-copy">设置</span>
          </Button>
        </div>
        <div className="win-sidebar-bottom">
          <Button aria-label="账号与个人中心" className="win-account" onClick={() => { setTab("profile"); if (!user) setLoginOpen(true); }}>
            <Avatar size={34} hue={220} name={user?.nickname} icon={user ? undefined : <IUser size={17} />} />
            <span className="win-account-copy">
              <strong>{user?.nickname || "登录 HGhubX"}</strong>
              <small>{user ? "你的精彩，都在这里" : "留住每一次心动"}</small>
            </span>
          </Button>
          <span className="win-sidebar-version">HGhubX for {platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} {APP_VERSION}</span>
        </div>
      </div>
    </nav>
  );
}
