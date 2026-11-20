import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./controls";
import { registerOverlayBack } from "../../lib/back";
import { getFullscreenElement } from "../../lib/fullscreen";

type Layer = { token: symbol; ancestors: symbol[]; element: HTMLElement; panel: HTMLElement; previous: HTMLElement | null; lastFocus: HTMLElement | null };
const LayerContext = createContext<symbol[]>([]);
const layers: Layer[] = [];
const previousInert = new Map<HTMLElement, boolean>();
let backgroundObserver: MutationObserver | null = null;
const topLayer = () => layers[layers.length - 1];
const available = (element: HTMLElement) => element.isConnected && !!element.getClientRects().length
  && !["hidden", "collapse"].includes(getComputedStyle(element).visibility)
  && !element.matches(":disabled") && !element.closest('[inert], [hidden], [aria-hidden="true"]');
const focusable = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>(
  'button, input, textarea, select, a[href], area[href], summary, [tabindex], [contenteditable="true"], audio[controls], video[controls]',
)].filter(el => el.tabIndex >= 0 && available(el)).sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));

function focusLayer(layer: Layer, initial = false) {
  const preferred = initial ? layer.panel.querySelector<HTMLElement>("[data-autofocus]") : layer.lastFocus;
  const target = preferred && available(preferred) ? preferred : focusable(layer.panel)[0];
  target?.focus({ preventScroll: true });
  if (!layer.panel.contains(document.activeElement)) layer.panel.focus({ preventScroll: true });
}

function syncBackground() {
  const top = topLayer();
  const blocked = new Set<HTMLElement>();
  // A fullscreen portal can use a different host: cover siblings along its entire path.
  let child: HTMLElement | null = top?.element ?? null;
  while (child?.parentElement) {
    const parent: HTMLElement = child.parentElement;
    for (const sibling of parent.children) {
      if (sibling instanceof HTMLElement && sibling !== child) blocked.add(sibling);
    }
    if (parent === document.body) break;
    child = parent;
  }
  for (const [element, value] of previousInert) {
    if (!blocked.has(element)) {
      element.inert = element.classList.contains("ios-overlay") ? element.classList.contains("is-closing") : value;
      previousInert.delete(element);
    }
  }
  for (const element of blocked) {
    if (!previousInert.has(element)) previousInert.set(element, element.inert);
    element.inert = true;
  }
  layers.forEach((layer, index) => layer.element.style.setProperty("--ios-overlay-order", String(index)));
  if (!top) { backgroundObserver?.disconnect(); backgroundObserver = null; return; }
  if (!backgroundObserver) {
    backgroundObserver = new MutationObserver(records => {
      const parents = new Set<Node>();
      for (let element = topLayer()?.element.parentElement; element; element = element.parentElement) parents.add(element);
      if (records.some(record => parents.has(record.target))) syncBackground();
    });
    backgroundObserver.observe(document.body, { childList: true, subtree: true });
  }
}

