import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { AppProvider, useStore } from "../src/store";
import { ArticlePanel } from "../src/components/Panels";
import { isStrictSecurity, setStrictSecurity } from "../src/html";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let store: ReturnType<typeof useStore>;
function Probe() { store = useStore(); return <ArticlePanel title="test" html={'<p style="color:red">article</p>'} onClose={() => {}} />; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const checks: string[] = [];
function assert(ok: unknown, label: string) { if (!ok) throw new Error(label); checks.push(label); }
const originalBoot = api.boot, originalSave = api.securitySet;
const previousLocal = localStorage.getItem("hghubx_strict_security");
const root = createRoot(document.querySelector("#fixture")!);
try {
  localStorage.setItem("hghubx_strict_security", "0");
  setStrictSecurity(true);
  const boot = deferred<Awaited<ReturnType<typeof api.boot>>>();
  api.boot = () => boot.promise;
  await act(async () => { root.render(<AppProvider><Probe /></AppProvider>); });
  assert(store!.strictSecurity && !store!.strictSecurityReady, "startup defaults strict until backend responds");
  await act(async () => boot.resolve({ user: null, logged_in: false, base: "https://huangguoai.com", strict_security: false }));
  assert(!store!.strictSecurity && store!.strictSecurityReady && !isStrictSecurity(), "backend boot controls effective mode");
  assert(document.querySelector(".article-body p")?.hasAttribute("style"), "open article uses compatible mode");
  const save = deferred<boolean>();
  api.securitySet = () => save.promise;
  let saving!: Promise<void>;
  await act(async () => { saving = store!.setStrictSecurity(true); });
  assert(store!.securityPending && !store!.strictSecurity && !isStrictSecurity(), "pending write does not optimistically change mode");
  await act(async () => { save.resolve(true); await saving; });
  assert(store!.strictSecurity && isStrictSecurity() && !store!.securityPending, "successful backend write updates effective mode");
  assert(!document.querySelector(".article-body p")?.hasAttribute("style"), "already open article rerenders on mode change");
  api.securitySet = async () => { throw new Error("disk unavailable"); };
  let failed = false;
  await act(async () => { try { await store!.setStrictSecurity(false); } catch { failed = true; } });
  assert(failed && store!.strictSecurity && isStrictSecurity() && !store!.securityPending, "failed save keeps backend-confirmed mode and reports failure");
  assert(localStorage.getItem("hghubx_strict_security") === "0", "mode changes do not write a second persisted source");
  document.querySelector("#results")!.textContent = JSON.stringify({ passed: checks.length, failed: 0, checks });
} catch (error) {
  document.querySelector("#results")!.textContent = JSON.stringify({ passed: checks.length, failed: 1, error: String(error), checks });
} finally {
  await act(async () => root.unmount());
  api.boot = originalBoot; api.securitySet = originalSave;
  setStrictSecurity(true);
  if (previousLocal === null) localStorage.removeItem("hghubx_strict_security");
  else localStorage.setItem("hghubx_strict_security", previousLocal);
}
