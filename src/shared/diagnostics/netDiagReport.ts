/**
 * 网络诊断报告：把 `net_diag` 的 JSON 变成人一眼能读的分段文本。
 *
 * 设计目标——用户点一下「网络诊断」复制出来的东西，直接贴到 issue 里，
 * 维护者不用问「你说的是哪个错」：
 *
 *   1. 第一行是结论（verdict + summary），不用读数据就能定性
 *   2. 分段给耗时/状态，扫一眼就知道卡在 DNS、TCP 还是 TLS
 *   3. 建议直接可执行
 *   4. 原始 JSON 附在末尾，机器也能解析
 */

type Json = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const ms = (v: unknown): string => {
  const n = num(v);
  return n == null ? "?" : `${n}ms`;
};

const pad = (label: string, width = 10) => label + " ".repeat(Math.max(0, width - label.length));

/** 结论 → 一句话人话（verdict 是稳定的英文码，方便 grep 统计） */
const VERDICT_TEXT: Record<string, string> = {
  ok: "连通正常",
  ok_proxy: "代理/TUN 接管中，连接正常",
  fake_ip: "被代理 / TUN 接管（fake-ip）",
  dns_fail: "DNS 解析失败",
  dns_false_alarm: "DNS 探测异常，但实际可通",
  dns_hijack: "DNS 被劫持到内网 / 保留地址",
  tcp_timeout: "直连 TCP 探测超时",
  tcp_refused: "直连 TCP 探测被拒",
  tls_intercept: "TLS 证书校验失败",
  tls_fail: "TLS 握手失败",
  proxy_fail: "代理请求失败",
  http_fail: "HTTP 请求失败",
  http_status: "服务端返回错误状态码",
  unknown: "信息不足",
};

export function formatNetDiag(raw: Json): string {
  const dns = obj(raw.dns);
  const tcp = obj(raw.tcp);
  const http = obj(raw.http);
  const env = obj(raw.env);
  const rt = obj(raw.runtime);

  const verdict = str(raw.verdict) || "unknown";
  const summary = str(raw.summary);
  const lines: string[] = [];

  /* ── 头部：时间 + 结论 ── */
  const when = new Date().toLocaleString("zh-CN", { hour12: false });
  lines.push(`【HGhubX 网络诊断】${when}`);
  lines.push("");
  lines.push(`结论：${summary || VERDICT_TEXT[verdict] || verdict}`);
  lines.push(`代码：${verdict}（${VERDICT_TEXT[verdict] ?? "未归类"}）`);
  lines.push("");

  /* ── 环境 ── */
  lines.push("── 运行环境 ──────────────────────");
  const os = [str(rt.os), str(rt.arch)].filter(Boolean).join(" ");
  if (os) lines.push(`${pad("平台")}${os}`);
  if (str(rt.ver)) lines.push(`${pad("版本")}${str(rt.ver)}`);
  lines.push(`${pad("线路")}${str(raw.base) || "-"}`);
  lines.push(`${pad("主机")}${str(raw.host) || "-"}`);
  lines.push("");

  /* ── DNS ── */
  lines.push("── DNS ───────────────────────────");
  if (str(dns.error)) {
    const detail = str(dns.detail);
    lines.push(`${pad("状态")}失败 · ${str(dns.error)}${dns.timeout ? "（超时 6s）" : ` · ${ms(dns.ms)}`}`);
    if (detail) lines.push(`${pad("原因")}${detail}`);
  } else {
    const kinds = arr(dns.kinds).map(String);
    const count = num(dns.count);
    lines.push(`${pad("状态")}${ms(dns.ms)} · ${count ?? 0} 条记录`);
    lines.push(`${pad("类型")}${kinds.length ? kinds.join(", ") : "-"}`);
    const suspicious = arr(dns.suspicious).map(String);
    if (suspicious.length) lines.push(`${pad("可疑地址")}${suspicious.join(", ")}`);
    if (dns.has_fake_ip) lines.push(`${pad("判定")}fake-ip：DNS 被 Clash / Surge 等 TUN 接管`);
  }
  lines.push("");

  /* ── TCP ── */
  lines.push("── TCP ───────────────────────────");
  if (tcp.skipped) {
    lines.push(`${pad("状态")}跳过 · ${str(tcp.reason) || "无解析结果"}`);
  } else {
    const ok = tcp.ok === true;
    const state = ok ? "可连接" : tcp.timeout ? "超时（无响应）" : "失败";
    const path = tcp.proxy_bypassed === true ? "直连探测（绕过应用 HTTP 代理）" : "独立 TCP socket 探测";
    const family = str(tcp.family) ? `${str(tcp.family)} · ` : "";
    lines.push(`${pad("状态")}${path} · ${family}${state} · ${ms(tcp.ms)}`);
    if (str(tcp.addr)) lines.push(`${pad("目标")}${str(tcp.addr)}`);
    if (str(tcp.error)) lines.push(`${pad("错误")}${str(tcp.error)}`);
  }
  lines.push("");

  /* ── HTTP ── */
  lines.push("── HTTP ──────────────────────────");
  const status = num(http.status);
  if (status != null) lines.push(`${pad("状态")}${status} · ${ms(http.ms)}`);
  else lines.push(`${pad("状态")}失败 · ${ms(http.ms)}`);
  lines.push(`${pad("代理路径")}${http.proxy_configured === true ? "检测到匹配的应用 HTTP 代理配置" : http.proxy_configured === false ? "未检测到应用 HTTP 代理配置（VPN/TUN 仍可能接管）" : "未记录"}`);
  if (str(http.kind)) lines.push(`${pad("错误类型")}${str(http.kind)}`);
  if (str(http.error)) lines.push(`${pad("错误")}${str(http.error)}`);
  lines.push("");

  /* ── 应用代理 ── */
  if (str(env.app_proxy_mode)) {
    const labels: Record<string, string> = { system: "跟随系统", custom: "自定义代理", off: "直连" };
    lines.push("── 应用代理 ──────────────────────");
    lines.push(`${pad("模式")}${labels[str(env.app_proxy_mode)] || str(env.app_proxy_mode)}`);
    if (str(env.app_proxy)) lines.push(`${pad("出口")}${str(env.app_proxy)}`);
    lines.push("");
  }

  /* ── 代理环境变量 ── */
  const envLines = Object.entries(env)
    .map(([k, v]) => `${k}=${v == null ? "-" : String(v)}`)
    .sort();
  lines.push("── 系统代理 ──────────────────────");
  lines.push(envLines.length ? envLines.join("  |  ") : "无相关环境变量");
  lines.push("");

  /* ── 建议 ── */
  const advice = arr(raw.advice).map(String).filter(Boolean);
  if (advice.length) {
    lines.push("── 建议 ──────────────────────────");
    advice.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
    lines.push("");
  }

  /* ── 原始数据 ── */
  lines.push("── 原始数据（JSON）───────────────");
  lines.push(JSON.stringify(raw, null, 2));

  return lines.join("\n");
}

/** 一句话摘要，给 toast / 日志用，不占屏。 */
export function shortVerdict(raw: Json): string {
  const verdict = str(raw.verdict) || "unknown";
  return `${verdict} · ${str(raw.summary) || VERDICT_TEXT[verdict] || "未知"}`;
}
