/** The Android TV build sets this at compile time; platform detection remains Android. */
export const isTv = import.meta.env.VITE_APP_EDITION === "tv";
export const appName = isTv ? "HGhubX TV" : "HGhubX";
