import { useEffect, useId, useRef, useState } from "react";
import { api, isMobile } from "../api";
import type { User } from "../types";
import { useStore } from "../store";
import { Modal, Sheet } from "./ui";
import { Button, Form, Input, SegmentedControl } from "./ios/controls";
import { Loader } from "./ios/effects";
import { IClose, IEye, IEyeOff, ILogin } from "../icons";

export default function LoginModal() {
  const { loginOpen, setLoginOpen, setUser, toast, accountScope, lineEpoch } = useStore();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  const context = useRef({ accountScope, lineEpoch });
  context.current = { accountScope, lineEpoch };
  const requestEpoch = useRef(0);
  const errorId = useId();
  const passwordId = useId();
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => { requestEpoch.current++; };
    window.addEventListener("hg:line-changed", invalidate);
    window.addEventListener("hg:proxy-changed", invalidate);
    return () => {
      mounted.current = false;
      window.removeEventListener("hg:line-changed", invalidate);
      window.removeEventListener("hg:proxy-changed", invalidate);
    };
  }, []);
  useEffect(() => {
    if (!loginOpen) { setPassword(""); setShowPassword(false); setErr(""); }
  }, [loginOpen]);
  const title = mode === "login" ? "登录 HGhubX" : "注册 HGhubX";
  const close = () => {
    if (pending.current) return;
    setLoginOpen(false);
  };
  const submit = async () => {
    // A ref locks synchronously: two submit events can arrive before React paints disabled.
    if (pending.current) return;
    if (!username.trim() || !password) { setErr("请输入账号与密码"); return; }
    pending.current = true;
    setBusy(true); setErr("");
    const started = context.current;
    const epoch = requestEpoch.current;
    try {
      const result = mode === "login" ? await api.login(username.trim(), password) : await api.register(username.trim(), password, email.trim());
      if (!mounted.current) return;
      if (epoch !== requestEpoch.current || started.accountScope !== context.current.accountScope || started.lineEpoch !== context.current.lineEpoch) {
        setErr("账号或线路已变化，请重新登录");
        return;
      }
      setUser(result.user as User, result.origin); setPassword(""); setLoginOpen(false);
      toast(mode === "login" ? `欢迎回来，${result.user?.nickname || username}` : "注册成功", "ok");
    } catch (error) { if (mounted.current) setErr(error instanceof Error ? error.message : "操作失败，请重试"); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const content = <div className="ios-auth">
    <div className="ios-dialog-heading"><span className="ios-heading-icon"><ILogin size={21} /></span><h2>{title}</h2>
      <Button className="ios-icon-button" aria-label="关闭登录" onClick={close} disabled={busy}><IClose size={19} /></Button>
    </div>
    <p className="ios-description">登录后同步账号收藏、关注和观看记录；游客的本机记录单独保留。</p>
    <SegmentedControl className="ios-auth-tabs" aria-label="账号操作" activeIndex={mode === "login" ? 0 : 1}>
      {([ ["login", "登录"], ["register", "注册"] ] as const).map(([key, label]) => <Button key={key}
        disabled={busy} aria-pressed={mode === key} onClick={() => { if (!pending.current) { setMode(key); setErr(""); setShowPassword(false); } }}>{label}</Button>)}
    </SegmentedControl>
    <Form className="ios-auth-form" aria-busy={busy} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label className="ios-field"><span>账号</span><Input aria-label="账号" data-autofocus autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} readOnly={busy} name="username" placeholder="输入账号" value={username}
        onChange={event => setUsername(event.target.value)} aria-invalid={!!err} aria-describedby={err ? errorId : undefined} /></label>
      <div className="ios-field"><span id={passwordId}>密码</span><div className="relative">
        <Input aria-label="密码" aria-labelledby={passwordId} autoComplete={mode === "login" ? "current-password" : "new-password"} name="password" type={showPassword ? "text" : "password"} readOnly={busy}
          style={{ paddingRight: 56 }} placeholder="输入密码" value={password} onChange={event => setPassword(event.target.value)} aria-invalid={!!err} aria-describedby={err ? errorId : undefined} />
        <Button className="ios-icon-button absolute right-1 top-1/2 -translate-y-1/2 text-mut" aria-label={showPassword ? "隐藏密码" : "显示密码"}
          aria-pressed={showPassword} disabled={busy} onClick={() => setShowPassword(value => !value)}>{showPassword ? <IEyeOff size={20} /> : <IEye size={20} />}</Button>
      </div></div>
      {mode === "register" && <label className="ios-field"><span>邮箱 <small>可选</small></span><Input aria-label="邮箱" type="email" autoComplete="email" readOnly={busy} name="email"
        placeholder="用于账号联系" value={email} onChange={event => setEmail(event.target.value)} /></label>}
      {err && <p id={errorId} role="alert" className="ios-field-error">{err}</p>}
      <Button variant="primary" className="ios-auth-submit" type="submit" disabled={busy}>
        {busy && <Loader className="size-5" />}{busy ? "处理中…" : mode === "login" ? "登录" : "创建账号"}
      </Button>
    </Form>
    <p className="ios-description ios-auth-note">登录状态与当前站点绑定；使用自定义镜像时，登录请求会发送到你填写的站点，跨站点切换需重新登录。</p>
  </div>;
  return isMobile ? <Sheet open={loginOpen} onClose={close} label={title}>{content}</Sheet>
    : <Modal open={loginOpen} onClose={close} label={title} width={440}>{content}</Modal>;
}
