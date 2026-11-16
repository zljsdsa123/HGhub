import { invoke } from "@tauri-apps/api/core";
import { LOCAL, platform, playlist } from "./api";

type PlaybackSource = { engine: "hls.js" | "native"; url: string; route: string };

/** Only our own media routes carry a wrapped upstream URL. An upstream ?u= is opaque. */
export function playbackSource(src: string, hlsSupported: boolean): PlaybackSource {
  let route = "";
  let direct = false;
  try {
    const source = new URL(src);
    if (source.href.startsWith(`${LOCAL}/`) && (source.pathname === "/hls" || source.pathname === "/seg")) {
      route = `${source.pathname}${source.search}${source.hash}`;
      direct = source.pathname === "/seg";
    }
  } catch { /* An unwrapped source is passed intact to the playlist route. */ }
  const url = route ? `${LOCAL}${route}` : playlist(src);
  if (!route) route = url.slice(LOCAL.length);
  return { engine: hlsSupported && !direct ? "hls.js" : "native", url, route };
}

/** Native AVFoundation cannot fetch WKURLSchemeHandler's hg:// resources. */
export function connectNativeMedia(video: HTMLVideoElement, source: PlaybackSource, callbacks: {
  isCurrent: () => boolean;
  onReady: () => void;
  onError: (message: string) => void;
}) {
  let disposed = false;
  const current = () => !disposed && callbacks.isCurrent();
  const clear = () => {
    video.pause();
    video.removeAttribute("src");
    video.load();
  };
  clear();
  const attach = (url: string) => {
    if (!current()) return;
    video.src = url;
    callbacks.onReady();
  };
  if (platform === "ios") {
    // Ask only when native playback needs it. Each attempt can retry a failed server start.
    void invoke<string>("media_http_origin").then(origin => {
      if (!current()) return;
      const parsed = new URL(origin);
      if (!parsed.port || !parsed.href.startsWith(`http://127.0.0.1:${parsed.port}/`)
        || parsed.pathname === "/" || parsed.search || parsed.hash) {
        throw new Error("Invalid local media origin");
      }
      attach(`${origin.replace(/\/$/, "")}${source.route}`);
    }).catch(() => {
      if (current()) callbacks.onError("本地媒体服务启动失败，请切换视频或重试");
    });
  } else attach(source.url);
  return () => {
    disposed = true;
    clear();
  };
}
