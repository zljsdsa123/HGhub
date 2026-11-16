import { Button, Input, Surface } from "./ios/controls";
import { Loader } from "./ios/effects";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, hostOf, isMobile, type LineApply, type LineItem, type LineProbe, type LineState } from "../api";
import { tracePlayback } from "../playbackDiagnostics";
import { autoLineEnabled, setAutoLine } from "../autoLine";
import { useStore } from "../store";
import { Modal, Sheet } from "./ui";
import { ICheck, IClose, IRefresh, ISettings } from "../icons";

type ProbeMap = Record<string, LineProbe>;

/* 单条线路：左侧点一下即切换，右侧单独检测 */
function Row({ item, current, probe, busy, disabled, onPick, onProbe }: {
  item: LineItem; current: boolean; probe?: LineProbe; busy: boolean; disabled: boolean;
  onPick: (url: string) => void; onProbe: (url: string) => void;
}) {
  return (
    <div className={`flex items-center gap-2 px-3.5 py-2.5 ${current ? "bg-s3/70" : ""}`}>
      <Button onClick={() => onPick(item.url)} disabled={disabled} className="flex-1 min-w-0 text-left pressable disabled:opacity-60">
        <div className="flex items-center gap-1.5 text-[14px] text-on">
          <span className="truncate">{item.name || item.host || hostOf(item.url)}</span>
          {current && <ICheck size={13} className="text-mint shrink-0" />}
        </div>
        <div className="text-[12px] text-mut truncate mt-0.5">{item.url}</div>
      </Button>
      <span
        title={probe ? (probe.error || (probe.status ? `HTTP ${probe.status}` : "")) : ""}
        className={`text-[12px] tabular-nums shrink-0 ${probe ? (probe.ok ? "text-mint" : "text-danger") : "text-dim"}`}>
        {busy ? "…" : probe ? (probe.ok ? `${probe.ms}ms` : probe.status ? `HTTP ${probe.status}` : "失败") : "—"}
      </span>
      <Button onClick={() => onProbe(item.url)} disabled={busy || disabled}
        className="shrink-0 h-7 px-2.5 rounded-(--r-sm) bg-s4 text-[12px] text-on/80 pressable disabled:opacity-50">检测</Button>
    </div>
  );
}

