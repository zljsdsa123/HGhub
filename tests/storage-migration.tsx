import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useStore } from "../src/store";

function Probe() {
  const store = useStore();
  useEffect(() => {
    Object.assign(window, { storageMigrationFixture: { ...store, getThemePreference: () => store.themePreference } });
  }, [store]);
  return <pre>{JSON.stringify({
    likes: store.likes, favs: store.favs, history: store.history, follows: store.follows,
    searchHist: store.searchHist, volume: store.volume, muted: store.muted,
    muteOnStartup: store.muteOnStartup, swipeEp: store.swipeEp,
    preferHevc: store.preferHevc, theme: store.theme,
  })}</pre>;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AppProvider><Probe /></AppProvider></React.StrictMode>,
);
