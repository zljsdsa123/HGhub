import { lazy, Suspense, type Dispatch, type MutableRefObject, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from "react";
import { Button, SegmentedControl } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { fmtTime } from "../../shared/api/api";
import type { Episode, Post, VideoCard } from "../../shared/api/types";
import type { PageInput, Toast } from "../../shared/model/store";
import { Sheet } from "../../shared/ui/ui";
import { PlaybackProgress, PlaybackTime, PlayerControls, type PlaybackClock, type VideoHandle } from "../playback";
import type { FeedMeta } from "./useFeedActions";
import type { FeedPanel } from "./useFeedViewport";
import { PlaybackSettingsPanel } from "./PlaybackSettingsPanel";
import { PanelSwipeArea } from "./PanelSwipeArea";
import {
  IBoltF, IClose, ICompress, IPauseF, IPlayF, ISearch,
} from "../../shared/ui/icons";

const VideoDetailsPanel = lazy(() => import("./VideoDetailsPanel"));
const EpisodesPanel = lazy(() => import("./Panels").then(m => ({ default: m.EpisodesPanel })));
const CommentsPanel = lazy(() => import("./Panels").then(m => ({ default: m.CommentsPanel })));
const ArticlePanel = lazy(() => import("./Panels").then(m => ({ default: m.ArticlePanel })));

function PanelFallback() {
  return <div className="flex-1 grid place-items-center py-10"><Loader className="w-6 h-6 spinner" /></div>;
}

type Props = {
  videoRef: RefObject<VideoHandle | null>;
  speedLockTargetRef: RefObject<HTMLButtonElement | null>;
  barRef: MutableRefObject<HTMLDivElement | null>;
  playbackClock: PlaybackClock;
  isDesktop: boolean;
  active: boolean;
  fs: boolean;
  clean: boolean;
  idle: boolean;
  rotated: boolean;
  vpLandscape: boolean;
  theater: boolean;
  setTheater: Dispatch<SetStateAction<boolean>>;
  fullscreen: boolean;
  controlsLocked: boolean;
  paused: boolean;
  duration: number;
  rate: number;
  setRate: Dispatch<SetStateAction<number>>;
  effRate: number;
  holdSpeed: number;
  holdSlow: boolean;
  speedLock: number;
  setSpeedLock: Dispatch<SetStateAction<number>>;
  lockArmed: boolean;
  muted: boolean;
  setMuted: Dispatch<SetStateAction<boolean>>;
  volume: number;
  setVolume: (v: number) => void;
  swipeEp: boolean;
  setSwipeEp: (v: boolean) => void;
  preferHevc: boolean;
  setPreferHevc: (v: boolean) => void;
  portraitFit: "contain" | "cover";
  setPortraitFit: Dispatch<SetStateAction<"contain" | "cover">>;
  playKey: string;
  curId: number;
  curEp: number;
  index: number;
  effectiveLength: number;
  kind: "video" | "post";
  meta: FeedMeta;
  likeCount: number;
  collectCount: number;
  episodes: Episode[];
  related: VideoCard[];
  follows: number[];
  followPending: boolean;
  post?: Post;
  articleHtml: string;
  panel: FeedPanel;
  setPanel: Dispatch<SetStateAction<FeedPanel>>;
  scrub: { pct: number; target: number } | null;
  barPct: number | null;
  onBarDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onBarMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onBarUp: (e: ReactPointerEvent<HTMLDivElement>, cancelled?: boolean) => void;
  pickEp: (ep: number) => void;
  go: (delta: number) => void;
  togglePip: () => Promise<void>;
  lockControls: () => void;
  toggleFull: () => void;
  exitFs: () => void;
  onFollow: () => Promise<void>;
  openTag: (tag: string) => void;
  openTagMenu: (selected?: string[]) => void;
  closePanels: () => void;
  pushPage: (page: PageInput) => void;
  toast: (msg: string, icon?: Toast["icon"]) => void;
};

export function FeedPlayerShellChrome({
  videoRef, speedLockTargetRef, barRef, playbackClock,
  isDesktop, active, fs, idle, rotated, vpLandscape, theater, setTheater, fullscreen, controlsLocked,
  paused, duration, rate, setRate, effRate, holdSpeed, holdSlow, speedLock, setSpeedLock, lockArmed,
  muted, setMuted, volume, setVolume, swipeEp, setSwipeEp, preferHevc, setPreferHevc, portraitFit, setPortraitFit,
  playKey, curId, curEp, index, effectiveLength, kind, meta, likeCount, collectCount, episodes, related,
  follows, followPending, post, articleHtml, panel, setPanel,
  scrub, barPct, onBarDown, onBarMove, onBarUp,
  pickEp, go, togglePip, lockControls, toggleFull, exitFs,
  onFollow, openTag, openTagMenu, closePanels, pushPage, toast,
}: Omit<Props, "clean">) {
  const liveMeta = { ...meta, like: likeCount, collect: collectCount };
  const landscapeStage = rotated || vpLandscape;
  const edgePad = landscapeStage ? 24 : 16;
  const fsSafeLeft = rotated ? `calc(var(--sat, 0px) + ${edgePad}px)` : `calc(var(--sal, 0px) + ${edgePad}px)`;
  const fsSafeRight = rotated ? `calc(var(--sab, 0px) + ${edgePad}px)` : `calc(var(--sar, 0px) + ${edgePad}px)`;
  const activePct = barPct ?? (scrub ? scrub.pct / 100 : null);
  const scrubbing = activePct !== null;
  const detailBody = (onClose?: () => void) => (
    <VideoDetailsPanel meta={liveMeta} videoId={curId} episodeCount={episodes.length}
      related={related} following={follows.includes(meta.authorId)} followPending={followPending}
      onFollow={() => void onFollow()} onTag={openTag} onBlockTag={tag => openTagMenu([tag])} onClose={onClose}
      onAuthor={() => { if (meta.authorId > 0) { closePanels(); pushPage({ kind: "user", id: meta.authorId, name: meta.author }); } }}
      onRelated={(video, visible) => { closePanels(); pushPage({ kind: "feed", videoIds: visible.map(item => item.id), index: visible.findIndex(item => item.id === video.id), title: "相关推荐" }); }} />
  );

  return (
    <>
      {/* 桌面控制条 */}
      {isDesktop && (
        <PlayerControls
          paused={paused} duration={duration} rate={rate}
          clock={playbackClock}
          muted={muted} volume={volume} theater={theater} fullscreen={fullscreen}
          visible={active && !idle}
          seekEnabled={active && !controlsLocked}
          seekKey={playKey}
          dockInset={panel ? 372 : 0}
          nextDisabled={!episodes.some((e) => e.ep_num === curEp + 1) && index >= effectiveLength - 1}
          nextTitle={episodes.some((e) => e.ep_num === curEp + 1) ? (swipeEp ? "下一集 ↓" : "下一集") : "下一部 ↓"}
          swipeEp={swipeEp}
          onToggleSwipe={() => { setSwipeEp(!swipeEp); toast(swipeEp ? "上下划切集已关闭" : "上下划切集已开启"); }}
          onToggle={() => videoRef.current?.toggle()}
          onSeek={(t, source) => { videoRef.current?.seek(t, source); playbackClock.publish(t); }}
          onSeekInteraction={(phase, input, target, pointerTarget) => videoRef.current?.trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget })}
          onRate={(r) => { setRate(r); videoRef.current?.rate(r); }}
          onMute={() => setMuted((m) => !m)}
          onVolume={(v) => setVolume(v)}
          onPip={togglePip}
          onLock={lockControls}
          onTheater={() => setTheater((v) => !v)}
          onFullscreen={toggleFull}
          onNext={() => {
            const nx = episodes.find((e) => e.ep_num === curEp + 1);
            if (nx) pickEp(nx.ep_num);
            else go(1);
          }}
        />
      )}

      {/* 移动端：倍速状态胶囊，也是长按锁定的真实命中目标（isOverSpeedLock）。 */}
      {!isDesktop && (holdSpeed || holdSlow || speedLock || rate !== 1) && (holdSpeed || holdSlow || !fs || !idle) && (
        <Button
          ref={speedLockTargetRef}
          onClick={() => {
            if (speedLock) { setSpeedLock(0); toast("已解除倍速锁定", "info"); }
            else if (rate !== 1 && !holdSpeed) setRate(1);
          }}
          className="absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3.5 h-8 rounded-full text-[13px] font-semibold whitespace-nowrap pressable"
          style={{ top: rotated ? 14 : "calc(var(--sat, 0px) + 54px)", background: "rgba(0,0,0,.36)", color: lockArmed || speedLock ? "rgba(255,255,255,.96)" : "rgba(255,255,255,.88)" }}>
          <IBoltF size={13} />
          {/* 两态文案等宽（6 字），避免命中矩形在手指停留时伸缩造成 armed 抖动 */}
          {effRate}x {holdSpeed ? (lockArmed ? "松手即可锁定" : "移入此处锁定") : speedLock ? "已锁定 · 点按解除" : holdSlow ? "减速中 · 松开恢复" : "倍速"}
        </Button>
      )}

      {/* 移动端全屏进度条（横竖屏统一在底部突出显示，闲置隐藏时横拖画面自动唤起底部条） */}
      {!isDesktop && fs && (!idle || scrubbing) && (
        <div
          className="absolute inset-x-0 z-30 px-4"
          style={{
            bottom: rotated ? (idle ? 16 : 46) : `calc(var(--sab, 0px) + ${idle ? 16 : 46}px)`,
            paddingLeft: fsSafeLeft,
            paddingRight: fsSafeRight,
            height: 36,
            transition: "bottom .2s cubic-bezier(.2,0,0,1)",
          }}>
          <div ref={barRef} data-seek-bar data-scrubbing={scrubbing || undefined} className="relative h-full" style={{ touchAction: "none" }}
            onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={(e) => onBarUp(e, false)} onPointerCancel={(e) => onBarUp(e, true)}>
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-full overflow-hidden"
              style={{
                height: scrubbing ? 7 : 3,
                background: scrubbing ? "rgba(255,255,255,.32)" : "rgba(255,255,255,.26)",
                boxShadow: scrubbing ? "0 2px 12px rgba(0,0,0,.5)" : "none",
                transition: "height .16s cubic-bezier(.2,0,0,1), background-color .16s ease, box-shadow .16s ease",
              }}>
              <PlaybackProgress clock={playbackClock} duration={duration} preview={activePct} className="h-full rounded-full bg-white"
                style={{
                  boxShadow: scrubbing ? "0 0 12px rgba(255,255,255,.55)" : "none",
                  transition: scrubbing ? "none" : "width .25s linear",
                }} />
            </div>
            <PlaybackProgress clock={playbackClock} duration={duration} preview={activePct} position
              className="absolute top-1/2 rounded-full bg-white pointer-events-none"
              style={{
                width: scrubbing ? 15 : 9,
                height: scrubbing ? 15 : 9,
                transform: "translate(-50%, -50%)",
                boxShadow: scrubbing ? "0 0 0 4px rgba(255,255,255,.26), 0 2px 8px rgba(0,0,0,.6)" : "0 0 8px rgba(0,0,0,.55)",
                transition: scrubbing ? "width .14s ease, height .14s ease, box-shadow .14s ease" : "left .25s linear, width .14s ease, height .14s ease, box-shadow .14s ease",
              }} />
            {scrubbing && activePct !== null && (
              <div className="absolute left-1/2 -translate-x-1/2 -top-9 px-3 py-1 rounded-full hg-chip-strong backdrop-blur-md text-[13px] font-bold tabular-nums whitespace-nowrap pointer-events-none elev-2"
                style={{ boxShadow: "0 4px 16px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.14)" }}>
                <span className="text-white">{fmtTime(activePct * (duration || 0))}</span>
                <span className="hg-ink-4 font-medium"> / {fmtTime(duration)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 移动端：沉浸全屏（安卓 WebView 不支持 Fullscreen API，改用应用内沉浸层） */}
      {!isDesktop && fs && !idle && (
        <>
          <div className="mobile-fs-controls absolute inset-x-0 z-40 flex items-center px-4"
            style={{
              bottom: rotated ? 10 : "calc(var(--sab, 0px) + 10px)",
              paddingLeft: fsSafeLeft,
              paddingRight: fsSafeRight,
            }}>
            <Button onClick={() => videoRef.current?.toggle()} aria-label={paused ? "播放" : "暂停"}
              className="hg-chip shrink-0 w-9 h-9 rounded-full flex items-center justify-center pressable">
              {paused ? <IPlayF size={18} /> : <IPauseF size={17} />}
            </Button>
            <PlaybackTime clock={playbackClock} duration={duration} padMinutes className="mobile-fs-time shrink-0 text-[12px] font-semibold hg-ink-2 tabular-nums" />
            <Button
              aria-label={speedLock ? "解除倍速锁定" : `切换倍速，当前 ${effRate} 倍`}
              onClick={() => {
                if (speedLock) { setSpeedLock(0); return; }
                const seq = [1, 1.25, 1.5, 2];
                const i = seq.indexOf(rate);
                setRate(seq[(i + 1) % seq.length]);
              }}
              className={`ml-auto shrink-0 flex items-center gap-1 px-2.5 h-8 rounded-full text-[13px] font-bold pressable ${effRate !== 1 ? "bg-white text-[#191919]" : "hg-chip hg-ink-2"}`}>
              <IBoltF size={12} />{effRate}x
            </Button>
            <Button onClick={exitFs} aria-label="退出全屏"
              className="mobile-fs-exit hg-chip shrink-0 w-8 h-8 rounded-full flex items-center justify-center pressable">
              <ICompress size={16} />
            </Button>
          </div>
        </>
      )}

      {/* 选集 / 评论：桌面停靠在右侧（画面让位），移动端底部弹层 */}
      {isDesktop ? (
        <div className={`desktop-dock-panel ${panel ? "is-open" : ""}`}>
          <div className="desktop-dock-inner">
            <Suspense fallback={<PanelFallback />}>
              {panel === "detail" ? detailBody(() => setPanel(null)) : panel === "episodes" ? (
                <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
              ) : panel === "comments" ? (
                <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
              ) : null}
            </Suspense>
          </div>
        </div>
      ) : (
        <>
          <Sheet open={active && panel === "more"} label="播放设置" z="playback-settings-overlay" onClose={() => setPanel(null)}>
            <PlaybackSettingsPanel
              rate={rate} onRate={(value) => { setRate(value); videoRef.current?.rate(value); }}
              preferHevc={preferHevc} onPreferHevc={setPreferHevc}
              portraitFit={portraitFit} onPortraitFit={setPortraitFit}
              onClose={() => setPanel(null)} />
          </Sheet>

          {/* 评论：移动端底部弹层（右侧操作栏「评论」入口） */}
          <Sheet open={active && panel === "comments"} onClose={() => setPanel(null)}>
            <div className="feed-comments-sheet">
              {panel === "comments" && (
                <Suspense fallback={<PanelFallback />}>
                  <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
                </Suspense>
              )}
            </div>
          </Sheet>

          {/* 吃瓜图文正文 */}
          <Sheet open={active && panel === "article"} onClose={() => setPanel(null)}>
            <div className="feed-article-sheet">
              {panel === "article" && (
                <Suspense fallback={<PanelFallback />}>
                  <ArticlePanel title={meta.title} html={articleHtml} cover={meta.cover} hot={post?.hot} onClose={() => setPanel(null)} />
                </Suspense>
              )}
            </div>
          </Sheet>

          <Sheet open={active && (panel === "detail" || panel === "episodes")} label={panel === "detail" ? "视频详情" : "选集"} onClose={() => setPanel(null)}>
            <div className="video-details-sheet">
              {/* 双栏抽屉：详情 / 选集 */}
              <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
                <SegmentedControl className="flex-1" aria-label="剧集面板" activeIndex={panel === "detail" ? 0 : 1}>
                  {([["detail", "详情"], ["episodes", "选集"]] as const).map(([k, l]) => (
                    <Button aria-pressed={panel === k} key={k} onClick={() => setPanel(k)}>{l}</Button>
                  ))}
                </SegmentedControl>
                <Button onClick={() => setPanel(null)} aria-label="关闭"
                  className="ios-icon-button">
                  <IClose size={14} />
                </Button>
              </div>

              {panel === "detail" || panel === "episodes" ? (
                <PanelSwipeArea panel={panel} onChange={setPanel}>
                  <Suspense fallback={<PanelFallback />}>
                    {panel === "episodes" ? (
                      <EpisodesPanel bare videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
                    ) : detailBody()}
                  </Suspense>
                </PanelSwipeArea>
              ) : null}
            </div>
          </Sheet>
        </>
      )}
    </>
  );
}

export function FeedMobileTopTools({
  isDesktop, controlsLocked, active, fs, idle, rotated, clean, currentQuality, searchLabel, onSearch,
}: {
  isDesktop: boolean;
  controlsLocked: boolean;
  active: boolean;
  fs: boolean;
  idle: boolean;
  rotated: boolean;
  clean: boolean;
  currentQuality: "HD" | "SD" | null;
  searchLabel?: string;
  onSearch?: () => void;
}) {
  if (isDesktop || controlsLocked || !active || (fs && idle) || (!fs && clean)) return null;
  return (
    <div className="feed-mobile-top-tools absolute z-40 flex items-center gap-2"
      style={{
        top: rotated ? 12 : "calc(var(--sat, 0px) + 6px)",
        right: rotated ? "calc(var(--sab, 0px) + 12px)" : "calc(var(--sar, 0px) + 12px)",
      }}>
      {onSearch && !fs && <Button type="button" aria-label={searchLabel ?? "搜索"} onClick={onSearch} className="feed-context-search pressable">
        <ISearch size={14} /><span>{searchLabel ?? "搜索"}</span>
      </Button>}
      {currentQuality && <span className="feed-current-quality" aria-label={`当前清晰度：${currentQuality === "HD" ? "高清" : "标清"}`}>{currentQuality}</span>}
    </div>
  );
}
