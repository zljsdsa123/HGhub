import { useEffect, useState, type ReactNode } from "react";
import { api, hostOf, isMobile, type LineItem, type LineProbe, type LineState } from "../api";
import { tracePlayback } from "../playbackDiagnostics";
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
      <button onClick={() => onPick(item.url)} disabled={disabled} className="flex-1 min-w-0 text-left pressable disabled:opacity-60">
        <div className="flex items-center gap-1.5 text-[12.5px] text-on">
          <span className="truncate">{item.name || item.host || hostOf(item.url)}</span>
          {current && <ICheck size={13} className="text-mint shrink-0" />}
        </div>
        <div className="text-[10.5px] text-mut truncate mt-0.5">{item.url}</div>
      </button>
      <span
        title={probe ? (probe.error || (probe.status ? `HTTP ${probe.status}` : "")) : ""}
        className={`text-[10.5px] tabular-nums shrink-0 ${probe ? (probe.ok ? "text-mint" : "text-danger") : "text-dim"}`}>
        {busy ? "…" : probe ? (probe.ok ? `${probe.ms}ms` : probe.status ? `HTTP ${probe.status}` : "失败") : "—"}
      </span>
      <button onClick={() => onProbe(item.url)} disabled={busy || disabled}
        className="shrink-0 h-7 px-2.5 rounded-(--r-sm) bg-s4 text-[11px] text-on/80 pressable disabled:opacity-50">检测</button>
    </div>
  );
}

