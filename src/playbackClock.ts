export type PlaybackClock = {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  publish: (time: number) => void;
};

export function createPlaybackClock(): PlaybackClock {
  // Keep high-frequency progress out of Feed's page-sized React state tree.
  let time = 0;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => time,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (next) => {
      if (!Number.isFinite(next) || next === time) return;
      time = next;
      listeners.forEach((listener) => listener());
    },
  };
}
