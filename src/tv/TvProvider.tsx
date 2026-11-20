import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../shared/api/api";
import { initAutoLine } from "../shared/network/autoLine";
import { initializeLibrary, listLibrary, setFavorite, saveProgress, subscribeLibrary, clearHistory } from "./library";
import { contentKey, type TvContent, type TvLibraryEntry, type TvProgress } from "./model";
import { setCatalogSource } from "./search/catalog";

type TvState = { source: string; sourceKey: string; library: TvLibraryEntry[]; ready: boolean; error: string; retry: () => void; toggleFavorite: (content: TvContent) => Promise<void>; progress: (value: TvProgress) => Promise<void>; clearHistory: () => Promise<void> };
const Context = createContext<TvState | null>(null);
export function TvProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState(""), [epoch, setEpoch] = useState(0), [library, setLibrary] = useState<TvLibraryEntry[]>([]), [ready, setReady] = useState(false), [error, setError] = useState(""), [retryId, setRetry] = useState(0);
  const alive = useRef(false), libraryRef = useRef(library); libraryRef.current = library;
  const sourceGeneration = useRef(0), reloadGeneration = useRef(0);
  const pendingFavorites = useRef(new Set<string>());
  const reload = useCallback(async () => { const generation = ++reloadGeneration.current; const items = await listLibrary(); if (alive.current && generation === reloadGeneration.current) setLibrary(items); }, []);
  useEffect(() => {
    alive.current = true; let disposed = false;
    void (async () => {
      try {
        setError("");
        const generation = sourceGeneration.current;
        const boot = await api.boot();
        if (disposed) return;
        await initializeLibrary(boot.pending_migration_identity);
        if (disposed) return;
        await reload();
        if (disposed) return;
        if (generation === sourceGeneration.current) { setCatalogSource(boot.base); setSource(boot.base); }
        setReady(true); initAutoLine();
      } catch (error) { if (!disposed) setError(String(error)); }
    })();
    return () => { disposed = true; alive.current = false; reloadGeneration.current++; };
  }, [retryId, reload]);
  useEffect(() => subscribeLibrary(() => { void reload().catch(e => setError(String(e))); }), [reload]);
  useEffect(() => {
    let disposed = false;
    const changed = () => {
      const current = ++sourceGeneration.current;
      // Invalidate the old response eligibility before reading the actual source.
      setCatalogSource(""); setSource(""); setEpoch(e => e + 1);
      void api.lineState().then(state => {
        if (!disposed && current === sourceGeneration.current) { setCatalogSource(state.base); setSource(state.base); }
      }).catch(e => { if (!disposed && current === sourceGeneration.current) setError(String(e)); });
    };
    window.addEventListener("hg:line-changed", changed); window.addEventListener("hg:proxy-changed", changed);
    return () => { disposed = true; sourceGeneration.current++; window.removeEventListener("hg:line-changed", changed); window.removeEventListener("hg:proxy-changed", changed); };
  }, []);
  const toggleFavorite = useCallback(async (content: TvContent) => {
    const key = contentKey(content);
    if (pendingFavorites.current.has(key)) return;
    pendingFavorites.current.add(key);
    try { const entry = libraryRef.current.find(item => item.key === key); await setFavorite(content, !entry?.favorite); await reload(); }
    catch (e) { setError(`收藏保存失败：${String(e)}`); throw e; }
    finally { pendingFavorites.current.delete(key); }
  }, [reload]);
  const progress = useCallback(async (value: TvProgress) => { try { await saveProgress(value.content, value); } catch (e) { setError(`进度保存失败：${String(e)}`); throw e; } }, []);
  return <Context.Provider value={{ source, sourceKey: `${source}@${epoch}`, library, ready, error, retry: () => setRetry(r => r + 1), toggleFavorite, progress, clearHistory }}>{children}</Context.Provider>;
}
export function useTv() { const value = useContext(Context); if (!value) throw new Error("TvProvider missing"); return value; }
