//! 不可信目标的连接策略。FakeIP 是明确例外，不能把它当作普通私网拒绝。
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;
use std::time::Duration;
use url::{Host, Url};

/// 解析命令行参数与环境变量中的严格安全模式覆盖项。
/// 支持 `--no-strict` / `--no-strict-security` / `--relaxed` / `--relaxed-security` 关闭，
/// `--strict` / `--strict-security` 开启，以及 `HGHUBX_STRICT=0|1|false|true`。
pub fn parse_strict_override<I, S>(args: I, env_val: Option<&str>) -> Option<bool>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = match env_val.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("0" | "false" | "off" | "no") => Some(false),
        Some("1" | "true" | "on" | "yes") => Some(true),
        _ => None,
    };
    for arg in args {
        match arg.as_ref().trim() {
            "--no-strict" | "--no-strict-security" | "--relaxed" | "--relaxed-security" => {
                out = Some(false);
            }
            "--strict" | "--strict-security" => {
                out = Some(true);
            }
            _ => {}
        }
    }
    out
}

pub fn cli_strict_override() -> Option<bool> {
    parse_strict_override(
        std::env::args(),
        crate::env::var("STRICT").as_deref(),
    )
}

static STRICT: Lazy<AtomicBool> =
    Lazy::new(|| AtomicBool::new(cli_strict_override().unwrap_or(true)));
static SECURITY_FILE: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

/// 当前是否启用严格安全模式（默认开启）。
pub fn strict_security() -> bool {
    STRICT.load(Ordering::Relaxed)
}

/// 启动时读取落盘的安全模式设置；若命令行显式指定了 `--no-strict` 等参数，则以命令行参数为准。
pub fn bind_security(dir: &Path) {
    let path = dir.join("security.json");
    if cli_strict_override().is_none() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(strict) = v.get("strict").and_then(|x| x.as_bool()) {
                    STRICT.store(strict, Ordering::Relaxed);
                }
            }
        }
    }
    if let Ok(mut f) = SECURITY_FILE.write() {
        *f = Some(path);
    }
}

/// 切换严格安全模式并落盘。
pub fn set_strict_security(strict: bool) -> Result<(), String> {
    let file = SECURITY_FILE.write().map_err(|_| "安全设置锁失败")?;
    let path = file.as_ref().ok_or("安全设置尚未初始化")?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json!({ "strict": strict }).to_string())
        .and_then(|_| std::fs::rename(&temp, path))
        .map_err(|_| "无法保存安全设置，请检查应用数据目录")?;
    STRICT.store(strict, Ordering::Relaxed);
    Ok(())
}

fn is_internal_webview_host(name: &str) -> bool {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    matches!(
        name.as_str(),
        "tauri.localhost" | "hg.localhost" | "ipc.localhost"
    )
}

pub fn allowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            if a == 198 && (b == 18 || b == 19) {
                return true;
            }
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && (c == 0 || c == 2))
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return allowed_ip(IpAddr::V4(v4));
            }
            let s = ip.segments();
            // 仅全球单播；拒绝 ULA、链路本地、回环、组播、NAT64，以及可封装私网 IPv4 的 6to4/Teredo。
            (s[0] & 0xe000) == 0x2000
                && s[0] != 0x2002
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

pub fn parse_target(raw: &str) -> Result<Url, String> {
    parse_target_with_mode(raw, strict_security())
}

pub fn parse_target_with_mode(raw: &str, strict: bool) -> Result<Url, String> {
    if raw.chars().any(char::is_control) {
        return Err("目标地址含控制字符".into());
    }
    let url = Url::parse(raw).map_err(|_| "目标地址无效")?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("目标只允许不带认证信息的 HTTP(S) 地址".into());
    }
    match url.host().ok_or("目标缺少主机名")? {
        Host::Ipv4(ip) if strict => check_ip(ip.into())?,
        Host::Ipv6(ip) if strict => check_ip(ip.into())?,
        Host::Ipv4(_) | Host::Ipv6(_) => {}
        Host::Domain(name) => {
            if is_internal_webview_host(name) {
                return Err("禁止访问应用内部协议主机名".into());
            }
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            if strict
                && ["localhost", "local", "internal", "home.arpa"]
                    .iter()
                    .any(|suffix| name == *suffix || name.ends_with(&format!(".{suffix}")))
            {
                return Err("禁止访问本机或内网主机名".into());
            }
        }
    }
    Ok(url)
}

