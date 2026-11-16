import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import VideoSurface, { type VideoHandle } from "../src/components/VideoSurface";
import Player from "../src/components/Player";

type Configuration = { component: "surface" | "player"; src: string; mounted: boolean; active: boolean; muted: boolean; autoPlay: boolean };
const fixture = (window as unknown as { nativeMediaFixture: {
  config: Configuration;
  errors: string[];
  ready: boolean;
  render: (change: Partial<Configuration>) => void;
} }).nativeMediaFixture;

function Harness() {
  const [config, setConfig] = useState(fixture.config);
  const video = useRef<VideoHandle>(null);
  useEffect(() => {
    fixture.render = change => setConfig(previous => ({ ...previous, ...change }));
    fixture.ready = true;
  }, []);
  if (!config.mounted) return null;
  return config.component === "surface"
    ? <><button onClick={() => video.current?.play()}>播放</button><VideoSurface ref={video} src={config.src} active={config.active} muted={config.muted} autoPlay={config.autoPlay} onError={message => fixture.errors.push(message)} /></>
    : <Player src={config.src} active={config.active} muted={config.muted} autoPlay={config.autoPlay} />;
}

createRoot(document.getElementById("root")!).render(<Harness />);
