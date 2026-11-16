/** 全局返回拦截：面板等临时层优先消费，未消费则走导航栈。 */
type Handler = () => boolean;

let handler: Handler | null = null;
const overlays: { handle: Handler }[] = [];

/** Dialogs can nest; dismiss the newest overlay before a player panel or page. */
export function registerOverlayBack(h: Handler) {
  const entry = { handle: h };
  overlays.push(entry);
  return () => { const index = overlays.indexOf(entry); if (index !== -1) overlays.splice(index, 1); };
}

export function setBackHandler(h: Handler | null) {
  handler = h;
}

/** 返回 true 表示已被消费（不再退栈） */
export function runBack(): boolean {
  // A handler can synchronously unregister itself. Snapshot registrations to avoid
  // calling another handler twice or dismissing an overlay opened during this event.
  for (const entry of [...overlays].reverse()) {
    if (!overlays.includes(entry)) continue;
    try {
      if (entry.handle()) return true;
    } catch {
      // A failed dialog close must not navigate away from the page beneath it.
      return true;
    }
  }
  try { return handler ? handler() : false; } catch { return false; }
}
