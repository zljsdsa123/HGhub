import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "textarea:not(:disabled)",
  "select:not(:disabled)",
  "a[href]",
  "area[href]",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  "audio[controls]",
  "video[controls]",
].join(",");

function isAvailable(element: HTMLElement) {
  return element.isConnected && element.tabIndex >= 0 && element.getClientRects().length > 0
    && !["hidden", "collapse"].includes(getComputedStyle(element).visibility)
    && !element.closest('[inert], [hidden], [aria-hidden="true"]');
}

function focusables(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter(isAvailable)
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}

function isDialogAvailable(root: HTMLElement) {
  return root.isConnected && root.getClientRects().length > 0
    && !root.closest('[inert], [hidden], [aria-hidden="true"]');
}

/**
 * Isolate a full-page dialog that lives inside the page being covered.
 * Portaled dialogs use the shared overlay layer; this hook handles in-page
 * surfaces without changing their layout or stacking context.
 */
export function useDialogFocusTrap(open: boolean, rootRef: RefObject<HTMLElement | null>, onDismiss: () => void) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!open || !root || !isDialogAvailable(root)) return;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const changed: [HTMLElement, boolean][] = [];
    const changedSet = new Set<HTMLElement>();
    let child: HTMLElement = root;
    while (child.parentElement) {
      const parent = child.parentElement;
      for (const sibling of parent.children) {
        if (!(sibling instanceof HTMLElement) || sibling === child || changedSet.has(sibling)) continue;
        changedSet.add(sibling);
        changed.push([sibling, sibling.inert]);
        sibling.inert = true;
      }
      if (parent === document.body) break;
      child = parent;
    }

    let lastFocused: HTMLElement | null = null;
    const initial = root.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(root)[0] ?? root;
    initial.focus({ preventScroll: true });

    const onFocus = (event: FocusEvent) => {
      // Stack pages stay mounted beneath pushed content. A hidden dialog must
      // neither reclaim focus nor prevent the visible page from receiving it.
      if (!isDialogAvailable(root)) return;
      if (event.target instanceof HTMLElement && root.contains(event.target)) {
        lastFocused = event.target;
        return;
      }
      const target = lastFocused && isAvailable(lastFocused) ? lastFocused : root;
      target.focus({ preventScroll: true });
    };
    const onKey = (event: KeyboardEvent) => {
      if (!isDialogAvailable(root)) return;
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) dismissRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !items.includes(current as HTMLElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (current === last || !items.includes(current as HTMLElement))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("focusin", onFocus, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("focusin", onFocus, true);
      window.removeEventListener("keydown", onKey, true);
      for (const [element, inert] of changed) element.inert = inert;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, rootRef]);
}
