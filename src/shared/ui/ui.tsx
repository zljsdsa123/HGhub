import { Button, Image, Surface } from "./ios/controls";
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cover, platform } from "../api/api";
import { getFullscreenElement, onFullscreenChange } from "../lib/fullscreen";
export { Sheet, Modal } from "./ios/overlays";
import { useToasts } from "../model/store";
import { Loader } from "./ios/effects";
import { IBoltF, ICheck, IGlobe, IHeartF, IMinus, ISparkF, IStarF } from "./icons";

/* ——— 头像 ——— */
export function Avatar({ hue = 250, icon, name, size = 40, ring = false, className = "" }: {
  hue?: number; icon?: React.ReactNode; name?: string; size?: number; ring?: boolean; className?: string;
}) {
  const inner = (
    <div className="w-full h-full rounded-full flex items-center justify-center overflow-hidden font-semibold"
      style={{ background: `hsl(${hue} 22% 30%)`, color: `hsl(${hue} 70% 88%)` }}>
      {icon ?? <span style={{ fontSize: size * 0.42 }} className="leading-none">{(name || "H").replace(/^@/, "")[0].toUpperCase()}</span>}
    </div>
  );
  return (
    <div className={`shrink-0 ${className}`} style={{ width: size, height: size }}>
      {ring ? <div className="w-full h-full rounded-full p-[2px] bg-primary"><div className="w-full h-full rounded-full bg-bg p-[2px]">{inner}</div></div> : inner}
    </div>
  );
}

/* ——— 开关 ——— */
export function Toggle({ on, onChange, label, disabled = false, desktop = false }: {
  on: boolean; onChange: (b: boolean) => void; label?: string; disabled?: boolean; desktop?: boolean;
}) {
  return (
    <Button disabled={disabled} onClick={() => onChange(!on)} role="switch" aria-checked={on} aria-label={label}
      className="ios-switch" data-platform={desktop ? "desktop" : platform} data-state={on ? "on" : "off"}>
      <span className="ios-switch-track" aria-hidden="true">
        <span className="ios-switch-thumb">
          <ICheck size={14} className="ios-switch-mark is-on" />
          <IMinus size={14} className="ios-switch-mark is-off" />
        </span>
      </span>
    </Button>
  );
}

/* ——— 空状态 ——— */
export function Empty({ icon, title, sub, action, onAction }: {
  icon: React.ReactNode; title: string; sub?: string; action?: string; onAction?: () => void;
}) {
  return (
    <div className="ios-empty flex flex-col items-center justify-center py-16 px-8 text-center a-rise">
      <div className="w-16 h-16 rounded-(--r-md) tonal flex items-center justify-center mb-4">{icon}</div>
      <div className="text-[16px] font-semibold text-on/90">{title}</div>
      {sub && <div className="text-xs text-mut mt-1.5 leading-relaxed">{sub}</div>}
      {action && (
        <Button onClick={onAction} className="mt-5 px-6 h-10 rounded-(--r-ctl) bg-primary text-on-primary text-[14px] font-bold pressable">{action}</Button>
      )}
    </div>
  );
}

