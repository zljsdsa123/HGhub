import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { addPluginListener } from "@tauri-apps/api/core";
import { platform } from "../api";
import "../styles/launch.css";
import UsageAgreement from "./UsageAgreement";
import { hasAcceptedAgreement } from "../usageAgreement";

// One reveal per WebView lifetime, including StrictMode and subsequent App remounts.
let launchCompleted = false;
export const LAUNCH_DURATION = 2200;

/** Exact public/logo.svg geometry, split into independent spring-animated strokes. */
export function LaunchAnimation({ onFinish }: { onFinish: () => void }) {
  const gradient = useId();
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  const complete = useRef(false);
  const finish = useCallback(() => {
    if (complete.current) return;
    complete.current = true;
    finishRef.current();
  }, []);

  useEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const timer = window.setTimeout(finish, motion.matches ? 200 : LAUNCH_DURATION + 120);
    const onMotion = () => { if (motion.matches) finish(); };
    const onHidden = () => { if (document.visibilityState === "hidden") finish(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(); }
    };
    motion.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("keydown", onKey, true);
    onHidden();
    return () => {
      window.clearTimeout(timer);
      motion.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [finish]);

  useEffect(() => {
    if (platform !== "android") return;
    let disposed = false;
    let listener: { unregister: () => Promise<void> } | undefined;
    void addPluginListener("app", "back-button", finish).then(handle => {
      if (disposed) void handle.unregister().catch(() => {});
      else listener = handle;
    }).catch(() => {});
    return () => { disposed = true; void listener?.unregister().catch(() => {}); };
  }, [finish]);

  return <div className="hg-launch" role="dialog" aria-modal="true" aria-label="HGhubX 启动动画"
    onAnimationEnd={event => { if (event.target === event.currentTarget && event.animationName === "launch-exit") finish(); }}>
    <div className="hg-launch-stage" aria-hidden="true">
      <div className="hg-launch-orbit" />
      <div className="hg-launch-mark">
        <svg className="hg-launch-svg" viewBox="0 0 64 64" fill="none">
          <defs><linearGradient id={gradient} x1="4" y1="0" x2="60" y2="64" gradientUnits="userSpaceOnUse">
            <stop stopColor="#06465b" /><stop offset="1" stopColor="#002837" />
          </linearGradient></defs>
          <g className="hg-launch-tile">
            <rect width="64" height="64" rx="17.455" fill={`url(#${gradient})`} />
            <rect x=".65" y=".65" width="62.7" height="62.7" rx="16.8" stroke="#60cdff" strokeOpacity=".14" strokeWidth=".8" />
          </g>
          <g transform="translate(-2.909091 -2.909091) scale(1.4545455)" stroke="#60cdff" strokeLinecap="round">
            <path className="hg-launch-stroke hg-launch-left" d="M14 13v22" strokeWidth="4.4" />
            <path className="hg-launch-stroke hg-launch-bridge" d="M14 24h10" strokeWidth="4.4" />
            <path className="hg-launch-stroke hg-launch-right" d="M24 13v22" strokeWidth="4.4" />
            <path className="hg-launch-stroke hg-launch-arc" d="M31 17.5c3.2 0 5.5 2.6 5.5 6.5S34.2 30.5 31 30.5" strokeWidth="4" />
          </g>
          <path className="hg-launch-play" d="M40 27.2 46.3 31.9 40 36.6Z" fill="#b1f5dc" />
          <path className="hg-launch-x" d="M46.7 11.3 52.5 17.1M52.5 11.3 46.7 17.1" stroke="#b1f5dc" strokeWidth="2.9" strokeLinecap="round" />
        </svg>
      </div>
      <div className="hg-launch-wordmark"><span>HGhub</span><span className="hg-launch-word-x">X</span></div>
    </div>
    <span className="hg-launch-footnote" aria-hidden="true">PRESS PLAY. FEEL MORE.</span>
  </div>;
}

/** Children mount only after the reveal and an explicitly accepted current agreement. */
export default function StartupGate({ children }: { children: ReactNode }) {
  const [finished, setFinished] = useState(() => launchCompleted);
  const [agreed, setAgreed] = useState(() => hasAcceptedAgreement());
  const finish = useCallback(() => { launchCompleted = true; setFinished(true); }, []);
  if (!finished) return <LaunchAnimation onFinish={finish} />;
  if (!agreed) return <UsageAgreement onAccept={() => setAgreed(true)} />;
  return children;
}