fn check_ip(ip: IpAddr) -> Result<(), String> {
    if allowed_ip(ip) {
        Ok(())
    } else {
        Err("禁止访问普通内网、回环或保留地址（仅放行 FakeIP 198.18.0.0/15）".into())
    }
}

#[cfg(test)]
pub fn check_addresses(addrs: &[SocketAddr]) -> Result<(), String> {
    check_addresses_with_mode(addrs, strict_security())
}

pub fn check_addresses_with_mode(addrs: &[SocketAddr], strict: bool) -> Result<(), String> {
    if addrs.is_empty() {
        return Err("目标没有可用的 DNS 地址".into());
    }
    if strict {
        // 混合公私网答案整体拒绝，不能让连接器回退到私网地址。
        for addr in addrs {
            check_ip(addr.ip())?;
        }
    }
    Ok(())
}

/// 与浏览器一致优先 IPv6：连接器以首个地址的协议族为首选，另一族在其失败后（Happy Eyeballs）兜底。
/// 普通排序会把 IPv4 排在前面；共享 IPv4 出口被上游接口限流时，请求会挂起或返回 502/503，
/// 而同一网络下浏览器走 IPv6 一切正常。
fn sort_ipv6_first(addrs: &mut [SocketAddr]) {
    addrs.sort_unstable_by_key(|addr| (addr.is_ipv4(), *addr));
}

pub async fn resolve_target(url: &Url, strict: bool) -> Result<Vec<SocketAddr>, String> {
    let port = url.port_or_known_default().ok_or("目标端口无效")?;
    let mut addrs = match url.host().ok_or("目标缺少主机名")? {
        Host::Ipv4(ip) => vec![SocketAddr::new(ip.into(), port)],
        Host::Ipv6(ip) => vec![SocketAddr::new(ip.into(), port)],
        Host::Domain(host) => tokio::time::timeout(
            Duration::from_secs(10),
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| "DNS 解析超时")?
        .map_err(|_| "DNS 解析失败")?
        .collect(),
    };
    sort_ipv6_first(&mut addrs);
    addrs.dedup();
    check_addresses_with_mode(&addrs, strict)?;
    Ok(addrs)
}

pub fn redirect_target(current: &Url, location: &str) -> Result<Url, String> {
    redirect_target_with_mode(current, location, strict_security())
}

