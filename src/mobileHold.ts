export const HOLD_DELAY_MS = 380;
export const HOLD_LOCK_DISTANCE = 64;
export type HoldZone = "fast" | "slow" | "menu";
export type HoldMenuBounds = { left: number; top: number; size: number };

const dimension = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;

/** CSS-pixel square shared by hit testing and the first-visit guide. */
export function getHoldMenuBounds(width: number, height: number): HoldMenuBounds {
  const w = dimension(width), h = dimension(height);
  const short = Math.min(w, h);
  const size = Math.min(short, 112, Math.max(80, short * 0.26));
  return { left: (w - size) / 2, top: (h - size) / 2, size };
}

/** x/y are relative to the visible touch rectangle, including in landscape. */
export function getHoldZone(x: number, y: number, width: number, height: number): HoldZone {
  const w = dimension(width), h = dimension(height);
  if (!w || !h || !Number.isFinite(x) || !Number.isFinite(y)) return "menu";
  const { left, top, size } = getHoldMenuBounds(w, h);
  if (x >= left && x <= left + size && y >= top && y <= top + size) return "menu";
  return x / w - y / h >= 0 ? "fast" : "slow";
}
