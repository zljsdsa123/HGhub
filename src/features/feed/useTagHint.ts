import { useSyncExternalStore } from "react";

export const TAG_HINT_DISMISSED_KEY = "hghubx_tag_hint_dismissed_v1";

function readDismissed(): boolean | null {
  try { return localStorage.getItem(TAG_HINT_DISMISSED_KEY) === "1"; }
  catch { return null; }
}

let sessionFallback = false;
let dismissed = readDismissed() ?? false;
const listeners = new Set<() => void>();

function refresh() {
  // A failed write must keep the hint hidden for this session, not reopen on the next Feed mount.
  const next = sessionFallback || (readDismissed() ?? dismissed);
  if (next === dismissed) return;
  dismissed = next;
  listeners.forEach(listener => listener());
}

function onStorage(event: StorageEvent) {
  if (event.key === TAG_HINT_DISMISSED_KEY || event.key === null) refresh();
}

function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  refresh();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}

function dismiss() {
  // Only the explicit acknowledgement writes this key; mounting never does.
  try {
    localStorage.setItem(TAG_HINT_DISMISSED_KEY, "1");
    sessionFallback = false;
  } catch {
    sessionFallback = true;
  }
  if (!dismissed) {
    dismissed = true;
    listeners.forEach(listener => listener());
  }
}

const getSnapshot = () => dismissed;
const getServerSnapshot = () => false;

/** Shared across Feed instances; the acknowledgement belongs to this device. */
export function useTagHint() {
  return { dismissed: useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot), dismiss };
}
