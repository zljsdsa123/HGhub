import { markStartupReady } from "./legacyRuntime";
import React, { lazy, Suspense, useCallback, useLayoutEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import StartupGate from "./app/startup/LaunchAnimation";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";
import { initPlaybackLog, installPlaybackPageEvents, tracePlayback } from "./shared/diagnostics/playbackDiagnostics";
import { APP_VERSION, LOCAL, logLine, platform, webviewVersion } from "./shared/api/api";
import { installLayoutDiagnostics } from "./shared/diagnostics/layoutDiagnostics";
import { hasAcceptedAgreement } from "./shared/storage/usageAgreement";

const loadAcceptedApp = () => import("./app/AcceptedApp");
const AcceptedApp = lazy(loadAcceptedApp);

installPlaybackPageEvents();

/* 运行期错误统一落到 debug.log，便于自查 */
function report(kind: string, msg: string) {
  invoke("debug_log", { msg: `[${kind}] ${msg}` }).catch(() => {});
  tracePlayback(`app.${kind}`, { detail: msg });
}
window.addEventListener("error", (e) => {
  report("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  report("reject", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

let bootDiagnosticsStarted = false;
function scheduleBootDiagnostics() {
  if (bootDiagnosticsStarted) return;
  bootDiagnosticsStarted = true;
  window.requestAnimationFrame(() => {
    void initPlaybackLog();
    const hasMediaSource = "MediaSource" in window || "ManagedMediaSource" in window;
    /* 环境指纹：写进始终记录的 debug.log。用户复制诊断时不用再自报版本、平台、内核版本 */
    logLine(
      `[env] ver=${APP_VERSION} platform=${platform} webview=${webviewVersion} ` +
        `engine=${hasMediaSource ? "hls.js" : "native"} ` +
        `mss=${"MediaSource" in window ? "y" : "n"} media=${LOCAL} ` +
        `screen=${screen.width}x${screen.height} dpr=${devicePixelRatio} lang=${navigator.language}`,
    );
    /* 环境指纹也进结构化日志（开诊断后不会只有一行空跑） */
    tracePlayback("app.env", {
      ver: APP_VERSION, platform, webview: webviewVersion,
      engine: hasMediaSource ? "hls.js" : "native",
      media_source: "MediaSource" in window, managed_media_source: "ManagedMediaSource" in window,
      media_scheme: LOCAL.split(":")[0], screen: `${screen.width}x${screen.height}`,
      dpr: devicePixelRatio, lang: navigator.language,
    });
    installLayoutDiagnostics();
  });
}

function AcceptedAppHost({ onReady }: { onReady: () => void }) {
  useLayoutEffect(onReady, [onReady]);
  return <AcceptedApp />;
}

/* iOS 底部留白：改用 CSS 100dvh（见 index.css）动态跟踪可视高度。
   不再用 JS 在启动时钉死 html 高度——启动瞬间 visualViewport.height 尚未
   完成布局，抓到错误值会把 html 高度锁死，正是「底部留白、旋转一次才恢复」的根因。 */

/** index.html 的 ES5 启动看门狗在首个成功 commit 后解除；协议签署可以慢慢来。 */
function StartupReady() {
  const [contentReady, setContentReady] = useState(false);
  const markContentReady = useCallback(() => setContentReady(true), []);
  React.useEffect(() => {
    markStartupReady();
    scheduleBootDiagnostics();
  }, []);
  return (
    <StartupGate contentReady={contentReady}>
      <Suspense fallback={null}>
        <AcceptedAppHost onReady={markContentReady} />
      </Suspense>
    </StartupGate>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StartupReady />
  </React.StrictMode>,
);
// 已签署协议的冷启动：在首帧提交后并行预热业务入口 chunk，不阻塞启动动画首帧上屏。
if (hasAcceptedAgreement()) void loadAcceptedApp();
