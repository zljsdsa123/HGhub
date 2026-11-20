//! Network diagnostics and draft proxy probing.
//!
//! Extracted from `crate::net` so transport, client caching and edge request
//! handling stay separate from settings-only diagnostic reporting.

use crate::net::{
    base, build_client, edge_redirect_target, env_proxy_set, get, gnome_proxy, proxy_active,
    proxy_override, redact_proxy, system_proxy_enabled, ProxyRoute,
};
use crate::network_policy;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::time::{Duration, Instant};

#[cfg(test)]
fn dns_summary(addrs: impl IntoIterator<Item = SocketAddr>) -> Value {
    let mut ips: Vec<_> = addrs.into_iter().map(|addr| addr.ip()).collect();
    ips.sort_unstable();
    ips.dedup();
    let has_fake_ip = ips.iter().any(|ip| {
        let v4 = match ip {
            std::net::IpAddr::V4(v4) => Some(*v4),
            std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped(),
        };
        v4.is_some_and(|ip| {
            let [a, b, _, _] = ip.octets();
            a == 198 && (b == 18 || b == 19)
        })
    });
    json!({ "count": ips.len(), "has_fake_ip": has_fake_ip })
}

/// IPv4 地址分类。诊断要能回答「解析到的是正常公网，还是被投毒/被接管」。
fn ipv4_kind(o: [u8; 4]) -> &'static str {
    let v4 = std::net::Ipv4Addr::from(o);
    if v4.is_loopback() {
        "loopback"
    } else if o == [0, 0, 0, 0] {
        "unspecified"
    } else if o[0] == 198 && (o[1] == 18 || o[1] == 19) {
        // Clash / Surge 系 TUN 的 fake-ip 网段：TUN 一关这个地址就不可路由。
        "fake_ip"
    } else if v4.is_private() {
        "private"
    } else if v4.is_link_local() {
        "link_local"
    } else if v4.is_broadcast() {
        "broadcast"
    } else {
        "public"
    }
}

fn ip_kind(ip: std::net::IpAddr) -> &'static str {
    match ip {
        std::net::IpAddr::V4(v4) => ipv4_kind(v4.octets()),
        std::net::IpAddr::V6(v6) => {
            if v6.is_loopback() {
                "loopback"
            } else if v6.is_unspecified() {
                "unspecified"
            } else if let Some(v4) = v6.to_ipv4_mapped() {
                ipv4_kind(v4.octets())
            } else {
                "public"
            }
        }
    }
}

/// DNS 报告：数量 / 耗时 / 地址种类 / 是否 fake-ip。
///
/// **只把可疑地址原样列出**（回环、内网、保留段、fake-ip），公网答案只给数量——
/// 贴到公开 issue 里也不必泄露完整解析结果，但「被投毒到 127.0.0.1」这类
/// 一眼就能看见。
fn dns_report(addrs: &[SocketAddr], ms: u128) -> Value {
    let mut ips: Vec<std::net::IpAddr> = addrs.iter().map(|a| a.ip()).collect();
    ips.sort_unstable();
    ips.dedup();
    let mut kinds: Vec<&str> = ips.iter().map(|ip| ip_kind(*ip)).collect();
    kinds.sort_unstable();
    kinds.dedup();
    let suspicious: Vec<String> = ips
        .iter()
        .filter(|ip| ip_kind(**ip) != "public")
        .map(|ip| ip.to_string())
        .collect();
    json!({
        "ms": ms as u64,
        "count": ips.len(),
        "has_fake_ip": kinds.contains(&"fake_ip"),
        "kinds": kinds,
        "suspicious": suspicious,
    })
}

/// 独立 TCP socket 探测不使用应用层 HTTP 代理；内核 VPN/TUN 仍可能接管它。
async fn tcp_probe(addr: Option<SocketAddr>, timeout: Duration) -> Value {
    let Some(addr) = addr else {
        return json!({
            "mode": "direct_socket",
            "proxy_bypassed": true,
            "skipped": true,
            "reason": "没有可用的解析结果",
        });
    };
    let started = Instant::now();
    let family = if addr.is_ipv4() { "IPv4" } else { "IPv6" };
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await {
        Ok(Ok(_)) => json!({
            "mode": "direct_socket",
            "proxy_bypassed": true,
            "family": family,
            "addr": addr.to_string(),
            "ok": true,
            "ms": started.elapsed().as_millis() as u64,
        }),
        Ok(Err(e)) => json!({
            "mode": "direct_socket",
            "proxy_bypassed": true,
            "family": family,
            "addr": addr.to_string(),
            "ok": false,
            "ms": started.elapsed().as_millis() as u64,
            "error": e.to_string(),
        }),
        Err(_) => json!({
            "mode": "direct_socket",
            "proxy_bypassed": true,
            "family": family,
            "addr": addr.to_string(),
            "ok": false,
            "timeout": true,
            "ms": timeout.as_millis() as u64,
            "error": "连接超时（SYN 无响应）",
        }),
    }
}