/* 分组头：标题 + 说明 + 右侧动作。 */
function GroupHead({ title, hint, actions }: { title: string; hint: string; actions?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 mt-4 mb-1.5 first:mt-1">
      <span className="text-[12px] font-semibold text-dim tracking-wide shrink-0">{title}</span>
      <span className="text-[12px] text-dim truncate min-w-0 flex-1">{hint}</span>
      {actions && <div className="ml-auto shrink-0 flex items-center gap-2.5">{actions}</div>}
    </div>
  );
}
/* 线路选择：桌面居中弹窗，移动端底部抽屉 */
export default function LinePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast, setUser } = useStore();
  const [state, setState] = useState<LineState | null>(null);
  const [mirrors, setMirrors] = useState<LineItem[] | null>(null);
  const [mirrorErr, setMirrorErr] = useState("");
  const [loadingMirrors, setLoadingMirrors] = useState(false);
  const [probes, setProbes] = useState<ProbeMap>({});
  const [probing, setProbing] = useState("");
  const [switching, setSwitching] = useState("");
  const [custom, setCustom] = useState("");
  const [customError, setCustomError] = useState("");
  const [stateError, setStateError] = useState("");
  const [ready, setReady] = useState(false);
  const stateRequest = useRef(0);
  const applying = useRef(false);

  const readState = (fillDraft = false) => {
    const request = ++stateRequest.current;
    setStateError("");
    if (fillDraft) setReady(false);
    api.lineState().then(next => {
      if (request !== stateRequest.current || applying.current) return;
      setState(next);
      setReady(true);
      if (fillDraft) setCustom(next.custom ? next.base : "");
    }).catch((e) => {
      if (request === stateRequest.current) {
        setReady(false);
        setStateError((e as Error).message || "读取线路失败");
      }
    });
  };

  const readMirrors = async () => {
    setLoadingMirrors(true);
    setMirrorErr("");
    try {
      const res = await api.lineMirrors();
      setMirrors(res?.items || []);
    } catch (e) {
      setMirrors([]);
      setMirrorErr((e as Error).message || "镜像线路获取失败");
    } finally {
      setLoadingMirrors(false);
    }
  };

  /* 镜像线路只在用户点开「线路」后才去拉，拉过一次就留在内存里，可手动刷新 */
  useEffect(() => {
    if (!open) return;
    readState(true);
    setCustomError("");
    if (mirrors === null) void readMirrors();
    return () => { stateRequest.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const sync = () => readState();
    window.addEventListener("hg:line-changed", sync);
    return () => window.removeEventListener("hg:line-changed", sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const probe = async (list: LineItem[], key: string) => {
    if (!list.length) return;
    setProbing(key);
    try {
      const res = await api.lineProbe(list.map((x) => x.url));
      setProbes((p) => {
        const next = { ...p };
        for (const r of res) next[r.url] = r;
        return next;
      });
    } catch (e) {
      toast((e as Error).message || "检测失败", "info");
    } finally {
      setProbing("");
    }
  };

  const applyLine = async (key: string, apply: () => Promise<LineApply>) => {
    if (applying.current || !ready) return;
    const wasAuto = autoLineEnabled();
    applying.current = true;
    stateRequest.current++;
    setSwitching(key);
    setCustomError("");
    try {
      await setAutoLine(false);
      const next = await apply();
      tracePlayback("line.manual", { line: hostOf(next.base), prev: hostOf(state?.base ?? ""), custom: next.custom, ok: true });
      if (next.base !== state?.base) setUser(null);
      setState((s) => (s ? { ...s, ...next } : s));
      if (key === "custom" || key === "reset") setCustom(next.custom ? next.base : "");
      toast(`线路已切换到 ${hostOf(next.base)}，已使用手动选线，跨站点需重新登录`, "ok");
      // 走的是新域名了，列表页得重新拉一遍，否则还是旧线路的内容
      window.dispatchEvent(new Event("hg:line-changed"));
    } catch (e) {
      if (wasAuto) void setAutoLine(true);
      const error = (e as Error).message || "切换失败";
      tracePlayback("line.manual", { ok: false, err: error });
      if (key === "custom" || key === "reset") setCustomError(error);
      else toast(error, "info");
    } finally {
      applying.current = false;
      setSwitching("");
    }
  };

  const pick = (url: string) => {
    if (state?.base === url) return;
    void applyLine(url, async () => ({ base: await api.lineSet(url), custom: false }));
  };
  const saveCustom = () => {
    const raw = custom.trim();
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error();
    } catch {
      setCustomError("请填写 HTTPS 站点根地址，不带路径、参数或账号密码");
      return;
    }
    void applyLine("custom", () => api.lineCustomSet(raw));
  };

  const fixed = state?.fixed || [];
  const mirrorItems = [...(mirrors || [])].sort((a, b) => Number(b.url === state?.base) - Number(a.url === state?.base));
  const busyAll = !!probing || !!switching || !ready;
  const close = () => { if (!applying.current) onClose(); };

  const body = (
    <div className="flex flex-col min-h-0" style={{ maxHeight: isMobile ? "74vh" : "min(72vh, 620px)" }}>
      <div className="shrink-0 flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><ISettings size={16} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-bold text-on leading-tight">线路</div>
          <div className="text-[12px] text-mut mt-0.5 truncate">当前：{state ? hostOf(state.base) : "读取中…"}</div>
        </div>
        <Button onClick={close} disabled={!!switching} aria-label="关闭" className="min-w-12 min-h-12 rounded-full bg-s3/80 flex items-center justify-center text-mut pressable"><IClose size={16} /></Button>
      </div>

      <div className="flex-1 scroll-y px-3 pb-4">
        {stateError && <div role="alert" className="text-[13px] text-danger px-1">
          {stateError}<Button className="min-h-12 px-3 text-primary" onClick={() => readState(true)}>重新读取</Button>
        </div>}
        <GroupHead title="自定义镜像" hint="保存后使用手动选线" />
        <Surface className="rounded-(--r-md) bg-s2 px-3.5 py-3">
          <form onSubmit={event => { event.preventDefault(); saveCustom(); }}>
            <label htmlFor="custom-line-address" className="block text-[14px] text-on mb-2">镜像地址</label>
            <Input id="custom-line-address" aria-label="镜像地址" value={custom} disabled={busyAll}
              className="min-h-12 w-full min-w-0 text-[14px]" type="url" inputMode="url" autoCapitalize="none" autoComplete="off" spellCheck={false}
              placeholder="https://mirror.example.com" aria-invalid={!!customError}
              aria-describedby={`custom-line-hint${customError ? " custom-line-error" : ""}`}
              onChange={event => { setCustom(event.target.value); setCustomError(""); }} />
            <p id="custom-line-hint" className="text-[12px] text-mut leading-relaxed mt-2">填写你信任的 HTTPS 站点。登录请求会发送到该站点；切换到其他站点后需重新登录。</p>
            {customError && <p id="custom-line-error" role="alert" className="text-[13px] text-danger break-words mt-2">{customError}</p>}
            <div className="flex gap-2 mt-3">
              <Button variant="secondary" disabled={busyAll} onClick={() => { void applyLine("reset", api.lineReset); }} className="min-h-12 px-3 flex-1">{switching === "reset" ? "恢复中…" : "恢复主站"}</Button>
              <Button variant="primary" disabled={busyAll} type="submit" className="min-h-12 px-3 flex-1">{switching === "custom" ? "保存中…" : "保存镜像"}</Button>
            </div>
          </form>
        </Surface>
        <GroupHead
          title="固定线路"
          hint="需代理 / 非大陆网络"
          actions={
            <Button onClick={() => probe(fixed, "fixed")} disabled={busyAll || !fixed.length}
              className="text-[12px] text-primary pressable disabled:opacity-50">
              {probing === "fixed" ? "检测中…" : "全部检测"}
            </Button>
          }
        />
        <Surface className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {fixed.map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} disabled={busyAll} onPick={pick} onProbe={(u) => probe([{ url: u }], u)} />
          ))}
          {!fixed.length && <div className="px-3.5 py-3 text-[12px] text-mut">读取中…</div>}
        </Surface>

        <GroupHead
          title="镜像线路"
          hint="来自地址发布页"
          actions={
            <>
              <Button onClick={() => { void readMirrors(); }} disabled={loadingMirrors}
                className="inline-flex items-center gap-1 text-[12px] text-primary pressable disabled:opacity-50">
                <IRefresh size={12} />{loadingMirrors ? "获取中…" : "刷新"}
              </Button>
              {!!mirrorItems.length && (
                <Button onClick={() => probe(mirrorItems, "mirrors")} disabled={busyAll}
                  className="text-[12px] text-primary pressable disabled:opacity-50">
                  {probing === "mirrors" ? "检测中…" : `全部检测（${mirrorItems.length}）`}
                </Button>
              )}
            </>
          }
        />
        <Surface className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {loadingMirrors && <div className="flex justify-center py-6"><Loader className="w-6 h-6 spinner" /></div>}
          {!loadingMirrors && mirrorErr && (
            <div className="px-3.5 py-3">
              <div className="text-[12px] text-danger">镜像线路获取失败</div>
              <div className="text-[12px] text-mut mt-1 break-all">{mirrorErr}</div>
            </div>
          )}
          {!loadingMirrors && !mirrorErr && mirrors?.length === 0 && (
            <div className="px-3.5 py-3 text-[12px] text-mut">地址发布页里没有可用的镜像地址</div>
          )}
          {!loadingMirrors && mirrorItems.map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} disabled={busyAll} onPick={pick} onProbe={(u) => probe([{ url: u }], u)} />
          ))}
        </Surface>

        <div className="text-[12px] text-dim leading-relaxed px-1 mt-4">
          切换后立即生效，请求链路与数据模型不变。这里的「检测」只探这一次；
          日常的自动选线在 设置 → 网络 → 自动选择线路。
        </div>
      </div>
    </div>
  );

  return isMobile
    ? <Sheet open={open} onClose={close} label="选择播放源">{body}</Sheet>
    : <Modal open={open} onClose={close} label="选择播放源" width={460}>{body}</Modal>;
}