pub fn redirect_target_with_mode(
    current: &Url,
    location: &str,
    strict: bool,
) -> Result<Url, String> {
    let next = current.join(location).map_err(|_| "重定向地址无效")?;
    let next = parse_target_with_mode(next.as_str(), strict)?;
    if strict && current.scheme() == "https" && next.scheme() != "https" {
        return Err("禁止 HTTPS 降级重定向".into());
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_security_save_keeps_the_effective_mode() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("hghubx-security-{}-{unique}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("security.json");
        let previous = SECURITY_FILE.write().unwrap().replace(path.clone());
        let before = strict_security();
        set_strict_security(before).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(saved["strict"], before);
        *SECURITY_FILE.write().unwrap() = Some(dir.join("missing/security.json"));
        assert!(set_strict_security(!before).is_err());
        assert_eq!(strict_security(), before);
        *SECURITY_FILE.write().unwrap() = previous;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resolved_addresses_prefer_ipv6() {
        let mut addrs: Vec<SocketAddr> = [
            "18.65.214.45:443",
            "[2600:9000:221c:5000:3:fdd6:fcc0:93a1]:443",
            "18.65.214.3:443",
            "[2600:9000:221c:4000:3:fdd6:fcc0:93a1]:443",
        ]
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
        sort_ipv6_first(&mut addrs);
        assert!(addrs[..2].iter().all(SocketAddr::is_ipv6), "{addrs:?}");
        assert!(addrs[2..].iter().all(SocketAddr::is_ipv4), "{addrs:?}");
        assert_eq!(addrs[2], "18.65.214.3:443".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn public_and_fakeip_are_allowed() {
        for ip in [
            "1.1.1.1",
            "8.8.8.8",
            "198.18.0.0",
            "198.19.255.255",
            "2606:4700:4700::1111",
            "::ffff:198.18.0.1",
        ] {
            assert!(allowed_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn private_and_special_addresses_are_blocked() {
        for ip in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "100.127.255.254",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "192.0.0.1",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.1.1",
            "64:ff9b::c0a8:101",
            "2002:c0a8:101::1",
            "2001::1",
            "2001:db8::1",
            "3fff::1",
        ] {
            assert!(!allowed_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn reserved_ipv6_subranges_are_covered_by_the_existing_block() {
        for raw in [
            "2001:2::1",
            "2001:2:ffff:ffff:ffff:ffff:ffff:ffff",
            "2001:10::1",
            "2001:1f:ffff:ffff:ffff:ffff:ffff:ffff",
        ] {
            assert!(!allowed_ip(raw.parse().unwrap()), "{raw}");
        }
    }

    #[test]
    fn alternate_spellings_and_unsafe_urls_are_blocked() {
        for raw in [
            "http://127.1/",
            "http://2130706433/",
            "http://0x7f000001/",
            "http://[::ffff:192.168.0.1]/",
            "http://localhost./",
            "http://foo.local/",
            "file:///etc/passwd",
            "https://user:secret@example.com/",
            "https://example.com/\n",
        ] {
            assert!(parse_target(raw).is_err(), "{raw}");
        }
        assert!(parse_target("http://198.18.0.1/video").is_ok());
    }

    #[test]
    fn mixed_dns_and_redirect_bypasses_are_blocked() {
        let addrs = [
            "1.1.1.1:443".parse().unwrap(),
            "192.168.1.1:443".parse().unwrap(),
        ];
        assert!(check_addresses(&addrs).is_err());
        assert!(check_addresses(&[]).is_err());
        let current = Url::parse("https://example.com/media").unwrap();
        assert!(redirect_target(&current, "//127.0.0.1/private").is_err());
        assert!(redirect_target(&current, "http://example.com/media").is_err());
        assert!(redirect_target(&current, "https://198.19.0.1/media").is_ok());
        assert_eq!(
            redirect_target(&current, "/next").unwrap().as_str(),
            "https://example.com/next"
        );
    }

    #[test]
    fn relaxed_mode_and_cli_flags_work_without_exposing_internal_hosts() {
        assert_eq!(parse_strict_override(["hghubx"], None), None);
        assert_eq!(
            parse_strict_override(["hghubx", "--no-strict"], None),
            Some(false)
        );
        assert_eq!(
            parse_strict_override(["hghubx", "--no-strict-security"], None),
            Some(false)
        );
        assert_eq!(
            parse_strict_override(["hghubx", "--no-strict", "--strict"], None),
            Some(true)
        );
        assert_eq!(parse_strict_override(["hghubx"], Some("0")), Some(false));
        assert!(parse_target_with_mode("http://10.0.0.1/video.m3u8", false).is_ok());
        assert!(parse_target_with_mode("http://nas.local/video.m3u8", false).is_ok());
        assert!(parse_target_with_mode("http://tauri.localhost/", false).is_err());
        assert!(parse_target_with_mode("http://hg.localhost/img", false).is_err());
        assert!(parse_target_with_mode("http://ipc.localhost/", false).is_err());
        assert!(parse_target_with_mode("javascript:alert(1)", false).is_err());
    }
}
