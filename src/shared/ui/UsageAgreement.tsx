import { useEffect, useRef, useState } from "react";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { platform } from "../api/api";
import { acceptUsageAgreement, USAGE_AGREEMENT_VERSION } from "../storage/usageAgreement";
import "../../styles/usage-agreement.css";
import type { RegisterStartupBack } from "../lib/back";

/** Shared verbatim text for first-run signing and read-only review in Settings. */
export function UsageAgreementText() {
  return <div className="hg-agreement-text select-text">
    <section className="hg-agreement-region"><h2>1. 中国大陆下载与传播限制</h2><p><strong>禁止在中国大陆地区下载、复制、分享、传播本软件及通过本软件获取的相关资源；不得提供相关下载链接或传播服务。</strong>本条亦适用于相关安装包、更新包、镜像与转发。若不符合本条要求，请停止获取、传播本应用并退出。</p></section>
    <section><h2>2. 年龄与使用资格</h2><p>你须年满 18 周岁，且达到所在地适用法律要求的年龄。你应自行确认使用行为符合所在地法律、内容来源服务条款和平台规则；不符合条件时，请停止使用。</p></section>
    <section><h2>3. 第三方内容与权利</h2><p>应用中可能展示第三方提供的内容、标签、封面及媒体地址。相关内容的权利属于各自权利人；本应用的可访问性不代表你已获得复制、下载或传播授权。你应仅访问有权访问的内容，不得侵犯著作权、隐私权及其他合法权益。本项目采用 PolyForm Noncommercial 1.0.0 许可；使用和再分发须遵守该许可及其他适用授权，本协议不额外授予商业使用权。</p></section>
    <section><h2>4. 使用风险与责任</h2><p>第三方内容、网络线路和服务可能变更或中断，项目维护者不保证其准确性、完整性、适宜性或持续可用性。请自行备份重要数据。你应对自己的操作及违法、侵权行为依法承担责任。</p></section>
    <section><h2>5. 免责边界</h2><p>在适用法律允许的范围内，项目维护者对第三方内容、服务中断及非其原因造成的损失不承担责任。本协议不排除或限制依法不得免除的责任，也不剥夺你依法享有的权利。</p></section>
    <section><h2>6. 协议确认</h2><p>勾选确认并点击“签署同意并继续”，表示你已阅读、理解并同意本协议，尤其是中国大陆下载与传播限制。本机仅记录协议版本和确认时间，不要求提交姓名、证件或手写签名。</p></section>
  </div>;
}

export default function UsageAgreement({ onAccept, registerBack, active = true }: { onAccept: () => void; registerBack?: RegisterStartupBack; active?: boolean }) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [error, setError] = useState("");
  const [exiting, setExiting] = useState(false);

  useEffect(() => { if (active) titleRef.current?.focus({ preventScroll: true }); }, [active, declined]);
  useEffect(() => {
    if (!active || registerBack) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); setDeclined(true); }
      if (event.key !== "Tab") return;
      const controls = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])];
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) return;
      if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement as HTMLElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement as HTMLElement))) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, registerBack]);
  useEffect(() => {
    if (!active) return;
    if (registerBack) return registerBack(() => setDeclined(true));
    if (platform !== "android") return;
    let disposed = false;
    let listener: { unregister: () => Promise<void> } | undefined;
    void addPluginListener("app", "back-button", () => setDeclined(true)).then(handle => {
      if (disposed) void handle.unregister().catch(() => {});
      else listener = handle;
    }).catch(() => {});
    return () => { disposed = true; void listener?.unregister().catch(() => {}); };
  }, [active, registerBack]);

  const accept = () => {
    if (!confirmed) return;
    setError("");
    try {
      acceptUsageAgreement();
      onAccept();
    } catch {
      setError("协议确认未保存，请检查应用存储权限后重试。");
    }
  };

  const exit = () => {
    setExiting(true);
    void invoke("plugin:app|exit", { code: 0 }).catch(() => setError("应用尚未进入主界面，你可以直接关闭窗口。")).finally(() => setExiting(false));
  };

  return <div className="hg-agreement" inert={!active} data-tv-modal={active ? "agreement" : undefined} role="dialog" aria-modal="true" aria-labelledby="hg-agreement-title" aria-describedby="hg-agreement-summary">
    <div ref={panelRef} className="hg-agreement-card">
      <header className="hg-agreement-header">
        <h1 ref={titleRef} tabIndex={-1} id="hg-agreement-title">{declined ? "应用尚未启动" : "使用条款与免责声明"}</h1>
        <p id="hg-agreement-summary" className="hg-agreement-summary">{declined ? "你尚未同意协议，主界面与内容不会加载。你可以关闭应用，或返回重新阅读。" : "请阅读以下条款，特别是地区限制。同意记录仅保存在本设备，条款更新后需重新确认。"}</p>
      </header>
      {!declined && <div className="hg-agreement-scroll" data-tv-focus="agreement-text" data-tv-scroll data-tv-initial tabIndex={0} aria-label="协议正文">
        <UsageAgreementText />
      </div>}
      <footer className="hg-agreement-footer">
        {error && <p className="hg-agreement-error" role="alert">{error}</p>}
        {!declined && <label className="hg-agreement-check"><input data-tv-focus="agreement-checkbox" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
          <span>我已阅读并同意以上条款，符合年龄要求，并承诺遵守中国大陆下载与传播限制。</span>
        </label>}
        <div className="hg-agreement-actions">
          {declined ? <>
            {platform !== "ios" && <button data-tv-focus="agreement-exit" type="button" className="hg-agreement-exit" onClick={exit} disabled={exiting}>退出应用</button>}
            <button data-tv-focus="agreement-read" type="button" className="hg-agreement-accept" onClick={() => { setDeclined(false); setConfirmed(false); setError(""); }}>返回阅读</button>
          </> : <>
            <button data-tv-focus="agreement-decline" type="button" className="hg-agreement-exit" onClick={() => { setDeclined(true); setConfirmed(false); }}>不同意</button>
            <button data-tv-focus="agreement-accept" type="button" className="hg-agreement-accept" disabled={!confirmed} onClick={accept}>签署同意并继续</button>
          </>}
        </div>
        <p className="hg-agreement-footnote">协议版本 {USAGE_AGREEMENT_VERSION}</p>
      </footer>
    </div>
  </div>;
}
