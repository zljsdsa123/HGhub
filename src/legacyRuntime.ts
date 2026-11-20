/** Runtime APIs used by the application but absent from some Android WebViews.
 * Keep this dependency-free and import it before the rest of the application.
 * Syntax lowering and CSS compatibility are handled separately by the build.
 */
if (!("globalThis" in window)) {
  Object.defineProperty(window, "globalThis", { value: window, configurable: true, writable: true });
}

if (!Object.fromEntries) {
  Object.defineProperty(Object, "fromEntries", {
    configurable: true, writable: true,
    value(entries: Iterable<readonly [PropertyKey, unknown]>) {
      const result = {};
      for (const [key, value] of entries) {
        // Define an own property, including for the literal key "__proto__".
        Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
      }
      return result;
    },
  });
}

if (!Promise.allSettled) {
  Object.defineProperty(Promise, "allSettled", {
    configurable: true, writable: true,
    value<T>(values: Iterable<T | PromiseLike<T>>) {
      return Promise.all(Array.from(values, value => Promise.resolve(value).then(
        resolved => ({ status: "fulfilled" as const, value: resolved }),
        reason => ({ status: "rejected" as const, reason }),
      )));
    },
  });
}

if (!Array.prototype.flat) {
  Object.defineProperty(Array.prototype, "flat", {
    configurable: true, writable: true,
    value(this: unknown[], depth = 1) {
      const output: unknown[] = [];
      const append = (items: unknown[], remaining: number) => {
        for (let index = 0; index < items.length; index++) {
          if (!(index in items)) continue;
          const item = items[index];
          if (remaining > 0 && Array.isArray(item)) append(item, remaining - 1);
          else output.push(item);
        }
      };
      append(this, Math.max(0, Math.trunc(Number(depth)) || 0));
      return output;
    },
  });
}

if (!Array.prototype.flatMap) {
  Object.defineProperty(Array.prototype, "flatMap", {
    configurable: true, writable: true,
    value(this: unknown[], callback: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
      return Array.prototype.map.call(this, callback, thisArg).flat();
    },
  });
}

if (!window.queueMicrotask) {
  window.queueMicrotask = callback => {
    Promise.resolve().then(callback).catch(error => setTimeout(() => { throw error; }, 0));
  };
}

if (typeof HTMLElement !== "undefined" && !("inert" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "inert", {
    configurable: true,
    get(this: HTMLElement) { return this.hasAttribute("inert"); },
    set(this: HTMLElement, value: boolean) {
      if (value) this.setAttribute("inert", "");
      else this.removeAttribute("inert");
    },
  });
}

// Chromium < 84 exposes addListener/removeListener instead of EventTarget.
const mediaQueryPrototype = Object.getPrototypeOf(window.matchMedia("all"));
if (!mediaQueryPrototype.addEventListener && mediaQueryPrototype.addListener) {
  type ChangeListener = EventListenerOrEventListenerObject;
  type ListenerRecord = { listener: ChangeListener; callback: (event: MediaQueryListEvent) => void };
  const registered = new WeakMap<MediaQueryList, ListenerRecord[]>();
  Object.defineProperty(mediaQueryPrototype, "addEventListener", {
    configurable: true, writable: true,
    value(this: MediaQueryList, type: string, listener: ChangeListener | null, options?: boolean | AddEventListenerOptions) {
      if (type !== "change" || !listener) return;
      const records = registered.get(this) || [];
      if (records.some(record => record.listener === listener)) return;
      const callback = (event: MediaQueryListEvent) => {
        if (options && typeof options === "object" && options.once) this.removeEventListener(type, listener);
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
      records.push({ listener, callback });
      registered.set(this, records);
      this.addListener(callback);
    },
  });
  Object.defineProperty(mediaQueryPrototype, "removeEventListener", {
    configurable: true, writable: true,
    value(this: MediaQueryList, type: string, listener: ChangeListener | null) {
      if (type !== "change" || !listener) return;
      const records = registered.get(this) || [];
      const index = records.findIndex(record => record.listener === listener);
      if (index < 0) return;
      this.removeListener(records[index].callback);
      records.splice(index, 1);
      if (!records.length) registered.delete(this);
    },
  });
}

// Some vendor WebViews omit ResizeObserver despite reporting a recent Chrome
// version. Only those engines use this bounded, visible-page size observer.
if (!window.ResizeObserver) {
  class LegacyResizeObserver {
    private elements = new Map<Element, { width: number; height: number }>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      if (this.elements.has(target)) return;
      this.elements.set(target, { width: -1, height: -1 });
      if (!this.timer) this.timer = setTimeout(this.measure, 0);
    }
    unobserve(target: Element) {
      this.elements.delete(target);
      if (!this.elements.size) this.disconnect();
    }
    disconnect() {
      clearTimeout(this.timer); this.timer = undefined;
      this.elements.clear();
    }
    private measure = () => {
      this.timer = undefined;
      if (!this.elements.size) return;
      if (document.visibilityState !== "hidden") {
        const entries: ResizeObserverEntry[] = [];
        this.elements.forEach((previous, target) => {
          const rect = target.getBoundingClientRect();
          if (rect.width === previous.width && rect.height === previous.height) return;
          this.elements.set(target, { width: rect.width, height: rect.height });
          const size = [{ inlineSize: rect.width, blockSize: rect.height }];
          entries.push({ target, contentRect: rect, contentBoxSize: size, borderBoxSize: size, devicePixelContentBoxSize: size });
        });
        if (entries.length) {
          try { this.callback(entries, this as unknown as ResizeObserver); }
          catch (error) { setTimeout(() => { throw error; }, 0); }
        }
      }
      if (this.elements.size) this.timer = setTimeout(this.measure, 250);
    };
  }
  window.ResizeObserver = LegacyResizeObserver as unknown as typeof ResizeObserver;
}

declare global {
  interface Window {
    __HG_STARTUP__?: { ready: () => void };
  }
}

function detectFlexGap() {
  // Flexbox gap has shipped unconditionally since Chromium 84; skip the synchronous
  // DOM layout reflow on modern Chromium/WebView2 while keeping the measured check
  // for Safari, vendor WebViews, and legacy Chromium 66-84 targets.
  const chrome = /(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent);
  if (chrome && Number(chrome[1]) >= 85) return;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;left:-9999px;display:flex;flex-direction:column;row-gap:1px;visibility:hidden";
  probe.appendChild(document.createElement("div"));
  probe.appendChild(document.createElement("div"));
  document.body.appendChild(probe);
  if (probe.scrollHeight !== 1) document.documentElement.setAttribute("data-legacy-flex-gap", "");
  probe.remove();
}
if (document.body) detectFlexGap();
else document.addEventListener("DOMContentLoaded", detectFlexGap, { once: true });

/** Call from the first successful React commit, not immediately after render(). */
export function markStartupReady() {
  window.__HG_STARTUP__?.ready();
}