/// HTTP 探测反映 App 实际请求路径；TCP 探测是独立 socket，不能据此覆盖 HTTP 结果。
fn verdict(dns: &Value, tcp: &Value, http: &Value) -> (&'static str, String, Vec<String>) {
    let dns_err = dns.get("error").and_then(|v| v.as_str());
    let fake = dns.get("has_fake_ip").and_then(|v| v.as_bool()).unwrap_or(false);
    let kinds = dns.get("kinds").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let suspicious = dns.get("suspicious").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let status = http.get("status").and_then(|v| v.as_u64());
    let http_err = http.get("error").and_then(|v| v.as_str()).unwrap_or("");
    let tcp_ok = tcp.get("ok").and_then(|v| v.as_bool());
    let proxy_configured = http
        .get("proxy_configured")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    // 实际 HTTP 响应优先；TCP 探测可能走不同路径（例如应用请求经 GNOME 代理）。
    if let Some(code @ 200..=399) = status {
        if dns_err.is_some() {
            return (
                "dns_false_alarm",
                format!("DNS 探测异常，但应用 HTTP 请求已成功（HTTP {code}）"),
                vec![],
            );
        }
        if fake {
            return (
                "ok_proxy",
                format!("DNS 由代理/TUN 接管，应用 HTTP 请求正常（HTTP {code}）"),
                vec![],
            );
        }
        if proxy_configured || tcp_ok == Some(false) {
            let direct_note = if tcp_ok == Some(false) {
                "；独立直连 TCP 探测失败，不影响这次成功的请求"
            } else {
                ""
            };
            return (
                "ok_proxy",
                format!("应用 HTTP 请求已成功（HTTP {code}{direct_note}）"),
                vec![],
            );
        }
        if kinds.iter().any(|kind| {
            matches!(kind.as_str(), Some("loopback" | "unspecified" | "private"))
        }) {
            return (
                "dns_hijack",
                format!("DNS 返回了非公网地址，但应用 HTTP 请求已成功（HTTP {code}）"),
                vec!["检查本机 DNS、VPN/TUN 和代理设置是否符合预期".into()],
            );
        }
        return (
            "ok",
            format!("连通正常（HTTP {code}），线路可用"),
            vec![],
        );
    }

    // 收到 HTTP 错误状态也表示请求路径已到达 HTTP 服务，不能归因于直连 TCP 探测。
    if let Some(code) = status {
        return (
            "http_status",
            format!("应用 HTTP 请求收到服务端状态码 {code}"),
            vec!["确认账号或内容权限；若持续出现，请稍后重试".into()],
        );
    }

    // DNS 失败且没有可用的 HTTP 响应时再判 DNS 故障。
    if let Some(e) = dns_err.filter(|_| http_err.is_empty()) {
        if proxy_configured {
            return (
                "proxy_fail",
                format!("代理请求失败，且本机 DNS 探测也失败：{e}。无法仅凭这两项确定上游故障位置"),
                vec![
                    "确认本机代理服务正在运行，并检查当前代理节点".into(),
                    "连接代理后重试，或换网络对照".into(),
                ],
            );
        }
        return (
            "dns_fail",
            format!("域名解析失败：{e}"),
            vec![
                "关掉代理 / 加速器 / VPN 的 TUN 模式后重试（最常见的元凶）".into(),
                "换网络对比：Wi-Fi 与流量互切".into(),
                "安卓「私有 DNS」改为自动，或填 223.5.5.5 / 1.1.1.1".into(),
            ],
        );
    }
    if fake && http_err.is_empty() {
        return (
            "fake_ip",
            format!(
                "解析到 fake-ip（{}），DNS 流量被代理/TUN 接管；代理一断开这个地址不可路由",
                suspicious
                    .first()
                    .and_then(|v| v.as_str())
                    .unwrap_or("198.18.x.x")
            ),
            vec![
                "关掉 Clash / Surge 等代理的 TUN（增强）模式，或直接退出代理".into(),
                "若必须用代理，请保证代理常驻且节点稳定后再开 App".into(),
            ],
        );
    }
    if http_err.is_empty()
        && kinds
            .iter()
            .any(|k| matches!(k.as_str(), Some("loopback" | "unspecified" | "private")))
    {
        return (
            "dns_hijack",
            "解析结果落在回环 / 内网 / 保留地址，DNS 被劫持或线路被污染".into(),
            vec![
                "换一个 DNS（223.5.5.5、1.1.1.1）后重启 App".into(),
                "关闭省电模式或系统的「网络加速」类功能".into(),
            ],
        );
    }
    if !http_err.is_empty() {
        let lower = http_err.to_lowercase();
        if proxy_configured {
            let direct_note = if tcp_ok == Some(false) {
                "; 独立直连 TCP 探测也失败，但它绕过了应用 HTTP 代理"
            } else {
                ""
            };
            return (
                "proxy_fail",
                format!("应用 HTTP 请求经已配置代理失败：{http_err}{direct_note}"),
                vec![
                    "确认本机代理服务正在运行，并检查当前代理节点".into(),
                    "关闭代理的 HTTPS 解密功能后重试，或切换代理节点".into(),
                ],
            );
        }
        let certificate = lower.contains("certificate");
        let handshake = lower.contains("tls")
            || lower.contains("ssl")
            || lower.contains("handshake");
        return (
            if certificate {
                "tls_intercept"
            } else if handshake {
                "tls_fail"
            } else {
                "http_fail"
            },
            if certificate {
                format!("TLS 证书校验失败：{http_err}")
            } else if handshake {
                format!("HTTP TLS 握手失败：{http_err}；可能发生在代理、目标站点或中间网络，不能仅凭握手错误判定中间人拦截")
            } else if tcp_ok == Some(false) {
                format!("应用 HTTP 请求失败：{http_err}；独立直连 TCP 探测也失败，需要对照网络和代理路径继续定位")
            } else {
                format!("HTTP 请求失败：{http_err}")
            },
            if certificate {
                vec![
                    "检查代理的 HTTPS 解密设置和系统时间".into(),
                    "换一个网络或代理节点对照".into(),
                ]
            } else if handshake {
                vec![
                    "确认系统代理或 VPN/TUN 正常，并尝试更换代理节点".into(),
                    "换网络重试，区分目标站、代理和中间网络故障".into(),
                ]
            } else if tcp_ok == Some(false) {
                vec![
                    "检查路由器、VPN/TUN 和防火墙，再换网络对照".into(),
                    "不要仅凭直连 TCP 超时判断运营商阻断".into(),
                ]
            } else {
                vec!["稍后重试，或检查当前网络和代理设置".into()]
            },
        );
    }
    if tcp_ok == Some(false) {
        let timeout = tcp.get("timeout").and_then(|v| v.as_bool()).unwrap_or(false);
        return (
            if timeout { "tcp_timeout" } else { "tcp_refused" },
            if timeout {
                "DNS 正常，但独立直连 TCP socket 探测超时；这不能单独证明运营商或防火墙阻断".to_string()
            } else {
                format!(
                    "DNS 正常，但独立直连 TCP socket 探测失败：{}",
                    tcp.get("error").and_then(|v| v.as_str()).unwrap_or("未知原因")
                )
            },
            vec![
                "检查默认路由、VPN/TUN 和防火墙设置".into(),
                "换网络对照；TCP 探测不经过应用层 HTTP 代理".into(),
            ],
        );
    }
    ("unknown", "信息不足：HTTP 请求和 TCP 探测均未给出可归类结果".into(), vec![])
}

