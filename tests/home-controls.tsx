import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import FeedItemChrome from "../src/features/feed/FeedItemChrome";
import { FeedMobileTopTools, FeedPlayerShellChrome } from "../src/features/feed/FeedPlayerShellChrome";
import { PlaybackSettingsPanel } from "../src/features/feed/PlaybackSettingsPanel";
import { PanelSwipeArea } from "../src/features/feed/PanelSwipeArea";
import { resolveFullscreenEpisodeSwipe } from "../src/features/feed/fullscreenEpisodeSwipe";
import { createPlaybackClock } from "../src/features/playback";
import type { FeedPanel } from "../src/features/feed/useFeedViewport";
import { Sheet } from "../src/shared/ui/ios/overlays";
import { Button, SegmentedControl } from "../src/shared/ui/ios/controls";
import { TagBlockMenu } from "../src/shared/ui/TagBlockMenu";
import { ContentTags } from "../src/shared/ui/ContentTags";
import "../src/index.css";

const meta = {
  title: "示例剧名",
  cover: "",
  score: 8.6,
  like: 120,
  collect: 36,
  comment: 89,
  author: "示例作者",
  authorId: 7,
  tags: ["都市", "逆袭", "甜宠", "打脸"],
  desc: "示例简介",
  episodes: Array.from({ length: 109 }, (_, index) => ({ ep_num: index + 1, title: `第 ${index + 1} 集` })),
} as any;

