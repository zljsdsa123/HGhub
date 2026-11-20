import { startTransition, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { addPluginListener } from "@tauri-apps/api/core";
import { platform } from "../../shared/api/api";
import "../../styles/launch.css";
import UsageAgreement from "../../shared/ui/UsageAgreement";
import { hasAcceptedAgreement } from "../../shared/storage/usageAgreement";
import { holdBackForStartup, type RegisterStartupBack } from "../../shared/lib/back";

// One reveal per WebView lifetime, including StrictMode and subsequent App remounts.
let launchCompleted = false;
export const LAUNCH_DURATION = 1120;
const LAUNCH_EXIT_MS = 220;
const LAUNCH_MAX_HOLD = 2200;
export type { RegisterStartupBack };

/** Release index.html's #071218 launch lock right before cross-fading to the live surface. */
function releaseLaunchSurface() {
  const root = document.documentElement;
  if (!root.hasAttribute("data-hg-launching")) return;
  root.removeAttribute("data-hg-launching");
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = root.classList.contains("theme-light") ? "#eeece7" : "#121212";
}

/** Exact hghubx.svg geometry split into independent GPU-composited outer layers. */
export function LaunchAnimation({
  onFinish,
  onExitStart,
  contentReady = true,
  registerBack,
}: {
  onFinish: () => void;
  onExitStart?: () => void;
  contentReady?: boolean;
  registerBack?: RegisterStartupBack;
}) {
  const gradient = useId();
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  const exitStartRef = useRef(onExitStart);
  exitStartRef.current = onExitStart;
  const complete = useRef(false);
  const exitStarted = useRef(false);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [entranceDone, setEntranceDone] = useState(false);
  const [forceReady, setForceReady] = useState(false);
  const [exiting, setExiting] = useState(false);

  const finish = useCallback(() => {
    if (complete.current) return;
    complete.current = true;
    releaseLaunchSurface();
    finishRef.current();
  }, []);

  const beginExit = useCallback(() => {
    if (complete.current || exitStarted.current) return;
    exitStarted.current = true;
    releaseLaunchSurface();
    exitStartRef.current?.();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    setExiting(true);
  }, [finish]);

  useEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const entranceTimer = window.setTimeout(() => setEntranceDone(true), motion.matches ? 120 : LAUNCH_DURATION);
    const maxHoldTimer = window.setTimeout(() => setForceReady(true), motion.matches ? 500 : LAUNCH_MAX_HOLD);
    const onMotion = () => {
      if (motion.matches) {
        setReducedMotion(true);
        setEntranceDone(true);
      }
    };
    const onHidden = () => { if (document.visibilityState === "hidden") finish(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(); }
    };
    motion.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", onHidden);
    if (!registerBack) window.addEventListener("keydown", onKey, true);
    onHidden();
    return () => {
      window.clearTimeout(entranceTimer);
      window.clearTimeout(maxHoldTimer);
      motion.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [finish, registerBack]);

  useEffect(() => {
    if (!entranceDone || (!contentReady && !forceReady)) return;
    if (reducedMotion) finish();
    else beginExit();
  }, [entranceDone, contentReady, forceReady, reducedMotion, beginExit, finish]);

  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(finish, LAUNCH_EXIT_MS + 80);
    return () => window.clearTimeout(timer);
  }, [exiting, finish]);

  useEffect(() => {
    if (registerBack) return registerBack(finish);
    if (platform !== "android") return;
    let disposed = false;
    let listener: { unregister: () => Promise<void> } | undefined;
    void addPluginListener("app", "back-button", finish).then(handle => {
      if (disposed) void handle.unregister().catch(() => {});
      else listener = handle;
    }).catch(() => {});
    return () => { disposed = true; void listener?.unregister().catch(() => {}); };
  }, [finish, registerBack]);

  return <div className={exiting ? "hg-launch is-exiting" : "hg-launch"} role="dialog" aria-modal="true" aria-label="HGhubX 启动动画"
    onAnimationEnd={event => { if (event.target === event.currentTarget && event.animationName === "launch-exit") finish(); }}>
    <div className="hg-launch-stage" aria-hidden="true">
      <div className="hg-launch-halo" />
      <div className="hg-launch-mark">
        <svg className="hg-launch-svg hg-launch-tile-layer" viewBox="0 0 64 64" fill="none">
          <defs><linearGradient id={gradient} x1="4" y1="0" x2="60" y2="64" gradientUnits="userSpaceOnUse">
            <stop stopColor="#06465b" /><stop offset="1" stopColor="#002837" />
          </linearGradient></defs>
          <rect width="64" height="64" rx="17.455" fill={`url(#${gradient})`} />
          <rect x=".65" y=".65" width="62.7" height="62.7" rx="16.8" stroke="#60cdff" strokeOpacity=".16" strokeWidth=".8" />
        </svg>
        <svg className="hg-launch-svg hg-launch-glyph-layer" viewBox="0 0 64 64" fill="none">
          <g transform="translate(-2.909091 -2.909091) scale(1.4545455)" stroke="#60cdff" strokeLinecap="round">
            <path d="M14 13v22" strokeWidth="4.4" />
            <path d="M14 24h10" strokeWidth="4.4" />
            <path d="M24 13v22" strokeWidth="4.4" />
            <path d="M31 17.5c3.2 0 5.5 2.6 5.5 6.5S34.2 30.5 31 30.5" strokeWidth="4" />
          </g>
        </svg>
        <svg className="hg-launch-svg hg-launch-accent-layer" viewBox="0 0 64 64" fill="none">
          <path d="M40 27.2 46.3 31.9 40 36.6Z" fill="#b1f5dc" />
          <path d="M46.7 11.3 52.5 17.1M52.5 11.3 46.7 17.1" stroke="#b1f5dc" strokeWidth="2.9" strokeLinecap="round" />
        </svg>
        <div className="hg-launch-sheen-clip"><div className="hg-launch-sheen" /></div>
      </div>
      <div className="hg-launch-wordmark"><span>HGhub</span><span className="hg-launch-word-x">X</span></div>
    </div>
  </div>;
}

