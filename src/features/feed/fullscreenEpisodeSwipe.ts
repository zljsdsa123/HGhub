export type FullscreenEpisodeSwipe =
  | { target: number }
  | { message: string }
  | null;

/**
 * Fullscreen uses the opposite vertical direction from the regular feed:
 * swipe up goes to the previous episode and swipe down goes to the next.
 * At either boundary it returns a toast message instead of leaving the series.
 */
export function resolveFullscreenEpisodeSwipe(current: number, total: number, dy: number): FullscreenEpisodeSwipe {
  if (!Number.isFinite(dy) || dy === 0) return null;
  const episode = Number.isFinite(current) ? Math.max(1, Math.floor(current)) : 1;
  if (dy < 0) {
    if (episode <= 1) return { message: "当前已是第一集" };
    const upper = total > 0 ? total : episode - 1;
    return { target: Math.max(1, Math.min(episode - 1, upper)) };
  }
  if (!total || episode >= total) return { message: "当前已是最后一集" };
  return { target: Math.min(total, episode + 1) };
}