function Probe() {
  const clock = useRef(createPlaybackClock()).current;
  const [panel, setPanel] = useState<FeedPanel>(null);
  const [tagMenu, setTagMenu] = useState(false);
  const [tagSelection, setTagSelection] = useState<string[]>([]);
  const [rate, setRate] = useState(1);
  const [preferHevc, setPreferHevc] = useState(true);
  const [portraitFit, setPortraitFit] = useState<"contain" | "cover">("contain");
  const [swipeEp, setSwipeEp] = useState(true);
  const [muted, setMuted] = useState(true);
  const [openedTag, setOpenedTag] = useState("");
  const [fullscreen, setFullscreen] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(false);
  const [clean, setClean] = useState(false);
  const [fsPreview, setFsPreview] = useState(false);
  const [fsIdle, setFsIdle] = useState(false);
  const [contextSearch, setContextSearch] = useState(false);
  const openTagMenu = (selected: string[] = []) => {
    setTagSelection(selected);
    setPanel(null);
    setTagMenu(true);
  };
  useEffect(() => {
    Object.assign(window, {
      homeControlsProbe: {
        panel: () => panel,
        rate: () => rate,
        setRate: (value: number) => setRate(value),
        preferHevc: () => preferHevc,
        setPreferHevc: (value: boolean) => setPreferHevc(value),
        portraitFit: () => portraitFit,
        setPortraitFit: (value: "contain" | "cover") => setPortraitFit(value),
        swipeEp: () => swipeEp,
        muted: () => muted,
        openedTag: () => openedTag,
        fullscreen: () => fullscreen,
        locked: () => locked,
        clean: () => clean,
        setClean: (value: boolean) => setClean(value),
        setFsIdle: (value: boolean) => setFsIdle(value),
        setContextSearch: (value: boolean) => setContextSearch(value),
        setLocked: (value: boolean) => setLocked(value),
        tagSelection: () => tagSelection,
        fullscreenEpisodeSwipe: (current: number, total: number, dy: number) => resolveFullscreenEpisodeSwipe(current, total, dy),
      },
    });
  });
  return <div className="probe-stage">
    <FeedItemChrome
      isActive isDesktop={false} fs={fsPreview} clean={clean} mode="home" kind="video" title="示例剧名"
      index={0} effectiveLength={1} bottomInset={0} curEp={1} duration={120} meta={meta} hevcUrl="hevc.mp4"
      preferHevc={preferHevc} setPreferHevc={setPreferHevc}
      landscapeVideo={false} capsuleOn={false} zoom={{ s: 1, x: 0, y: 0, g: false }} setZoom={() => {}}
      portraitFit={portraitFit} setPortraitFit={setPortraitFit}
      liked={false} collected={false} likePending={false} collectPending={false} heartBurst={0}
      likeCount={120} collectCount={36} paused={false} onPlay={() => {}} waiting={false} err="" scrub={null}
      barRef={{ current: null }} barPct={null} playbackClock={clock}
      onBack={() => {}} enterFs={landscape => { setFullscreen(landscape); setFsPreview(true); }} stepDir={() => {}} canStep={() => false}
      onLike={async () => {}} onFav={async () => {}} setPanel={setPanel}
      openTag={setOpenedTag} openTagMenu={openTagMenu}
      muted={muted} onToggleMuted={() => setMuted(value => !value)}
      swipeEnabled swipeEp={swipeEp} onToggleSwipe={() => setSwipeEp(value => !value)}
      onLock={() => setLocked(true)}
      onBarDown={() => {}} onBarMove={() => {}} onBarUp={() => {}}
      onRetryStream={() => {}} toast={() => {}}
    />
    <FeedMobileTopTools
      isDesktop={false} controlsLocked={false} active fs={fsPreview} idle={fsIdle} rotated={false} clean={clean}
      currentQuality={preferHevc ? "HD" : "SD"}
      searchLabel={contextSearch ? "搜短剧" : undefined}
      onSearch={contextSearch ? () => setOpenedTag("search") : undefined}
    />
    {fsPreview && <FeedPlayerShellChrome
      videoRef={{ current: null }} speedLockTargetRef={{ current: null }} barRef={{ current: null }}
      playbackClock={clock} isDesktop={false} active fs idle={fsIdle} rotated={false} vpLandscape={false}
      theater={false} setTheater={() => {}} fullscreen={false} controlsLocked={false}
      paused={false} duration={120} rate={rate} setRate={setRate} effRate={rate}
      holdSpeed={0} holdSlow={false} speedLock={0} setSpeedLock={() => {}} lockArmed={false}
      muted={muted} setMuted={setMuted} volume={1} setVolume={() => {}}
      swipeEp={swipeEp} setSwipeEp={setSwipeEp} preferHevc={preferHevc} setPreferHevc={setPreferHevc}
      portraitFit={portraitFit} setPortraitFit={setPortraitFit} playKey="preview"
      curId={1} curEp={1} index={0} effectiveLength={1} kind="video" meta={meta}
      likeCount={120} collectCount={36} episodes={meta.episodes} related={[]}
      follows={[]} followPending={false} articleHtml="" panel={null} setPanel={setPanel}
      scrub={null} barPct={null} onBarDown={() => {}} onBarMove={() => {}} onBarUp={() => {}}
      pickEp={() => {}} go={() => {}} togglePip={async () => {}} lockControls={() => {}}
      toggleFull={() => {}} exitFs={() => setFsPreview(false)}
      onFollow={async () => {}} openTag={() => {}} openTagMenu={openTagMenu} closePanels={() => {}} pushPage={() => {}} toast={() => {}}
    />}
    <Sheet open={panel === "more"} label="播放设置" z="playback-settings-overlay" onClose={() => setPanel(null)}>
      <PlaybackSettingsPanel
        rate={rate} onRate={setRate} preferHevc={preferHevc} onPreferHevc={setPreferHevc}
        portraitFit={portraitFit} onPortraitFit={setPortraitFit} onClose={() => setPanel(null)}
      />
    </Sheet>
    {panel === "detail" || panel === "episodes" ? (
      <Sheet open label={panel === "detail" ? "视频详情" : "选集"} onClose={() => setPanel(null)}>
        <div className="video-details-sheet">
          <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
            <SegmentedControl className="flex-1" aria-label="剧集面板" activeIndex={panel === "detail" ? 0 : 1}>
              {([["detail", "详情"], ["episodes", "选集"]] as const).map(([key, label]) => (
                <Button aria-pressed={panel === key} key={key} onClick={() => setPanel(key)}>{label}</Button>
              ))}
            </SegmentedControl>
          </div>
          <PanelSwipeArea panel={panel} onChange={setPanel}>
            {panel === "episodes" ? (
              <div className="scroll-y flex-1 px-4 pb-4" data-testid="episodes-content">
                <div className="grid grid-cols-4 gap-2">
                  {meta.episodes.map((episode: any) => (
                    <Button key={episode.ep_num} className="inline-flex items-center justify-center h-10 rounded-(--r-sm) bg-s3 text-on/80">
                      {episode.ep_num}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="video-details-scroll scroll-y flex-1" data-testid="detail-content">
                <div style={{ height: 360 }} className="text-[13px] text-mut">视频详情概览</div>
                <div className="scroll-x flex gap-2.5" data-testid="related-scroll">
                  <div style={{ flex: "none", width: 640 }}>相关推荐横向列表</div>
                </div>
                <div className="mt-4" data-testid="detail-tags">
                  <ContentTags tags={meta.tags} onOpen={setOpenedTag} onBlock={tag => openTagMenu([tag])} />
                </div>
                <p className="mt-6 text-[13px] text-mut">视频详情内容</p>
              </div>
            )}
          </PanelSwipeArea>
        </div>
      </Sheet>
    ) : null}
    <TagBlockMenu open={tagMenu} tags={meta.tags} initialSelected={tagSelection} onClose={() => setTagMenu(false)} />
  </div>;
}

createRoot(document.querySelector("#root")!).render(<Probe />);