function DialogFrame({ open, onClose, children, kind, width, label, z, avoidNativeKeyboard }: {
  open: boolean; onClose: () => void; children: ReactNode;
  kind: "modal" | "sheet" | "guide"; width?: number; label: string; z?: string; avoidNativeKeyboard?: boolean;
}) {
  const motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [mounted, setMounted] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  const autoFocusPrevious = useRef<HTMLElement | null>(null);
  const token = useRef(Symbol()).current;
  const ancestors = useContext(LayerContext);
  const descendants = useMemo(() => [...ancestors, token], [ancestors, token]);
  const close = useRef(onClose);
  close.current = onClose;
  const host = getFullscreenElement() ?? document.getElementById("root") ?? document.body;
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const timeout = setTimeout(() => setMounted(false), motion ? 180 : 0);
    return () => clearTimeout(timeout);
  }, [open, motion]);
  useLayoutEffect(() => {
    if (!open || !mounted || !avoidNativeKeyboard || typeof ResizeObserver === "undefined") return;
    const panel = ref.current?.querySelector<HTMLElement>("[role=dialog]");
    if (!panel) return;
    let height = panel.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = panel.clientHeight;
      const shrank = nextHeight < height;
      height = nextHeight;
      const active = document.activeElement;
      if (!shrank || !active?.matches("input, textarea") || !panel.contains(active)) return;
      // Move only the panel's scroller, not the background or visual viewport.
      const field = active.getBoundingClientRect();
      const viewport = panel.getBoundingClientRect();
      if (field.bottom > viewport.bottom) panel.scrollTop += field.bottom - viewport.bottom + 12;
      else if (field.top < viewport.top) panel.scrollTop += field.top - viewport.top - 12;
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, mounted, host, avoidNativeKeyboard]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!open || !mounted || !element) return;
    const panel = element.querySelector<HTMLElement>("[role=dialog]")!;
    // Child layout effects run first. Insert an initially open parent below its children.
    const firstChild = layers.findIndex(layer => layer.ancestors.includes(token));
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previous = firstChild === -1 ? (active && element.contains(active) ? autoFocusPrevious.current : active) : layers[firstChild].previous;
    autoFocusPrevious.current = null;
    const layer: Layer = { token, ancestors, element, panel, previous, lastFocus: null };
    if (firstChild === -1) layers.push(layer); else layers.splice(firstChild, 0, layer);
    const removeBack = registerOverlayBack(() => {
      if (topLayer() !== layer) return false;
      close.current(); return true;
    });
    syncBackground();
    if (topLayer() === layer) focusLayer(layer, true);
    const onFocus = (event: FocusEvent) => {
      if (topLayer() !== layer) return;
      if (event.target instanceof HTMLElement && panel.contains(event.target)) layer.lastFocus = event.target;
      else focusLayer(layer);
    };
    const onKey = (event: KeyboardEvent) => {
      if (topLayer() !== layer || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) close.current();
      } else if (event.key === "Tab") {
        const items = focusable(panel);
        const first = items[0], last = items[items.length - 1];
        if (!first) { event.preventDefault(); panel.focus({ preventScroll: true }); return; }
        const current = document.activeElement;
        if (event.shiftKey && (current === first || !items.includes(current as HTMLElement))) {
          event.preventDefault(); last.focus({ preventScroll: true });
        } else if (!event.shiftKey && (current === last || !items.includes(current as HTMLElement))) {
          event.preventDefault(); first.focus({ preventScroll: true });
        }
      }
    };
    document.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKey, true);
    return () => {
      const wasTop = topLayer() === layer;
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKey, true);
      removeBack();
      const index = layers.indexOf(layer);
      if (index !== -1) layers.splice(index, 1);
      // A parent may unmount while a child remains open; retain the original opener.
      for (const remaining of layers) {
        if (remaining.previous && element.contains(remaining.previous)) remaining.previous = layer.previous;
      }
      syncBackground();
      if (!wasTop) return;
      const next = topLayer();
      if (layer.previous && available(layer.previous) && (!next || next.panel.contains(layer.previous))) {
        layer.previous.focus({ preventScroll: true });
      } else if (next) focusLayer(next);
    };
  }, [open, mounted, host, token, ancestors]);
  if (!mounted) return null;
  return createPortal(
    <LayerContext.Provider value={descendants}>
      <div ref={ref} className={`ios-overlay ios-overlay-${kind} ${open ? "is-open" : "is-closing"} ${z ?? ""}`}
        onFocusCapture={event => {
          // React autoFocus can run before this frame's layout effect.
          if (!layers.some(layer => layer.token === token) && event.relatedTarget instanceof HTMLElement
            && !event.currentTarget.contains(event.relatedTarget)) autoFocusPrevious.current = event.relatedTarget;
        }}
        data-avoid-native-keyboard={avoidNativeKeyboard || undefined}
        aria-hidden={!open || undefined} inert={!open ? true : undefined}>
        {kind !== "guide" && <Button className="ios-overlay-backdrop" aria-label="关闭对话框" onClick={onClose} tabIndex={-1} />}
        <div role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className="ios-dialog" onKeyDown={event => event.stopPropagation()}
          style={{ "--ios-dialog-width": `${width ?? 440}px` } as CSSProperties}>
          {kind === "sheet" && <div className="ios-sheet-grip" aria-hidden="true" />}
          {children}
        </div>
      </div>
    </LayerContext.Provider>, host,
  );
}

export function Modal(props: { open: boolean; onClose: () => void; children: ReactNode; width?: number; label?: string }) {
  return <DialogFrame {...props} kind="modal" label={props.label ?? "对话框"} />;
}
export function Sheet(props: { open: boolean; onClose: () => void; children: ReactNode; z?: string; label?: string; avoidNativeKeyboard?: boolean }) {
  return <DialogFrame {...props} kind="sheet" label={props.label ?? "详情面板"} />;
}

/** Full-player coach marks retain the shared focus trap, inert background and back handling. */
export function GuideFrame(props: { open: boolean; onClose: () => void; children: ReactNode; label: string }) {
  return <DialogFrame {...props} kind="guide" />;
}
