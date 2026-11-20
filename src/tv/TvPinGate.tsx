import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Logo } from "../shared/ui/icons";
import { disableTvPin, enableTvPin, unlockTvSession, useTvPin, verifyTvPin } from "./pinLock";
import { focusElement, useRemoteScope, type RemoteKey } from "./remote";
import { TvModal } from "./ui";

const KEYPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "delete"] as const;
const MAX_ATTEMPTS = 5;
const COOLDOWN_SECS = 15;

const isDigitKey = (key: RemoteKey): key is "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" =>
  key.length === 1 && key >= "0" && key <= "9";

function TvPinPad({
  scopeId,
  focusPrefix,
  prompt,
  error,
  cooldownLeft = 0,
  onClearError,
  onComplete,
  onBackEmpty,
}: {
  scopeId: string;
  focusPrefix: string;
  prompt: string;
  error: string;
  cooldownLeft?: number;
  onClearError: () => void;
  onComplete: (pin: string) => void;
  onBackEmpty?: () => void;
}) {
  const [digits, setDigits] = useState("");
  const digitsRef = useRef(digits);
  digitsRef.current = digits;
  const lockedOut = cooldownLeft > 0;

  const appendDigit = useCallback((digit: string) => {
    if (lockedOut) return;
    const prev = digitsRef.current;
    if (prev.length >= 4) return;
    if (error) onClearError();
    const next = `${prev}${digit}`;
    digitsRef.current = next;
    setDigits(next);
    if (next.length === 4) {
      digitsRef.current = "";
      setDigits("");
      onComplete(next);
    }
  }, [lockedOut, error, onClearError, onComplete]);

  const removeLast = useCallback(() => {
    if (!digitsRef.current.length) return false;
    const next = digitsRef.current.slice(0, -1);
    digitsRef.current = next;
    setDigits(next);
    if (error) onClearError();
    return true;
  }, [error, onClearError]);

  const clearAll = useCallback(() => {
    if (!digitsRef.current.length && !error) return;
    digitsRef.current = "";
    setDigits("");
    if (error) onClearError();
  }, [error, onClearError]);

  useRemoteScope({
    id: scopeId,
    priority: 120,
    onKey: key => {
      if (document.querySelector(".hg-launch")) return false;
      if (isDigitKey(key)) {
        appendDigit(key);
        return true;
      }
      if (key === "back" && onBackEmpty) {
        if (!removeLast()) onBackEmpty();
        return true;
      }
      return false;
    },
  });

  const statusText = lockedOut
    ? `连续输错次数过多，请 ${cooldownLeft} 秒后再试`
    : error;

  return (
    <div className="tv-pin-pad">
      <p className="tv-pin-prompt">{prompt}</p>
      <div className="tv-pin-dots" role="status" aria-live="polite" aria-label={`已输入 ${digits.length} 位，共 4 位密码`}>
        {[0, 1, 2, 3].map(index => {
          const filled = index < digits.length;
          const current = !lockedOut && index === digits.length;
          return (
            <span
              key={index}
              className={`tv-pin-dot ${filled ? "is-filled" : ""} ${current ? "is-current" : ""} ${statusText ? "is-error" : ""}`}
              aria-hidden="true"
            >
              {filled ? "●" : ""}
            </span>
          );
        })}
      </div>
      <p className="tv-pin-error" role={statusText ? "alert" : "status"}>{statusText || "\u00A0"}</p>
      <div className="tv-pin-keypad" data-tv-region={`${focusPrefix}-keypad`} data-tv-columns="3">
        {KEYPAD.map(item => {
          if (item === "clear") {
            return (
              <button key={item} type="button" className="tv-pin-action" data-tv-focus={`${focusPrefix}-key-clear`} onClick={clearAll}>
                清空
              </button>
            );
          }
          if (item === "delete") {
            return (
              <button key={item} type="button" className="tv-pin-action" data-tv-focus={`${focusPrefix}-key-delete`} onClick={() => { removeLast(); }}>
                删除
              </button>
            );
          }
          return (
            <button
              key={item}
              type="button"
              data-tv-initial={item === "1" ? "" : undefined}
              data-tv-focus={`${focusPrefix}-key-${item}`}
              aria-label={`数字 ${item}`}
              onClick={() => appendDigit(item)}
            >
              {item}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function usePinCooldown() {
  const [failures, setFailures] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  useEffect(() => {
    if (cooldownLeft <= 0) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [cooldownLeft]);

  const recordFailure = useCallback(() => {
    setFailures(prev => {
      const next = prev + 1;
      if (next >= MAX_ATTEMPTS) {
        const current = Date.now();
        setNow(current);
        setCooldownUntil(current + COOLDOWN_SECS * 1000);
        return 0;
      }
      return next;
    });
  }, []);

  const resetFailures = useCallback(() => {
    setFailures(0);
    setCooldownUntil(0);
  }, []);

  return { failures, cooldownLeft, recordFailure, resetFailures };
}

export type TvPinModalMode = "setup" | "disable" | "change";

export function TvPinSettingsModal({
  mode,
  onClose,
  onDone,
}: {
  mode: TvPinModalMode;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [step, setStep] = useState<"verify" | "enter" | "confirm">(mode === "setup" ? "enter" : "verify");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const { cooldownLeft, recordFailure, resetFailures } = usePinCooldown();

  const title = mode === "setup" ? "设置 4 位启动密码" : mode === "disable" ? "关闭启动密码" : "修改启动密码";
  const prompt = step === "verify"
    ? (mode === "disable" ? "请输入当前 4 位 PIN 码以关闭启动密码" : "请输入当前 4 位 PIN 码")
    : step === "enter"
      ? "请输入新的 4 位数字 PIN 码"
      : "请再次输入相同的 4 位 PIN 码以确认";

  const handleComplete = (code: string) => {
    if (step === "verify") {
      if (!verifyTvPin(code)) {
        recordFailure();
        setError("PIN 码错误，请重试");
        return;
      }
      resetFailures();
      setError("");
      if (mode === "disable") {
        try {
          disableTvPin();
          onDone("启动密码已关闭");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } else {
        setStep("enter");
      }
      return;
    }
    if (step === "enter") {
      setDraft(code);
      setError("");
      setStep("confirm");
      return;
    }
    if (code !== draft) {
      setDraft("");
      setStep("enter");
      setError("两次输入的密码不一致，请重新设置");
      return;
    }
    try {
      enableTvPin(code);
      onDone(mode === "setup" ? "启动密码已开启，下次进入软件生效" : "启动密码已更新");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <TvModal id="settings-pin" title={title} onClose={onClose}>
      <TvPinPad
        scopeId="settings-pin"
        focusPrefix="pin-modal"
        prompt={prompt}
        error={error}
        cooldownLeft={step === "verify" ? cooldownLeft : 0}
        onClearError={() => setError("")}
        onComplete={handleComplete}
      />
    </TvModal>
  );
}

export default function TvPinGate({ children }: { children: ReactNode }) {
  const pin = useTvPin();
  const rootRef = useRef<HTMLElement>(null);
  const [error, setError] = useState("");
  const { cooldownLeft, recordFailure, resetFailures } = usePinCooldown();

  useLayoutEffect(() => {
    if (!pin.locked) return undefined;
    const focusInitial = () => {
      const initial = rootRef.current?.querySelector<HTMLElement>("[data-tv-initial]");
      if (initial && (!document.activeElement || !rootRef.current?.contains(document.activeElement))) {
        focusElement(initial);
      }
    };
    focusInitial();
    const frame = window.requestAnimationFrame(focusInitial);
    return () => window.cancelAnimationFrame(frame);
  }, [pin.locked]);

  if (!pin.locked) return <>{children}</>;

  return (
    <main ref={rootRef} className="tv-pin-gate" data-tv-modal="tv-pin-gate" aria-label="输入解锁密码">
      <section className="tv-pin-card">
        <div className="tv-pin-brand">
          <Logo size={34} />
          <div>
            <h1>HGhubX <small>TV</small></h1>
          </div>
        </div>
        <TvPinPad
          scopeId="tv-pin-gate"
          focusPrefix="pin-gate"
          prompt="请输入 4 位 PIN 码进入软件"
          error={error}
          cooldownLeft={cooldownLeft}
          onClearError={() => setError("")}
          onBackEmpty={() => { void invoke("plugin:app|exit", { code: 0 }).catch(() => {}); }}
          onComplete={code => {
            if (unlockTvSession(code)) {
              resetFailures();
              setError("");
            } else {
              recordFailure();
              setError("PIN 码错误，请重新输入");
            }
          }}
        />
      </section>
    </main>
  );
}
