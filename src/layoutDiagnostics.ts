import { logLine, platform } from "./api";
import { tracePlayback } from "./playbackDiagnostics";

/* 只测量 iOS 视口几何；探针读完立即移除，不修改页面尺寸或滚动位置。 */
export function installLayoutDiagnostics() {
  if (platform !== "ios") return;
  const n = (value: number) => Math.round(value * 100) / 100;
  const rect = (selector: string) => {
    const r = document.querySelector(selector)?.getBoundingClientRect();
    return r ? { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) } : null;
  };
  let last = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sample = (reason: string) => {
    if (!document.body || document.visibilityState !== "visible") return;
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:0;bottom:0;left:0;width:0;box-sizing:border-box;visibility:hidden;pointer-events:none;contain:strict;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.appendChild(probe);
    try {
      const css = getComputedStyle(probe);
      const safeArea = { top: n(parseFloat(css.paddingTop)), right: n(parseFloat(css.paddingRight)), bottom: n(parseFloat(css.paddingBottom)), left: n(parseFloat(css.paddingLeft)) };
      const fixed = n(probe.getBoundingClientRect().height);
      probe.style.bottom = "auto";
      probe.style.height = "100vh";
      const vh = n(probe.getBoundingClientRect().height);
      probe.style.height = "100dvh";
      const dvh = n(probe.getBoundingClientRect().height);
      const vv = window.visualViewport;
      const data = {
        screen: { width: screen.width, height: screen.height, available_width: screen.availWidth, available_height: screen.availHeight, angle: screen.orientation?.angle ?? 0 },
        window: { width: innerWidth, height: innerHeight, outer_width: outerWidth, outer_height: outerHeight, dpr: devicePixelRatio, scroll_x: n(scrollX), scroll_y: n(scrollY) },
        visual_viewport: vv ? { width: n(vv.width), height: n(vv.height), offset_top: n(vv.offsetTop), offset_left: n(vv.offsetLeft), page_top: n(vv.pageTop), page_left: n(vv.pageLeft), scale: n(vv.scale) } : null,
        rects: { html: rect("html"), body: rect("body"), root: rect("#root"), shell: rect(".plat-ios") },
        safe_area: safeArea, probes: { fixed, vh, dvh },
      };
      const serialized = JSON.stringify(data);
      if (serialized === last) return;
      last = serialized;
      void logLine(`[layout] reason=${reason} ${serialized}`);
      tracePlayback("app.layout", { reason, ...data });
    } finally { probe.remove(); }
  };
  const schedule = (reason: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => requestAnimationFrame(() => sample(reason)), 80);
  };
  requestAnimationFrame(() => sample("startup"));
  setTimeout(() => schedule("startup.300ms"), 300);
  setTimeout(() => schedule("startup.1200ms"), 1200);
  window.addEventListener("resize", () => schedule("resize"));
  window.visualViewport?.addEventListener("resize", () => schedule("visualViewport.resize"));
  window.addEventListener("orientationchange", () => schedule("orientationchange"));
  window.addEventListener("pageshow", () => schedule("pageshow"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") schedule("visible");
  });
}
