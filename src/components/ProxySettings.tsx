import { useEffect, useRef, useState } from "react";
import { api, isMobile, type ProxyMode, type ProxyProbe, type ProxyState } from "../api";
import { useStore } from "../store";
import { IChevR, IClose, ILink } from "../icons";
import { Button, Input, SegmentedControl } from "./ios/controls";
import { Modal, Sheet } from "./ui";

const MODES: ProxyMode[] = ["system", "custom", "off"];
const LABELS: Record<ProxyMode, string> = { system: "跟随系统", custom: "自定义", off: "直连" };
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : typeof error === "string" ? error : fallback;

function summary(state: ProxyState | null, failed: boolean): string {
  if (!state) return failed ? "读取失败，点开后重试" : "读取中…";
  if (state.mode === "off") return "直连 · 忽略系统代理和环境变量";
  if (state.effective) return `${LABELS[state.mode]} · ${state.effective}`;
  return state.mode === "custom" ? "自定义代理" : state.system_proxy || state.env_proxy ? "跟随系统 · 已检测到代理" : "跟随系统 · 未检测到代理";
}

/** Uses the same shared controls as the line picker and keeps proxy credentials out of summaries/logs. */
export default function ProxySettings() {
  const { toast } = useStore();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ProxyState | null>(null);
  const [mode, setMode] = useState<ProxyMode>("system");
  const [url, setUrl] = useState("");
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  const [probe, setProbe] = useState<ProxyProbe | null>(null);
  const request = useRef(0);
  const probeGeneration = useRef(0);
  const pending = useRef(false);

  const read = async (fillDraft: boolean) => {
    const generation = ++request.current;
    setLoading(true);
    setLoadError("");
    if (fillDraft) setReady(false);
    try {
      const next = await api.proxyState();
      if (generation !== request.current) return;
      setState(next);
      if (fillDraft) {
        setMode(next.mode);
        setUrl(next.url || "");
        setReady(true);
      }
    } catch (failure) {
      if (generation === request.current) setLoadError(message(failure, "代理设置读取失败，请重试"));
    } finally {
      if (generation === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    void read(false);
    const invalidateProbe = () => { probeGeneration.current++; setProbe(null); };
    window.addEventListener("hg:line-changed", invalidateProbe);
    return () => { request.current++; probeGeneration.current++; window.removeEventListener("hg:line-changed", invalidateProbe); };
  }, []);

  const openForm = () => {
    setOpen(true);
    setVisible(false);
    setProbe(null);
    setError("");
    void read(true);
  };
  const close = () => {
    if (pending.current) return;
    request.current++;
    setOpen(false);
    setVisible(false);
  };
  const change = () => { probeGeneration.current++; setProbe(null); setError(""); };
  const run = async (action: "test" | "save") => {
    if (pending.current || !ready) return;
    if (mode === "custom" && !url.trim()) {
      setError("请填写代理地址");
      return;
    }
    pending.current = true;
    setBusy(action);
    setError("");
    setProbe(null);
    const generation = ++probeGeneration.current;
    try {
      if (action === "test") {
        const result = await api.proxyTest(mode, mode === "custom" ? url.trim() : "");
        if (generation === probeGeneration.current) setProbe(result);
        else setError("线路已更新，请重新检测当前线路");
      } else {
        const next = await api.proxySet(mode, mode === "custom" ? url.trim() : "");
        setState(next);
        setMode(next.mode);
        setUrl(next.url || "");
        setOpen(false);
        setVisible(false);
        window.dispatchEvent(new Event("hg:proxy-changed"));
        toast(`代理设置已保存 · ${LABELS[next.mode]}`, "ok");
      }
    } catch (failure) {
      setError(message(failure, action === "test" ? "代理检测失败" : "代理设置保存失败"));
    } finally {
      pending.current = false;
      setBusy("");
    }
  };

  const disabled = !ready || loading || !!busy;
  const body = <div className="flex flex-col min-h-0" style={{ maxHeight: isMobile ? "74vh" : "min(78vh, 640px)" }}>
    <div className="shrink-0 flex items-center gap-3 px-4 pt-3 pb-2">
      <span className="ios-setting-icon" aria-hidden="true"><ILink size={16} /></span>
      <h2 className="flex-1 text-[16px] font-bold text-on">代理访问</h2>
      <Button aria-label="关闭代理设置" disabled={!!busy} onClick={close} className="min-h-12 min-w-12 flex items-center justify-center"><IClose size={18} /></Button>
    </div>
    <form className="scroll-y px-4 pb-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void run("save"); }}>
      <p className="text-[13px] text-mut leading-relaxed">只应用于 HGhubX。测试当前草稿的连通性后，可保存为应用的网络设置。</p>
      {loadError && <div role="alert" className="text-[13px] text-danger">
        {loadError}
        <Button onClick={() => { void read(true); }} disabled={loading} className="min-h-12 px-3 ml-1 text-primary">重新读取</Button>
      </div>}
      {loading && <p role="status" className="text-[13px] text-mut">正在读取代理设置…</p>}
      <SegmentedControl aria-label="代理模式" activeIndex={MODES.indexOf(mode)}>
        {MODES.map(value => <Button key={value} disabled={disabled} aria-pressed={mode === value}
          className="min-h-12" onClick={() => { setMode(value); change(); }}>{LABELS[value]}</Button>)}
      </SegmentedControl>
      {mode === "custom" && <div>
        <label htmlFor="proxy-address" className="block text-[14px] text-on mb-2">代理地址</label>
        <Input id="proxy-address" aria-label="代理地址" type={visible ? "text" : "password"} value={url}
          disabled={disabled} autoComplete="off" autoCapitalize="none" spellCheck={false}
          placeholder="http://127.0.0.1:7890" aria-invalid={!!error} aria-describedby={`proxy-address-hint${error ? " proxy-form-error" : ""}`}
          className="w-full min-h-12 min-w-0 text-[14px]" onChange={event => { setUrl(event.target.value); change(); }} />
        <div className="flex items-start gap-2 mt-1">
          <p id="proxy-address-hint" className="flex-1 text-[12px] text-mut leading-relaxed pt-2">支持 HTTP、HTTPS、SOCKS。手机上的 127.0.0.1 指手机自身；使用电脑代理时填写电脑的局域网地址。</p>
          <Button onClick={() => setVisible(value => !value)} aria-pressed={visible} className="min-h-12 shrink-0 px-2 text-[12px] text-primary">{visible ? "隐藏地址" : "显示地址"}</Button>
        </div>
      </div>}
      {mode !== "custom" && <p className="text-[13px] text-mut leading-relaxed">{mode === "system" ? "沿用系统代理与环境变量；保存过的自定义地址仍会保留。" : "直接连接当前线路，忽略系统代理与环境变量；保存过的自定义地址仍会保留。"}</p>}
      {error && <p id="proxy-form-error" role="alert" className="text-[13px] text-danger break-words">{error}</p>}
      <div role="status" aria-live="polite" className={`text-[13px] break-words ${probe && !probe.ok ? "text-danger" : "text-mut"}`}>
        {busy === "test" ? "正在检测当前草稿…" : probe ? probe.ok ? `可用 · ${probe.ms}ms` : `连接失败 · ${probe.error || (probe.status ? `HTTP ${probe.status}` : "请检查地址和网络")}` : "检测只测试当前草稿，保存后才会生效。"}
      </div>
      <div className="flex gap-3">
        <Button variant="secondary" disabled={disabled} onClick={() => { void run("test"); }} className="min-h-12 flex-1 px-3">{busy === "test" ? "检测中…" : "测试连接"}</Button>
        <Button variant="primary" type="submit" disabled={disabled} className="min-h-12 flex-1 px-3">{busy === "save" ? "保存中…" : "保存代理"}</Button>
      </div>
    </form>
  </div>;

  return <>
    <Button onClick={openForm} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
      <span className="ios-setting-icon" aria-hidden="true"><ILink size={16} /></span>
      <div className="flex-1 min-w-0"><div className="text-[14px] text-on">代理访问</div><div className="text-[12px] text-mut truncate">{summary(state, !!loadError)}</div></div>
      <IChevR size={15} className="text-mut" />
    </Button>
    {isMobile ? <Sheet open={open} onClose={close} label="代理访问">{body}</Sheet> : <Modal open={open} onClose={close} label="代理访问" width={460}>{body}</Modal>}
  </>;
}
