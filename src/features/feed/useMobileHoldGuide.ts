import { useSyncExternalStore } from "react";

export const MOBILE_HOLD_GUIDE_KEY = "hghubx_mobile_hold_guide_v1";

function readSeen(): boolean | null {
  try { return localStorage.getItem(MOBILE_HOLD_GUIDE_KEY) === "1"; }
  catch { return null; }
}

let sessionFallback = false;
let seen = readSeen() ?? false;
const listeners = new Set<() => void>();

function refresh() {
  // A failed write must not reopen the guide when another Feed mounts.
  const next = sessionFallback || (readSeen() ?? seen);
  if (next === seen) return;
  seen = next;
  listeners.forEach(listener => listener());
}

function onStorage(event: StorageEvent) {
  if (event.key === MOBILE_HOLD_GUIDE_KEY || event.key === null) refresh();
}

function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  // Catch changes made by another window while no player was mounted.
  refresh();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}

function dismiss() {
  // Only the explicit acknowledgement writes this key; mounting never does.
  try {
    localStorage.setItem(MOBILE_HOLD_GUIDE_KEY, "1");
    sessionFallback = false;
  } catch {
    sessionFallback = true;
  }
  if (!seen) {
    seen = true;
    listeners.forEach(listener => listener());
  }
}

const getSnapshot = () => seen;
const getServerSnapshot = () => false;

/** Shared across player instances; the acknowledgement belongs to this device. */
export function useMobileHoldGuide() {
  return { seen: useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot), dismiss };
}
