import { Button, Input } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fmtTime } from "../../shared/api/api";
import { useSeekInput } from "./useSeekInput";
import PlaybackLock from "./PlaybackLock";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import { useInlinePlayerFullscreen } from "./useInlinePlayerFullscreen";
import "../../styles/post-player.css";
import { ICompress, IExpand, ILockF, IPauseF, IPlayF, IVol, IVolMute } from "../../shared/ui/icons";

type Props = {
  src: string;              // 原始 m3u8 地址
  scopeKey?: string | number;
  poster?: string;          // 已处理好的封面地址（本地协议）
  autoPlay?: boolean;
  active?: boolean;
  muted?: boolean;
  volume?: number;
  loop?: boolean;
  onEnded?: () => void;
  onPlaying?: () => void;
  onTogglePlay?: (playing: boolean) => void;
  onToggleMute?: () => void;
  controls?: boolean;
  className?: string;
  diagnosticContext?: Record<string, unknown>;
};

export default function Player({
  src, scopeKey, poster, autoPlay, active = true, muted = false, volume = 1, loop = false, onEnded, onPlaying,
  onTogglePlay, onToggleMute, controls = true, className = "", diagnosticContext = {},
}: Props) {
  const surfaceRef = useRef<VideoHandle>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activity = useMemo(() => ({
    play: (source: string, automatic?: boolean) => surfaceRef.current?.play(source, automatic),
    isActive: () => surfaceRef.current?.isActive() ?? active,
    isPlayWanted: () => surfaceRef.current?.isPlayWanted() ?? !!autoPlay,
  }), [active, autoPlay]);
  const { slotRef, wrapRef, host, full, fallback, toggleFull } = useInlinePlayerFullscreen({
    active, src, scopeKey, videoRef, activity,
  });
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  /* 短暂 HLS 缓冲（waiting→playing 几百毫秒内结束）不闪整屏转圈（issue #165）：
     媒体事件进入 waiting 延迟 300ms 再显示；seek/重试是用户动作，立即显示；
     退出 waiting 立即取消。 */
  const [showWaiting, setShowWaiting] = useState(false);
  const waitingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearWaitingTimer = () => { if (waitingTimer.current) { clearTimeout(waitingTimer.current); waitingTimer.current = null; } };
  const enterWaiting = (delayed: boolean) => {
    clearWaitingTimer();
    if (delayed) {
      waitingTimer.current = setTimeout(() => { waitingTimer.current = null; setShowWaiting(true); }, 300);
    } else {
      setShowWaiting(true);
    }
    setWaiting(true);
  };
  const leaveWaiting = () => { clearWaitingTimer(); setShowWaiting(false); setWaiting(false); };
  useEffect(() => clearWaitingTimer, []);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [errMsg, setErrMsg] = useState<string>("");
  const [controlsLocked, setControlsLocked] = useState(false);

  const seek = useSeekInput({
    time, duration, enabled: active && !controlsLocked, resetKey: src,
    onInteraction: (phase, input, target, pointerTarget) =>
      surfaceRef.current?.trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget }),
    onSeek: (rawTarget, input) => {
      const handle = surfaceRef.current;
      const video = videoRef.current;
      if (!handle || !video || !handle.isActive()) return;
      const dur = video.duration && Number.isFinite(video.duration) ? video.duration : 0;
      const target = dur > 0 ? Math.max(0, Math.min(dur - 0.15, rawTarget)) : Math.max(0, rawTarget);
      if (Math.abs(video.currentTime - target) > 0.01) enterWaiting(false);
      handle.seek(target, `legacy_${input}`);
      setTime(video.currentTime);
    },
  });

  const toggle = () => surfaceRef.current?.toggle();

  const retry = () => {
    if (!surfaceRef.current?.isActive()) return;
    setErrMsg("");
    enterWaiting(false);
    setPlaying(false);
    surfaceRef.current.retry();
  };

  const cycleRate = () => {
    const next = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 2 : 1;
    surfaceRef.current?.rate(next);
    setRate(next);
  };

  const pct = duration > 0 ? (seek.time / duration) * 100 : 0;

  return (
    <div ref={slotRef} className={`post-player-slot ${className}`}>
      {createPortal(<div ref={wrapRef} className="post-player relative bg-black overflow-hidden"
        data-playing={playing} data-fullscreen={full} data-fullscreen-fallback={fallback} data-scrubbing={seek.scrubbing || undefined}>
        <div className="absolute inset-0" inert={controlsLocked}>
          <VideoSurface
            ref={surfaceRef}
            videoElementRef={videoRef}
            src={src}
            poster={poster}
            autoPlay={!!autoPlay}
            active={active}
            fadeIn={false}
            muted={muted}
            volume={volume}
            rate={rate}
            loop={loop}
            diagnosticContext={{ view: "post_detail", ...diagnosticContext }}
            onClick={toggle}
            onTime={setTime}
            onDuration={setDuration}
            onPlay={() => { setPlaying(true); onTogglePlay?.(true); }}
            onPlaying={() => { setPlaying(true); leaveWaiting(); setErrMsg(""); onPlaying?.(); }}
            onPause={() => { setPlaying(false); onTogglePlay?.(false); }}
            onWaiting={() => enterWaiting(true)}
            onSeeked={() => leaveWaiting()}
            onEnded={onEnded}
            onClearError={() => { setErrMsg(""); leaveWaiting(); }}
            onError={(m) => { setErrMsg(m); leaveWaiting(); setPlaying(false); }}
          />

          {errMsg && (
            <div role="alert" className="absolute left-2 top-2 z-30 max-w-[80%] rounded bg-black/70 px-2 py-1 text-[12px] leading-tight text-red-300 break-all">
              <span>{errMsg}</span>
              <Button onClick={retry} disabled={!active} className="ml-2 px-2 py-1 text-white">重试</Button>
            </div>
          )}

          {showWaiting && !errMsg && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <Loader className="w-9 h-9 spinner" />
            </div>
          )}

          {!playing && !waiting && !errMsg && (
            <Button onClick={toggle} aria-label="播放"
              className="absolute inset-0 flex items-center justify-center">
              <span className="w-16 h-16 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center elev-2 pressable">
                <IPlayF size={26} className="text-white ml-0.5" />
              </span>
            </Button>
          )}

          {controls && (
            <div className="player-inline-controls" role="group" aria-label="播放控制">
              <div className="post-player-seek-row">
                <div className="post-player-seek-wrap">
                  {seek.scrubbing && (
                    <span className="post-player-seek-pill" style={{ left: `${Math.max(10, Math.min(90, pct))}%` }}>
                      <strong>{fmtTime(seek.time)}</strong><span> / {fmtTime(duration)}</span>
                    </span>
                  )}
                  <Input aria-label="播放进度" type="range" {...seek.inputProps}
                    className="hg-range" style={{ ...seek.inputProps.style, "--fill": `${pct}%` } as React.CSSProperties} />
                </div>
                <span className="post-player-time">{fmtTime(seek.time)} / {fmtTime(duration)}</span>
              </div>
              <div className="post-player-actions">
                <Button onClick={toggle} aria-label={playing ? "暂停" : "播放"} className="pressable">
                  {playing ? <IPauseF size={16} /> : <IPlayF size={16} />}
                </Button>
                <Button onClick={() => onToggleMute?.()} aria-label={muted ? "取消静音" : "静音"} className="pressable">
                  {muted ? <IVolMute size={16} /> : <IVol size={16} />}
                </Button>
                <Button onClick={() => setControlsLocked(true)} aria-label="锁定播放控制" title="锁定播放控制" aria-pressed={false} className="pressable">
                  <ILockF size={16} />
                </Button>
                <Button onClick={cycleRate} aria-label={`播放速度 ${rate} 倍`} className="text-[12px] font-bold text-white/85 pressable tabular-nums">{rate}x</Button>
                <Button onClick={toggleFull} aria-label={full ? "退出全屏" : "全屏"} aria-pressed={full} className="pressable">
                  {full ? <ICompress size={16} /> : <IExpand size={16} />}
                </Button>
              </div>
            </div>
          )}
        </div>
        {controlsLocked && <PlaybackLock active={active} onUnlock={() => setControlsLocked(false)} />}
      </div>, host)}
    </div>
  );
}