/// Editable URL is returned only to the settings form; effective is always redacted.
pub fn proxy_state() -> Value {
    let config = crate::proxy::snapshot();
    let target = url::Url::parse(&base()).expect("validated base");
    let route = ProxyRoute::for_config(&config, &target);
    let effective = if !route.active {
        None
    } else if let Some(explicit) = &route.explicit {
        Some(redact_proxy(explicit))
    } else {
        ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]
            .iter()
            .find_map(|key| std::env::var(key).ok().filter(|value| !value.trim().is_empty()))
            .map(|value| redact_proxy(&value))
            .or_else(|| Some("system".to_owned()))
    };
    json!({
        "mode": config.mode.as_str(), "url": config.url, "effective": effective,
        "system_proxy": system_proxy_enabled(), "env_proxy": env_proxy_set(),
    })
}

fn healthy_proxy_response(status: u16, body: &[u8]) -> bool {
    if status != 200 {
        return false;
    }
    serde_json::from_slice::<Value>(body).is_ok_and(|value| {
        value.get("status").and_then(Value::as_i64) == Some(1)
            && value.get("data").is_some_and(crate::lines::healthy_video_data)
    })
}

/// Probe the same anonymous edge envelope as line health, using an unsaved route.
/// A draft never mutates app settings or cached clients. Bound the whole request,
/// including DNS, redirects and body, and do not echo untrusted response text.
pub async fn test_proxy(mode: &str, url: &str) -> Value {
    let config = match crate::proxy::Config::for_test(mode, url) {
        Ok(config) => config,
        Err(error) => return json!({"ok": false, "ms": 0, "error": error}),
    };
    let origin = base();
    let started = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(8),
        probe_proxy_origin(&origin, &config, network_policy::strict_security()),
    )
    .await;
    let mut value = match result {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => json!({"ok": false, "error": error}),
        Err(_) => json!({"ok": false, "error": "代理连通性测试超时（8 秒）"}),
    };
    value["ms"] = json!(started.elapsed().as_millis() as u64);
    value
}