/* 分组头：标题 + 说明 + 右侧动作。三组共用，别再有的按钮在头、有的在尾 */
function GroupHead({ title, hint, actions }: { title: string; hint: string; actions?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 mt-4 mb-1.5 first:mt-1">
      <span className="text-[10.5px] font-semibold text-dim tracking-wide shrink-0">{title}</span>
      <span className="text-[10px] text-dim truncate min-w-0 flex-1">{hint}</span>
      {actions && <div className="ml-auto shrink-0 flex items-center gap-2.5">{actions}</div>}
    </div>
  );
}
/* 线路选择：桌面居中弹窗，移动端底部抽屉 */
export default function LinePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast, setUser } = useStore();
  const [state, setState] = useState<LineState | null>(null);
  const [mirrors, setMirrors] = useState<LineItem[] | null>(null);
  const [recommended, setRecommended] = useState<LineItem[] | null>(null);
  const [mirrorErr, setMirrorErr] = useState("");
  const [loadingMirrors, setLoadingMirrors] = useState(false);
  const [probes, setProbes] = useState<ProbeMap>({});
  const [probing, setProbing] = useState("");
  const [switching, setSwitching] = useState("");

  const readState = () => {
    api.lineState().then(setState).catch((e) => toast((e as Error).message || "读取线路失败", "info"));
  };

  const readMirrors = async () => {
    setLoadingMirrors(true);
    setMirrorErr("");
    try {
      const res = await api.lineMirrors();
      setMirrors(res?.items || []);
      setRecommended(res?.recommended || []);
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
    readState();
    if (mirrors === null) void readMirrors();
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

  const pick = async (url: string) => {
    if (switching || state?.base === url) return;
    setSwitching(url);
    try {
      const next = await api.lineSet(url);
      tracePlayback("line.manual", { line: hostOf(next), prev: hostOf(state?.base ?? ""), ok: true });
      if (next !== state?.base) setUser(null);
      setState((s) => (s ? { ...s, base: next } : s));
      toast(`线路已切换到 ${hostOf(next)}，跨站点需重新登录`, "ok");
      // 走的是新域名了，列表页得重新拉一遍，否则还是旧线路的内容
      window.dispatchEvent(new Event("hg:line-changed"));
    } catch (e) {
      tracePlayback("line.manual", { line: hostOf(url), ok: false, err: (e as Error).message });
      toast((e as Error).message || "切换失败", "info");
    } finally {
      setSwitching("");
    }
  };

  const fixed = state?.fixed || [];
  const busyAll = !!probing || !!switching;

  const body = (
    <div className="flex flex-col min-h-0" style={{ maxHeight: isMobile ? "74vh" : "min(72vh, 620px)" }}>
      <div className="shrink-0 flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><ISettings size={16} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-bold text-on leading-tight">线路</div>
          <div className="text-[10.5px] text-mut mt-0.5 truncate">当前：{state ? hostOf(state.base) : "读取中…"}</div>
        </div>
        <button onClick={onClose} aria-label="关闭" className="w-8 h-8 rounded-full bg-s3/80 flex items-center justify-center text-mut pressable"><IClose size={16} /></button>
      </div>

      <div className="flex-1 scroll-y px-3 pb-4">
        <GroupHead
          title="固定线路"
          hint="需代理 / 非大陆网络"
          actions={
            <button onClick={() => probe(fixed, "fixed")} disabled={busyAll || !fixed.length}
              className="text-[10.5px] text-primary pressable disabled:opacity-50">
              {probing === "fixed" ? "检测中…" : "全部检测"}
            </button>
          }
        />
        <div className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {fixed.map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} disabled={busyAll} onPick={pick} onProbe={(u) => probe([{ url: u }], u)} />
          ))}
          {!fixed.length && <div className="px-3.5 py-3 text-[11px] text-mut">读取中…</div>}
        </div>

        <GroupHead
          title="推荐镜像"
          hint="发布页每次换一批 · 当前线路置顶"
          actions={
            recommended?.length ? (
              <button onClick={() => probe(recommended, "recommended")} disabled={busyAll}
                className="text-[10.5px] text-primary pressable disabled:opacity-50">
                {probing === "recommended" ? "检测中…" : `全部检测（${recommended.length}）`}
              </button>
            ) : undefined
          }
        />
        <div className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {loadingMirrors && <div className="flex justify-center py-6"><div className="w-6 h-6 spinner" /></div>}
          {!loadingMirrors && !recommended?.length && (
            <div className="px-3.5 py-3 text-[11px] text-mut">推荐页里没有可用的镜像地址</div>
          )}
          {!loadingMirrors && (recommended || []).map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} disabled={busyAll} onPick={pick} onProbe={(u) => probe([{ url: u }], u)} />
          ))}
        </div>

        <GroupHead
          title="镜像线路"
          hint="一般可直连"
          actions={
            <>
              <button onClick={() => { void readMirrors(); }} disabled={loadingMirrors}
                className="inline-flex items-center gap-1 text-[10.5px] text-primary pressable disabled:opacity-50">
                <IRefresh size={12} />{loadingMirrors ? "获取中…" : "刷新"}
              </button>
              {!!mirrors?.length && (
                <button onClick={() => probe(mirrors, "mirrors")} disabled={busyAll}
                  className="text-[10.5px] text-primary pressable disabled:opacity-50">
                  {probing === "mirrors" ? "检测中…" : `全部检测（${mirrors.length}）`}
                </button>
              )}
            </>
          }
        />
        <div className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {loadingMirrors && <div className="flex justify-center py-6"><div className="w-6 h-6 spinner" /></div>}
          {!loadingMirrors && mirrorErr && (
            <div className="px-3.5 py-3">
              <div className="text-[11.5px] text-danger">镜像线路获取失败</div>
              <div className="text-[10.5px] text-mut mt-1 break-all">{mirrorErr}</div>
            </div>
          )}
          {!loadingMirrors && !mirrorErr && mirrors?.length === 0 && (
            <div className="px-3.5 py-3 text-[11px] text-mut">地址发布页里没有可用的镜像地址</div>
          )}
          {!loadingMirrors && (mirrors || []).map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} disabled={busyAll} onPick={pick} onProbe={(u) => probe([{ url: u }], u)} />
          ))}
        </div>

        <div className="text-[10px] text-dim leading-relaxed px-1 mt-4">
          切换后立即生效，请求链路与数据模型不变。这里的「检测」只探这一次；
          日常的自动选线在 设置 → 网络 → 自动选择线路。
        </div>
      </div>
    </div>
  );

  return isMobile
    ? <Sheet open={open} onClose={onClose}>{body}</Sheet>
    : <Modal open={open} onClose={onClose} width={460}>{body}</Modal>;
}