/* ——— Toast ——— */
export function ToastHost() {
  const toasts = useToasts();
  const [fsHost, setFsHost] = useState<Element | null>(() => getFullscreenElement());
  useEffect(() => onFullscreenChange(() => setFsHost(getFullscreenElement())), []);
  const content = (
    <div role="status" aria-live="polite" aria-atomic="true" className="ios-toast-host absolute inset-x-0 z-[300] flex flex-col items-center gap-2 pointer-events-none px-6" style={{ bottom: "calc(var(--sab, 0px) + 96px)" }}>
      {toasts.map((t) =>
        t.line ? (
          <div
            key={t.id}
            className="a-toast pointer-events-auto relative flex items-center gap-2.5 max-w-full bg-s4/80 backdrop-blur-2xl rounded-[16px] pl-2 pr-3 py-2 elev-3 ring-1 ring-white/10"
          >
            <span
              className={`grid place-items-center size-9 rounded-[12px] shrink-0 ${
                t.line.region === "cn"
                  ? "bg-mint/15 text-mint"
                  : "bg-cyan/15 text-cyan"
              }`}
            >
              {t.line.region === "cn" ? <IBoltF size={17} /> : <IGlobe size={17} />}
            </span>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold text-on leading-tight">
                {t.line.region === "cn" ? "国内线路" : "国外线路"}
              </div>
              <div className="text-[12px] text-dim leading-tight mt-0.5 truncate">{t.line.host}</div>
            </div>
            <div className="ml-1.5 flex items-baseline gap-0.5 shrink-0 pl-2.5 border-l border-white/10">
              <span
                className={`text-[16px] font-bold tabular-nums ${
                  t.line.ms <= 0
                    ? "text-dim"
                    : t.line.ms < 500
                      ? "text-mint"
                      : t.line.ms < 1000
                        ? "text-amber"
                        : "text-danger"
                }`}
              >
                {t.line.ms > 0 ? t.line.ms : "—"}
              </span>
              {t.line.ms > 0 && <span className="text-[12px] font-semibold text-dim">ms</span>}
            </div>
          </div>
        ) : (
          <Surface key={t.id} className="a-toast pointer-events-auto flex items-center gap-2.5 max-w-full bg-s4/95 backdrop-blur-md rounded-(--r-sm) pl-3.5 pr-4 py-2.5 elev-3">
            {t.icon === "ok" && <ICheck size={16} className="text-mint shrink-0" />}
            {t.icon === "heart" && <IHeartF size={16} className="text-neon shrink-0" />}
            {t.icon === "star" && <IStarF size={16} className="text-amber shrink-0" />}
            {t.icon === "info" && <ISparkF size={15} className="text-cyan shrink-0" />}
            <span className="text-[14px] text-on leading-snug clamp-2 break-words">{t.msg}</span>
          </Surface>
        ),
      )}
    </div>
  );
  return fsHost ? createPortal(content, fsHost) : content;
}

/* ——— 图片（骨架 + 渐显，自动走本地解密协议） ——— */
export function Img({ src, alt = "", className = "", eager = false, raw = false, loadingIndicator = false }: {
  src: string; alt?: string; className?: string; eager?: boolean; raw?: boolean; loadingIndicator?: boolean;
}) {
  const url = raw ? src : cover(src);
  // 每个地址独立持有状态，避免换图后的 effect 把缓存命中的 onLoad 重置掉。
  return <ImageLoad key={url} url={url} alt={alt} className={className} eager={eager} raw={raw} loadingIndicator={loadingIndicator} />;
}

function ImageLoad({ url, alt, className, eager, raw, loadingIndicator }: {
  url: string; alt: string; className: string; eager: boolean; raw: boolean; loadingIndicator: boolean;
}) {
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /* 封面走本地解密代理，网络抖动会偶发失败：同地址重试两次再落到占位。
     代理入口只读 `u`，多余查询参数会被忽略，用它做重试的缓存戳。 */
  const retryUrl = !url || raw || attempt === 0 ? url : `${url}${url.includes("?") ? "&" : "?"}r=${attempt}`;
  return (
    <div className={`ios-image absolute inset-0 overflow-hidden ${className}`} data-ui="image-frame">
      {!ok && !err && <div className="absolute inset-0 shimmer" />}
      {loadingIndicator && !ok && <div className="absolute inset-0 grid place-items-center"><Loader label="封面加载中" /></div>}
      {err && !loadingIndicator && <div className="ios-image-error" role="img" aria-label={alt || "封面暂不可用"}>HG</div>}
      {url && <Image src={retryUrl} alt={alt} loading={eager ? "eager" : "lazy"}
        onLoad={() => { setOk(true); setErr(false); }}
        onError={() => { if (!raw && attempt < 2) setAttempt(attempt + 1); else setErr(true); }}
        className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${ok ? "opacity-100" : "opacity-0"}`} draggable={false} />}
    </div>
  );
}