async fn probe_proxy_origin(
    origin: &str,
    config: &crate::proxy::Config,
    strict: bool,
) -> Result<Value, String> {
    let mut next = network_policy::parse_target_with_mode(&format!("{origin}/api/edge/request"), strict)?;
    let envelope = json!({ "method": "GET", "path": "/api/videos?page=1&size=1", "body": "", "content_type": "" });
    for hop in 0..=5 {
        let route = ProxyRoute::for_config(config, &next);
        let addresses = if strict && !route.active {
            network_policy::resolve_target(&next, strict).await?
        } else {
            Vec::new()
        };
        let client = build_client(next.host_str().ok_or("目标缺少主机名")?, &addresses, &route)?;
        let response = client
            .post(next.clone())
            .header("Accept", "application/json")
            .header("Referer", format!("{origin}/"))
            .json(&envelope)
            .send()
            .await
            .map_err(proxy_probe_error)?;
        let status = response.status().as_u16();
        if response.status().is_redirection() {
            if hop == 5 {
                return Err("重定向次数超过限制".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("重定向缺少有效 Location")?;
            next = edge_redirect_target(&next, status, location, true)?;
            continue;
        }
        if status != 200 {
            return Ok(json!({"ok": false, "status": status, "via": route.label(), "error": "视频接口返回错误状态码"}));
        }
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(proxy_probe_error)? {
            if body.len() + chunk.len() > 1024 * 1024 {
                return Err("视频接口响应超过测试大小限制".into());
            }
            body.extend_from_slice(&chunk);
        }
        let ok = healthy_proxy_response(status, &body);
        return Ok(if ok {
            json!({"ok": true, "status": status, "via": route.label()})
        } else {
            json!({"ok": false, "status": status, "via": route.label(), "error": "接口未返回有效视频列表数据"})
        });
    }
    Err("重定向次数超过限制".into())
}

fn proxy_probe_error(error: reqwest::Error) -> String {
    // reqwest's nested transport errors can contain the configured proxy URL.
    // Report the useful category without copying a credential-bearing address.
    if error.is_timeout() {
        "代理连通性测试超时"
    } else if error.is_connect() {
        "代理或目标连接失败，请检查地址、认证信息和网络"
    } else if error.is_body() || error.is_decode() {
        "视频接口响应读取失败"
    } else {
        "代理连通性测试请求失败"
    }
    .into()
}

/// 网络自检：DNS / TCP / HTTP / 代理环境变量，用于远程定位「打不开」。
///
/// 结论直接给在 `verdict` / `summary` / `advice` 里，用户复制出去就能看懂。
pub async fn diagnose() -> Value {
    let cur = base();
    let host = url::Url::parse(&cur)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    // DNS：必须和真实请求走同一条解析路径（tokio lookup_host），
    // 否则会出现「诊断报解析失败、实际却打得开」的假阴性。
    let dns_started = Instant::now();
    let mut first_addr: Option<SocketAddr> = None;
    let dns = if host.is_empty() {
        json!({ "error": "当前线路没有主机名" })
    } else {
        match tokio::time::timeout(
            Duration::from_secs(6),
            tokio::net::lookup_host((host.as_str(), 443u16)),
        )
        .await
        {
            Ok(Ok(iter)) => {
                let addrs: Vec<SocketAddr> = iter.collect();
                let ms = dns_started.elapsed().as_millis();
                first_addr = addrs.first().copied();
                dns_report(&addrs, ms)
            }
            Ok(Err(e)) => json!({
                "error": "DNS 解析失败",
                "detail": e.to_string(),
                "ms": dns_started.elapsed().as_millis() as u64,
            }),
            Err(_) => json!({
                "error": "DNS 解析超时",
                "timeout": true,
                "ms": 6000,
            }),
        }
    };

    // TCP 探测绕过应用 HTTP 代理；它的结果只表示 socket 直连路径，不代表 HTTP 路径。
    let tcp = tcp_probe(first_addr, Duration::from_secs(5)).await;

    let started = Instant::now();
    let proxy_configured = url::Url::parse(&cur)
        .ok()
        .is_some_and(|target| proxy_active(&target));
    let http = match get(&format!("{cur}/"), Duration::from_secs(20), None, None).await {
        Ok(r) => json!({
            "status": r.status().as_u16(),
            "proxy_configured": proxy_configured,
            "ms": started.elapsed().as_millis() as u64,
        }),
        Err(e) => json!({
            "kind": crate::playback_log::error_kind(&e),
            "error": e,
            "proxy_configured": proxy_configured,
            "ms": started.elapsed().as_millis() as u64,
        }),
    };

    let (code, summary, advice) = verdict(&dns, &tcp, &http);

    json!({
        "verdict": code,
        "summary": summary,
        "advice": advice,
        "base": cur,
        "host": host,
        "dns": dns,
        "tcp": tcp,
        "http": http,
        "env": {
            "HTTP_PROXY": std::env::var("HTTP_PROXY").ok().map(|p| redact_proxy(&p)),
            "HTTPS_PROXY": std::env::var("HTTPS_PROXY").ok().map(|p| redact_proxy(&p)),
            "ALL_PROXY": std::env::var("ALL_PROXY").ok().map(|p| redact_proxy(&p)),
            "NO_PROXY": std::env::var("NO_PROXY").ok().map(|_| "[已配置，列表已隐藏]"),
            "HGHUBX_PROXY": proxy_override().map(|p| redact_proxy(&p)),
            "GNOME_PROXY": gnome_proxy().map(|p| redact_proxy(&p)),
            "system_proxy": system_proxy_enabled(),
            "app_proxy_mode": crate::proxy::mode().as_str(),
            "app_proxy": crate::proxy::custom_url().as_deref().map(redact_proxy),
        },
        "runtime": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "ver": env!("CARGO_PKG_VERSION"),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_probe_checks_feed_envelope_instead_of_http_status_only() {
        let valid = json!({"status": 1, "data": {"items": [{"id": 1, "title": "fixture"}], "pagination": {"page": 1, "size": 1, "pages": 1, "total": 1}}});
        assert!(healthy_proxy_response(200, valid.to_string().as_bytes()));
        assert!(!healthy_proxy_response(403, valid.to_string().as_bytes()));
        for body in [
            b"<html>homepage</html>".as_slice(),
            br#"{"status":0,"data":{}}"#,
            br#"{"status":1,"data":[]}"#,
            br#"{"status":1,"data":{"items":[],"pagination":{}}}"#,
        ] {
            assert!(!healthy_proxy_response(200, body));
        }
    }

    #[tokio::test]
    async fn proxy_probe_uses_post_envelope_and_does_not_save_draft() {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let serving = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            let mut length = 0;
            let mut auth = false;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
                if line.to_ascii_lowercase().starts_with("authorization:") {
                    auth = true;
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let data = json!({"status":1,"data":{"items":[],"pagination":{"page":1,"size":1,"pages":0,"total":0}}}).to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}", data.len()).unwrap();
            (request, serde_json::from_slice::<Value>(&body).unwrap(), auth)
        });
        let before = crate::proxy::snapshot();
        let config = crate::proxy::Config::for_test("custom", &format!("http://{address}")).unwrap();
        // Host has no DNS record; only the explicitly supplied HTTP proxy can answer.
        let result = probe_proxy_origin("http://unresolved.fixture.invalid", &config, false)
            .await
            .unwrap();
        assert_eq!(result["ok"], true);
        let (request, body, auth) = serving.join().unwrap();
        assert!(request.starts_with("POST http://unresolved.fixture.invalid/api/edge/request HTTP/1.1"));
        assert_eq!(
            body,
            json!({"method":"GET","path":"/api/videos?page=1&size=1","body":"","content_type":""})
        );
        assert!(!auth);
        assert!(crate::proxy::snapshot() == before);
    }

    #[test]
    fn dns_diagnostics_only_expose_counts_and_fake_ip_presence() {
        let addrs: Vec<SocketAddr> = ["10.0.0.1:443", "198.18.0.2:443", "[::ffff:198.18.0.3]:443"]
            .into_iter()
            .map(|raw| raw.parse().unwrap())
            .collect();
        let summary = dns_summary(addrs);
        assert_eq!(summary, json!({"count": 3, "has_fake_ip": true}));
        assert!(!summary.to_string().contains("10.0.0.1"));
        assert!(!summary.to_string().contains("198.18"));
        assert_eq!(
            dns_summary(Vec::<SocketAddr>::new()),
            json!({"count":0,"has_fake_ip":false})
        );
    }

    #[test]
    fn diagnostic_http_success_overrides_a_failed_direct_tcp_probe() {
        let dns = json!({
            "count": 2,
            "has_fake_ip": false,
            "kinds": ["public"],
        });
        let tcp = json!({
            "mode": "direct_socket",
            "proxy_bypassed": true,
            "family": "IPv6",
            "ok": false,
            "timeout": true,
            "error": "连接超时（SYN 无响应）",
        });
        let http = json!({ "status": 200, "proxy_configured": true });

        let (code, summary, advice) = verdict(&dns, &tcp, &http);
        assert_eq!(code, "ok_proxy");
        assert!(summary.contains("HTTP 200"));
        assert!(summary.contains("独立直连 TCP 探测失败"));
        assert!(advice.is_empty());
    }

    #[test]
    fn diagnostic_proxy_handshake_failure_does_not_blame_the_direct_route() {
        let dns = json!({
            "count": 2,
            "has_fake_ip": false,
            "kinds": ["public"],
        });
        let tcp = json!({
            "mode": "direct_socket",
            "proxy_bypassed": true,
            "family": "IPv6",
            "ok": false,
            "timeout": true,
            "error": "连接超时（SYN 无响应）",
        });
        let http = json!({
            "proxy_configured": true,
            "kind": "transport_error",
            "error": "error sending request ← tls handshake eof",
        });

        let (code, summary, advice) = verdict(&dns, &tcp, &http);
        assert_eq!(code, "proxy_fail");
        assert!(summary.contains("应用 HTTP 请求经已配置代理失败"));
        assert!(summary.contains("绕过了应用 HTTP 代理"));
        assert!(!summary.contains("运营商"));
        assert!(advice.iter().any(|item| item.contains("代理节点")));
    }

    #[test]
    fn direct_tcp_failure_alone_is_not_reported_as_operator_blocking() {
        let dns = json!({
            "count": 1,
            "has_fake_ip": false,
            "kinds": ["public"],
        });
        let tcp = json!({ "ok": false, "timeout": true });
        let http = json!({
            "proxy_configured": false,
            "kind": "transport_error",
            "error": "connection timeout",
        });

        let (code, summary, _) = verdict(&dns, &tcp, &http);
        assert_eq!(code, "http_fail");
        assert!(summary.contains("独立直连 TCP 探测也失败"));
        assert!(!summary.contains("运营商"));
    }

    #[test]
    fn diagnostic_http_error_status_is_not_overridden_by_direct_tcp_failure() {
        let dns = json!({ "count": 1, "has_fake_ip": false, "kinds": ["public"] });
        let tcp = json!({ "ok": false, "timeout": true });
        let http = json!({ "status": 503, "proxy_configured": true });

        let (code, summary, _) = verdict(&dns, &tcp, &http);
        assert_eq!(code, "http_status");
        assert!(summary.contains("503"));
    }

    /// 手动跑：`cargo test --lib -- --ignored net_diag::tests::diag -- --nocapture`
    /// 关掉 TUN、只留系统代理时跑一遍，能直接看出客户端有没有走代理。
    #[tokio::test]
    #[ignore = "联网测试：请求上游做网络自检，手动用 --ignored 运行"]
    async fn diag() {
        println!(
            "{}",
            serde_json::to_string_pretty(&diagnose().await).expect("json")
        );
    }
}
