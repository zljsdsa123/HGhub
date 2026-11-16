/* Automatic line selection uses the real content API and keeps the current line
 * when every candidate is unavailable. */
import { api, hostOf, logLine, setNetObserver } from "./api";
import { tracePlayback } from "./playbackDiagnostics";
import { readStorage, STORAGE_KEYS } from "./storage";

const HEALTH_STEPS = [60_000, 120_000, 300_000];
const RECHECK_MS = 4_000;
const DOWN_RETRY_MS = 10_000;
const PICK_COOLDOWN_MS = 15_000;
let enabledOverride: boolean | null = null;

export const autoLineEnabled = (): boolean => {
  return enabledOverride ?? readStorage(STORAGE_KEYS.autoLine) !== "off";
};

let started = false;
let attached = false;
let picking = false;
let checking = false;
let timer = 0;
let step = 0;
let downStreak = 0;
let failStreak = 0;
let lastPickAt: number | null = null;
let cancellation: Promise<void> = Promise.resolve();

export let lastPick: { base: string; tier: string; ms: number } | null = null;

function stopTimer() {
  window.clearTimeout(timer);
  timer = 0;
}

function schedule(delay: number) {
  stopTimer();
  if (!autoLineEnabled()) return;
  timer = window.setTimeout(() => {
    if (navigator.onLine === false) {
      schedule(30_000);
    } else if (document.visibilityState === "visible") {
      void check("timer");
    } else {
      schedule(HEALTH_STEPS[0]);
    }
  }, delay);
}

export const setAutoLine = (on: boolean): Promise<void> => {
  enabledOverride = on;
  try { localStorage.setItem(STORAGE_KEYS.autoLine, on ? "on" : "off"); } catch { /* storage can be unavailable */ }
  if (!on) {
    stopTimer();
    const pending = cancellation.then(() => api.lineCancel());
    cancellation = pending.catch((error) => {
      logLine(`[line] cancel failed: ${(error as Error).message}`);
    });
    window.dispatchEvent(new Event("hg:auto-line-changed"));
    return pending;
  }
  if (started && !attached) attach();
  if (started) void pickLine("manual", true);
  window.dispatchEvent(new Event("hg:auto-line-changed"));
  return Promise.resolve();
};

export async function pickLine(reason: string, force = false): Promise<void> {
  if (!autoLineEnabled() || picking || (!force && document.visibilityState !== "visible")) return;
  if (!force && lastPickAt !== null && Date.now() - lastPickAt < PICK_COOLDOWN_MS) return;
  picking = true;
  let down = false;
  try {
    await cancellation;
    if (!autoLineEnabled()) return;
    const result = await api.lineAuto();
    if (result.cancelled || !autoLineEnabled()) return;
    lastPickAt = Date.now();
    downStreak = 0;
    failStreak = 0;
    step = 0;
    const candidates = result.pick.candidates
      .map((candidate) => `${candidate.tier}:${candidate.ok ? "ok" : candidate.reachable ? "reachable" : "down"}/${candidate.ms}ms`)
      .join(",");
    if (result.pick.reason === "all-down") {
      down = true;
      logLine(`[line] auto(${reason}) all-down, keep ${hostOf(result.base)} | ${candidates}`);
      tracePlayback("line.allDown", { reason, line: hostOf(result.base), candidates });
      window.dispatchEvent(new Event("hg:line-down"));
      return;
    }
    lastPick = { base: result.base, tier: result.pick.tier, ms: result.pick.ms };
    logLine(`[line] auto(${reason}) ${hostOf(result.base)} tier=${result.pick.tier} ms=${result.pick.ms} switched=${result.switched} | ${candidates}`);
    tracePlayback("line.pick", { reason, line: hostOf(result.base), tier: result.pick.tier, ms: result.pick.ms, switched: result.switched, candidates });
    if (result.switched) {
      window.dispatchEvent(new CustomEvent("hg:line", {
        detail: { region: result.pick.tier === "main" ? "intl" : "cn", host: hostOf(result.base), ms: result.pick.ms },
      }));
      window.dispatchEvent(new Event("hg:line-changed"));
    }
  } catch (error) {
    logLine(`[line] auto(${reason}) failed: ${(error as Error).message}`);
    tracePlayback("line.fail", { where: "auto", reason, err: (error as Error).message });
  } finally {
    picking = false;
    if (started) schedule(down ? DOWN_RETRY_MS : HEALTH_STEPS[0]);
  }
}

async function tryMain(reason: string): Promise<void> {
  if (!autoLineEnabled() || picking) return;
  picking = true;
  try {
    await cancellation;
    if (!autoLineEnabled()) return;
    const result = await api.lineTryMain();
    if (result.cancelled || !autoLineEnabled()) return;
    logLine(`[line] main(${reason}) ok=${result.probe.ok} ms=${result.probe.ms} switched=${result.switched}`);
    if (result.switched) {
      window.dispatchEvent(new CustomEvent("hg:line", {
        detail: { region: "intl", host: hostOf(result.base), ms: result.probe.ms },
      }));
      window.dispatchEvent(new Event("hg:line-changed"));
    }
  } catch (error) {
    logLine(`[line] main(${reason}) failed: ${(error as Error).message}`);
  } finally {
    picking = false;
  }
}

async function check(reason: string): Promise<void> {
  if (!autoLineEnabled() || checking) return;
  if (picking) {
    schedule(HEALTH_STEPS[step]);
    return;
  }
  checking = true;
  try {
    const health = await api.lineHealth();
    if (health.ok) {
      downStreak = 0;
      step = Math.min(step + 1, HEALTH_STEPS.length - 1);
      if (hostOf(health.base) !== "huangguoai.com") await tryMain(reason);
      schedule(HEALTH_STEPS[step]);
      return;
    }
    downStreak += 1;
    logLine(`[line] health(${reason}) down=${downStreak} base=${hostOf(health.base)} ms=${health.ms}`);
    tracePlayback("line.health", { reason, line: hostOf(health.base), down: downStreak, ms: health.ms, status: health.status });
    if (downStreak < 2) {
      schedule(RECHECK_MS);
      return;
    }
    downStreak = 0;
    step = 0;
    await pickLine(reason, true);
  } catch (error) {
    logLine(`[line] health(${reason}) failed: ${(error as Error).message}`);
    schedule(HEALTH_STEPS[step]);
  } finally {
    checking = false;
  }
}

function attach() {
  if (attached) return;
  attached = true;
  setNetObserver((result) => {
    if (!autoLineEnabled()) return;
    if (!result.cmd.startsWith("api_")) return;
    if (result.ok) { failStreak = 0; return; }
    if (!result.networkish || ++failStreak < 2) return;
    failStreak = 0;
    void check("api-fail");
  });
  window.addEventListener("online", () => { step = 0; void pickLine("online"); });
  window.addEventListener("offline", () => schedule(30_000));
  window.addEventListener("hg:proxy-changed", () => {
    // Backend invalidates outstanding selections on save. Keep the selected
    // line and let a fresh health check evaluate the new route after settling.
    failStreak = 0;
    downStreak = 0;
    step = 0;
    lastPickAt = null;
    schedule(RECHECK_MS);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopTimer();
    else { downStreak = 0; step = 0; void check("visible"); }
  });
  schedule(HEALTH_STEPS[0]);
}

export function initAutoLine(): void {
  if (started) return;
  started = true;
  if (!autoLineEnabled()) return;
  attach();
  void pickLine("boot");
}