/** 首次使用：启动动画退场时垫入协议卡片，签署前不挂载任何业务内容。
 *  已同意过协议的用户：首帧先独占提交启动动画到合成线程，下一帧再并发挂载 App，
 *  待动画完成且底层界面就绪后平滑淡出，彻底消除首尾闪烁与主线程抢占掉帧。 */
export default function StartupGate({
  children,
  contentReady = true,
  registerBack,
}: {
  children: ReactNode;
  contentReady?: boolean;
  registerBack?: RegisterStartupBack;
}) {
  const [finished, setFinished] = useState(() => launchCompleted);
  const [agreed, setAgreed] = useState(() => hasAcceptedAgreement());
  const [mountChildren, setMountChildren] = useState(() => launchCompleted);
  const [showAgreement, setShowAgreement] = useState(() => launchCompleted);

  const finish = useCallback(() => {
    launchCompleted = true;
    releaseLaunchSurface();
    setShowAgreement(true);
    setMountChildren(true);
    setFinished(true);
  }, []);

  useLayoutEffect(() => {
    if (finished) releaseLaunchSurface();
  }, [finished]);

  useEffect(() => {
    if (!agreed || finished || mountChildren) return;
    const frame = window.requestAnimationFrame(() => {
      startTransition(() => setMountChildren(true));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [agreed, finished, mountChildren]);

  // Overlay branch only: while the reveal covers the already-mounted App, back
  // belongs to the animation (skip it); runBack() must not navigate beneath it.
  // Released on overlay unmount; StrictMode-safe via the idempotent release.
  useEffect(() => (agreed && !finished ? holdBackForStartup() : undefined), [agreed, finished]);

  if (!agreed) {
    return (
      <>
        {(finished || showAgreement) && (
          <UsageAgreement active={finished} onAccept={() => { setMountChildren(true); setAgreed(true); }} registerBack={registerBack} />
        )}
        {!finished && (
          <LaunchAnimation
            onFinish={finish}
            onExitStart={() => setShowAgreement(true)}
            contentReady
            registerBack={registerBack}
          />
        )}
      </>
    );
  }
  return (
    <>
      {(finished || mountChildren) && children}
      {!finished && <LaunchAnimation onFinish={finish} contentReady={contentReady} registerBack={registerBack} />}
    </>
  );
}
