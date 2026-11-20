import Hls, { type ErrorData } from "hls.js";

/** A bounded recovery queue shared by the feed and inline post player. */
export function createHlsRecovery({ hls, video, url, isCurrent, isActive, resumePlayback, onFatal }: {
  hls: Hls;
  video: HTMLVideoElement;
  url: string;
  isCurrent: () => boolean;
  isActive: () => boolean;
  resumePlayback: () => void;
  onFatal: (data: ErrorData) => void;
}) {
  let attempts = 0;
  let timer: number | undefined;
  let pending: ErrorData | undefined;
  let disposed = false;

  const cancelTimer = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (disposed || !isCurrent() || !isActive() || !pending || timer !== undefined) return;
    if (attempts >= 4) {
      const data = pending;
      pending = undefined;
      onFatal(data);
      return;
    }
    timer = window.setTimeout(() => {
      timer = undefined;
      // A covered page keeps its pending recovery, but does not start requests.
      if (disposed || !isCurrent() || !isActive() || !pending) return;
      const data = pending;
      pending = undefined;
      attempts += 1;
      try {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
            || data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT) {
            // startLoad cannot refetch a manifest that never produced levels.
            hls.loadSource(url);
          } else {
            hls.startLoad(video.currentTime || -1);
          }
        } else {
          const time = video.currentTime || 0;
          hls.recoverMediaError();
          // autoStartLoad=false also applies when recovering at time zero.
          // Detaching MSE can synchronously reset the element's clock.
          hls.startLoad(time);
          resumePlayback();
        }
      } catch {
        pending = data;
        schedule();
      }
    }, 250 * (attempts + 1));
  };

  return {
    error(data: ErrorData) {
      // hls.js already applies its own backoff to recoverable errors.
      if (!data.fatal || disposed || !isCurrent()) return;
      cancelTimer();
      if (data.type !== Hls.ErrorTypes.NETWORK_ERROR && data.type !== Hls.ErrorTypes.MEDIA_ERROR) {
        pending = undefined;
        onFatal(data);
        return;
      }
      pending = data;
      schedule();
    },
    buffered() {
      attempts = 0;
      pending = undefined;
      cancelTimer();
    },
    activityChanged() {
      if (!isActive()) cancelTimer();
      else schedule();
    },
    dispose() {
      disposed = true;
      pending = undefined;
      cancelTimer();
    },
  };
}

export type HlsRecovery = ReturnType<typeof createHlsRecovery>;
