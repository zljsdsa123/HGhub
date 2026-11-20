/** 全局返回拦截：面板等临时层优先消费，未消费则走导航栈。 */
type Handler = () => boolean;
export type RegisterStartupBack = (handler: () => void) => () => void;

let handler: Handler | null = null;
const overlays: { handle: Handler }[] = [];

// The launch overlay owns back while it covers an already-mounted App: back skips
// the reveal (LaunchAnimation's own listener) and must not navigate beneath it.
// Reference-counted so StrictMode's mount→cleanup→mount keeps the gate held;
// each release closure is idempotent.
let startupHolds = 0;
export function holdBackForStartup(): () => void {
  startupHolds += 1;
  let released = false;
  return () => { if (!released) { released = true; startupHolds = Math.max(0, startupHolds - 1); } };
}

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
  // Startup gate: consume without touching overlays or the page handler, so the
  // App mounted behind the launch overlay stays put until the reveal is done.
  if (startupHolds > 0) return true;
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
