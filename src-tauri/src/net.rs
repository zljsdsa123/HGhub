//! 网络层：与上游站点对话。
//!
//! 站点把全部 `/api/**` 调用收敛成 `POST /api/edge/request` 的信封，
//! 我们只实现这一个入口，其余接口都是「填 path」。
//!
//! # 代理（用户反馈「浏览器能开、HGhubX 打不开」的根因就在这里）
//!
//! 客户端的流量**全部**走本文件的 reqwest，跟 WebView2 无关，所以它既不共享
//! 浏览器的代理设置，也不共享浏览器的证书库：
//!
//! * reqwest 只有开了 `system-proxy` feature 才会读 Windows 系统代理
//!   （`HKCU\...\Internet Settings` 的 `ProxyEnable`/`ProxyServer`/`ProxyOverride`）。
//!   本 crate 用 `default-features = false`，早先漏了这个 feature ⇒ 永远直连，
//!   只有 TUN/虚拟网卡这种网络层接管才「看起来能用」。
//! * macOS 的 `system-proxy` 会读取系统 HTTP/HTTPS 代理；iOS 没有对应的系统代理读取，
//!   仍由 VPN/TUN 接管流量，或通过 `HGHUBX_PROXY` 显式指定代理。
//! * 即使开了 `system-proxy`，PAC（`AutoConfigURL`）也不被支持，只认固定代理。
//! * Android 没有注册表可读，系统「Wi-Fi 代理」同样不被 reqwest 采用；
//!   安卓上只有 VPN/TUN 模式（VpnService 抓全流量）才有效。
//!
//! 排查手段：环境变量 `HGHUBX_PROXY=http://127.0.0.1:7897` 可强制指定代理，
//! 进程里的 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 由 reqwest `system-proxy` 读取；
//! Linux 桌面还会读 GNOME 的 `gsettings` 手动代理（http/socks），无需用户手动设置。
//! `net_diag` 命令会输出 DNS/HTTP/环境变量与探测到的代理（脱敏）快照。

use crate::network_policy;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// 默认上游（固定线路 1）。
pub const DEFAULT_BASE: &str = "https://huangguoai.com";

/// 当前上游基址（不带结尾斜杠）。可在设置里切到固定线路 2 或镜像线路，运行时立即生效。
#[derive(Clone, Debug, PartialEq, Eq)]
struct LineConfig {
    base: String,
    custom: bool,
}

impl Default for LineConfig {
    fn default() -> Self {
        Self { base: DEFAULT_BASE.to_string(), custom: false }
    }
}

static BASE: Lazy<RwLock<LineConfig>> = Lazy::new(|| RwLock::new(LineConfig::default()));
/// 线路配置落盘位置（应用数据目录/line.json），由 [`bind_base`] 在启动时绑定。
static BASE_FILE: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

/// 当前上游基址。
pub fn base() -> String {
    BASE.read()
        .map(|b| b.base.clone())
        .unwrap_or_else(|_| DEFAULT_BASE.to_string())
}

pub fn is_custom_line() -> bool {
    BASE.read().is_ok_and(|line| line.custom)
}

/// 线路必须是纯 HTTPS origin，不允许路径、认证、查询串或片段。
pub fn normalize_base(raw: &str) -> Option<String> {
    let parsed = network_policy::parse_target_with_mode(raw.trim(), true).ok()?;
    if parsed.scheme() != "https"
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

/// 哪些 origin 允许携带凭据：两个固定入口，加上发布页推荐过、且当前可能作为线路的镜像。
///
/// 国内网络连不上 `.com`，只能用镜像；镜像和主站是同一后端、同一个账号体系。
/// 自定义线路必须由用户显式保存；旧格式文件只恢复地址，不自动授予登录权限。
/// 会话仍绑定 origin，切换地址不会把已有 token 发送给另一个站点。
pub fn trusted_auth_origin(origin: &str) -> bool {
    matches!(origin, "https://huangguoai.com" | "https://huangguoai.ai")
        || crate::lines::is_trusted_mirror(origin)
        || BASE.read().is_ok_and(|line| line.custom && line.base == origin)
}

fn persisted_base(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    normalize_base(value.get("base")?.as_str()?)
}

fn persisted_line(text: &str) -> Option<LineConfig> {
    let base = persisted_base(text)?;
    let value: Value = serde_json::from_str(text).ok()?;
    // Accept the fork's v2 format as well as legacy {base}. Only explicit v2
    // custom selections carry custom-origin consent across restarts.
    let custom = value.get("v").and_then(Value::as_u64) == Some(2)
        && value.get("custom").and_then(Value::as_bool).unwrap_or(false)
        && base != DEFAULT_BASE;
    Some(LineConfig { base, custom })
}

/// 启动时恢复旧线路，但本地文件本身不会授予镜像凭据权限。
pub fn bind_base(dir: &std::path::Path) {
    network_policy::bind_security(dir);
    crate::proxy::bind(dir);
    let path = dir.join("line.json");
    let restored = std::fs::read_to_string(&path).ok()
        .and_then(|text| persisted_line(&text)).unwrap_or_default();
    if let Ok(mut current) = BASE.write() {
        *current = restored;
    }
    if let Ok(mut f) = BASE_FILE.write() {
        *f = Some(path);
    }
    refresh_media_scope();
}

/// 切换线路并落盘，返回规整后的地址。
pub fn set_base(url: &str) -> Result<String, String> {
    apply_base(url, false)
}

/// An explicit custom selection, separate from published/automatic candidates.
pub fn set_custom_base(url: &str) -> Result<String, String> {
    apply_base(url, true)
}

fn save_line(current: &mut LineConfig, next: LineConfig, path: Option<&std::path::Path>) -> Result<(), String> {
    if let Some(path) = path {
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, json!({ "v": 2, "base": next.base, "custom": next.custom }).to_string())
            .and_then(|_| std::fs::rename(&temp, path))
            .map_err(|_| "线路保存失败，已保持原线路，请检查应用数据目录")?;
    }
    *current = next;
    Ok(())
}

fn apply_base(url: &str, custom: bool) -> Result<String, String> {
    let next = normalize_base(url)
        .ok_or_else(|| "线路地址无效（需要纯 HTTPS 站点地址，禁止内网）".to_string())?;
    if !custom && !crate::lines::is_fixed(&next) && !crate::lines::is_trusted_mirror(&next) {
        return Err("线路不在固定线路或可信发布页清单中".into());
    }
    let mut current = BASE.write().map_err(|_| "线路设置锁失败")?;
    let previous = current.base.clone();
    let file = BASE_FILE.read().map_err(|_| "线路配置锁失败")?;
    save_line(&mut current, LineConfig { base: next.clone(), custom: custom && next != DEFAULT_BASE }, file.as_deref())?;
    drop(current);
    if previous != next {
        crate::playback_log::record(
            "line.changed",
            json!({
                "previous_host": url::Url::parse(&previous).ok().and_then(|u| u.host_str().map(str::to_owned)),
                "line_host": url::Url::parse(&next).ok().and_then(|u| u.host_str().map(str::to_owned)),
            }),
        );
    }
    Ok(next)
}

pub const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// 手动指定代理（排查 / 公司内网用）：`HGHUBX_PROXY=http://127.0.0.1:7897`。
/// 不设时交给 reqwest 的 `system-proxy` 探测（注册表 + 环境变量）。
fn proxy_override() -> Option<String> {
    crate::env::var("PROXY")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 进程环境变量里有没有代理（reqwest 的 `system-proxy` 会自己读这些，不重复应用）。
fn env_proxy_set() -> bool {
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
        .iter()
        .any(|key| std::env::var(key).ok().is_some_and(|v| !v.trim().is_empty()))
}

/// 应用层最终采用的显式代理（不含环境变量——那部分交给 reqwest）。
/// 优先级：`HGHUBX_PROXY` > 进程环境变量（reqwest 处理）> Linux GNOME gsettings。
fn system_explicit_proxy() -> Option<String> {
    if let Some(p) = proxy_override() {
        return Some(p);
    }
    if env_proxy_set() {
        return None;
    }
    gnome_proxy()
}

#[cfg(target_os = "linux")]
fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// 读 GNOME 系统代理配置（gsettings）。gsettings 不存在 / schema 缺失时返回 None。
#[cfg(target_os = "linux")]
fn gsettings_get(schema: &str, key: &str) -> Option<String> {
    let out = std::process::Command::new("gsettings")
        .args(["get", schema, key])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(unquote(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(target_os = "linux")]
fn format_proxy_url(scheme: &str, host: &str, port: &str) -> String {
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    format!("{scheme}://{host}:{port}")
}

/// Linux 桌面（GNOME）的固定手动代理：`mode=manual` 时取 http，为空再试 socks。
/// PAC（mode=auto）不支持，返回 None。
#[cfg(target_os = "linux")]
fn gnome_proxy() -> Option<String> {
    if gsettings_get("org.gnome.system.proxy", "mode").as_deref() != Some("manual") {
        return None;
    }
    let http_host = gsettings_get("org.gnome.system.proxy.http", "host").unwrap_or_default();
    let http_port = gsettings_get("org.gnome.system.proxy.http", "port").unwrap_or_default();
    if !http_host.is_empty() && !http_port.is_empty() {
        return Some(format_proxy_url("http", &http_host, &http_port));
    }
    let socks_host = gsettings_get("org.gnome.system.proxy.socks", "host").unwrap_or_default();
    let socks_port = gsettings_get("org.gnome.system.proxy.socks", "port").unwrap_or_default();
    if !socks_host.is_empty() && !socks_port.is_empty() {
        return Some(format_proxy_url("socks5", &socks_host, &socks_port));
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn gnome_proxy() -> Option<String> {
    None
}

/// Windows 系统代理：读 `HKCU\...\Internet Settings`，`ProxyEnable=1` 且 `ProxyServer`
/// 非空即视为已启用。reqwest 已开 `system-proxy` 会自动按注册表走，这里只返回 bool。
#[cfg(target_os = "windows")]
fn windows_proxy_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
    else {
        return false;
    };
    let enabled: u32 = match key.get_value("ProxyEnable") {
        Ok(v) => v,
        Err(_) => return false,
    };
    if enabled != 1 {
        return false;
    }
    key.get_value::<String, _>("ProxyServer")
        .is_ok_and(|server| !server.trim().is_empty())
}

#[cfg(not(target_os = "windows"))]
fn windows_proxy_enabled() -> bool {
    false
}

/// macOS 系统代理：`scutil --proxy` 输出里 HTTP/HTTPS/SOCKS 任一项 Enable=1 即视为已启用。
#[cfg(target_os = "macos")]
fn macos_proxy_enabled() -> bool {
    let Ok(out) = std::process::Command::new("scutil").arg("--proxy").output() else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    ["HTTPEnable", "HTTPSEnable", "SOCKSEnable"]
        .iter()
        .any(|key| {
            text.lines().any(|line| {
                let mut parts = line.splitn(2, ':');
                parts.next().map(str::trim) == Some(*key)
                    && parts.next().map(|value| value.trim() == "1").unwrap_or(false)
            })
        })
}

#[cfg(not(target_os = "macos"))]
fn macos_proxy_enabled() -> bool {
    false
}

/// 操作系统级系统代理是否已启用（Windows 注册表 / macOS scutil / Linux GNOME），只报 bool。
fn system_proxy_enabled() -> bool {
    windows_proxy_enabled() || macos_proxy_enabled() || gnome_proxy().is_some()
}

/// 按**当前**系统代理设置新建一个客户端。
///
/// 注意：reqwest 的 `system-proxy` 只在构建时读一次注册表 / 环境变量。代理软件被关掉后，
/// 旧客户端仍会往 `127.0.0.1:7897` 建隧道，症状是满屏 `tunnel error: failed to create
/// underlying connection`（浏览器却是通的，因为它每次都重读系统代理）。所以这里允许重建。
fn build_client(host: &str, addrs: &[SocketAddr], route: &ProxyRoute) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .gzip(true)
        .brotli(true)
        .pool_idle_timeout(Duration::from_secs(60));
    if !addrs.is_empty() {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    if route.mode == crate::proxy::Mode::Off {
        builder = builder.no_proxy();
    } else if let Some(proxy) = &route.explicit {
        let proxy = reqwest::Proxy::all(proxy).map_err(|_| "代理配置无效（已隐藏原始值）")?;
        builder = builder.no_proxy().proxy(proxy);
    }
    builder.build().map_err(|_| "无法创建 HTTP 客户端".to_string())
}

/// One immutable selection is used for DNS, cache identity and client creation.
/// An in-flight request may finish on its old route; it cannot populate the new
/// configuration's cache entry after the user saves a different proxy.
struct ProxyRoute {
    mode: crate::proxy::Mode,
    explicit: Option<String>,
    active: bool,
    generation: u64,
}

impl ProxyRoute {
    fn for_config(config: &crate::proxy::Config, target: &url::Url) -> Self {
        use crate::proxy::Mode;
        let explicit = match config.mode {
            Mode::Off => None,
            Mode::Custom => Some(config.url.clone()),
            Mode::System => system_explicit_proxy(),
        };
        let active = match config.mode {
            Mode::Off => false,
            Mode::Custom => true,
            Mode::System => explicit.is_some() || system_proxy_routes_target(target),
        };
        Self { mode: config.mode, explicit, active, generation: CLIENT_GENERATION.load(Ordering::Acquire) }
    }

    fn fingerprint(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        self.mode.hash(&mut hash);
        self.explicit.hash(&mut hash);
        hash.finish()
    }

    fn label(&self) -> String {
        if self.mode == crate::proxy::Mode::Off {
            "direct".into()
        } else if let Some(proxy) = &self.explicit {
            redact_proxy(proxy)
        } else if self.active {
            "system".into()
        } else {
            "direct".into()
        }
    }
}

static CLIENT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
// Rebuilding HTTP clients for a probe does not change the media transport.
// Only a different effective configuration invalidates completed media caches.
static MEDIA_CONFIG_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static MEDIA_CONFIG_FINGERPRINT: Lazy<Mutex<Option<u64>>> = Lazy::new(|| Mutex::new(None));
const CLIENT_TTL: Duration = Duration::from_secs(30);
type ClientCache = HashMap<String, (Instant, Arc<reqwest::Client>)>;
static CLIENTS: Lazy<Mutex<ClientCache>> = Lazy::new(|| Mutex::new(HashMap::new()));
static MEDIA_DNS_ROUTES: Lazy<Mutex<crate::media_dns::Routes>> =
    Lazy::new(|| Mutex::new(crate::media_dns::Routes::default()));

/// Immutable transport identity captured when a media single-flight starts.
///
/// Only an effective line/proxy/security change increments `generation`.
/// Routine connection/DNS refreshes leave completed media caches usable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RequestScope {
    pub(crate) strict: bool,
    pub(crate) generation: u64,
}

pub(crate) fn request_scope() -> RequestScope {
    RequestScope {
        strict: network_policy::strict_security(),
        generation: MEDIA_CONFIG_GENERATION.load(Ordering::Acquire),
    }
}

fn media_config_fingerprint(
    origin: &str,
    strict: bool,
    config: &crate::proxy::Config,
    system_proxy: u64,
) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    origin.hash(&mut hash);
    strict.hash(&mut hash);
    config.mode.hash(&mut hash);
    match config.mode {
        crate::proxy::Mode::Custom => config.url.hash(&mut hash),
        crate::proxy::Mode::System => system_proxy.hash(&mut hash),
        crate::proxy::Mode::Off => {}
    }
    hash.finish()
}

/// Snapshot system settings only when rebuilding clients, never per segment.
/// Values (including proxy credentials) are hashed in memory and never logged.
fn system_proxy_fingerprint() -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    proxy_override().hash(&mut hash);
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] {
        name.hash(&mut hash);
        std::env::var_os(name).hash(&mut hash);
    }
    #[cfg(target_os = "linux")]
    system_explicit_proxy().hash(&mut hash);
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    format!("{:?}", hyper_util::client::proxy::matcher::Matcher::from_system()).hash(&mut hash);
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        {
            key.get_value::<u32, _>("ProxyEnable").ok().hash(&mut hash);
            key.get_value::<String, _>("ProxyServer").ok().hash(&mut hash);
            key.get_value::<String, _>("ProxyOverride").ok().hash(&mut hash);
        }
    }
    hash.finish()
}

fn update_media_generation(
    previous: &mut Option<u64>,
    fingerprint: u64,
    generation: &std::sync::atomic::AtomicU64,
) {
    if *previous != Some(fingerprint) {
        *previous = Some(fingerprint);
        generation.fetch_add(1, Ordering::AcqRel);
    }
}

fn refresh_media_scope() {
    if let Ok(mut previous) = MEDIA_CONFIG_FINGERPRINT.lock() {
        let config = crate::proxy::snapshot();
        let system_proxy = if config.mode == crate::proxy::Mode::System {
            system_proxy_fingerprint()
        } else {
            0
        };
        let fingerprint = media_config_fingerprint(&base(), network_policy::strict_security(), &config, system_proxy);
        update_media_generation(&mut previous, fingerprint, &MEDIA_CONFIG_GENERATION);
    }
}

fn cached_client(cache: &ClientCache, key: &str, now: Instant) -> Option<Arc<reqwest::Client>> {
    cache
        .get(key)
        .filter(|(expires, _)| now < *expires)
        .map(|(_, http)| http.clone())
}

/// 缓存按模式、主机和端口隔离；有效期内仅复用已经检查并固定地址的客户端。
/// 到期后重新检查全部 DNS 答案，不使用旧连接绕过新的目标检查。
async fn client_for(raw: &str) -> Result<(url::Url, Arc<reqwest::Client>), String> {
    client_for_dns(raw, false).await
}

/// Keep Apple's existing per-target NO_PROXY/per-scheme/system matching.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn system_proxy_routes_target(target: &url::Url) -> bool {
    crate::apple_proxy::routes_target(
        &hyper_util::client::proxy::matcher::Matcher::from_system(),
        target.as_str(),
    )
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn system_proxy_routes_target(_target: &url::Url) -> bool {
    env_proxy_set() || windows_proxy_enabled()
}

fn proxy_active(target: &url::Url) -> bool {
    ProxyRoute::for_config(&crate::proxy::snapshot(), target).active
}

fn client_key(strict: bool, host: &str, port: u16, public_dns: bool, route: &ProxyRoute) -> String {
    format!("{strict}:{host}:{port}:{public_dns}:{}:{:x}:{}", route.active, route.fingerprint(), route.generation)
}

async fn client_for_dns(raw: &str, public_dns: bool) -> Result<(url::Url, Arc<reqwest::Client>), String> {
    let strict = network_policy::strict_security();
    let target = network_policy::parse_target_with_mode(raw, strict)?;
    let host = target.host_str().ok_or("目标缺少主机名")?;
    let port = target.port_or_known_default().ok_or("目标端口无效")?;
    let route = ProxyRoute::for_config(&crate::proxy::snapshot(), &target);
    let proxy = route.active;
    let key = client_key(strict, host, port, public_dns, &route);
    {
        let cache = CLIENTS.lock().map_err(|_| "HTTP 客户端锁失败")?;
        if let Some(http) = cached_client(&cache, &key, Instant::now()) {
            return Ok((target, http));
        }
    }
    let (addrs, ttl) = if proxy {
        // 有代理：跳过本地解析与 IP 校验，addrs 留空，域名交给代理。
        (Vec::new(), CLIENT_TTL)
    } else if public_dns {
        let resolver = build_client(crate::media_dns::HOST, &crate::media_dns::BOOTSTRAP, &route)?;
        let resolution = crate::media_dns::resolve(&resolver, host, port).await?;
        network_policy::check_addresses_with_mode(&resolution.addresses, strict)?;
        (resolution.addresses, CLIENT_TTL.min(resolution.ttl))
    } else if strict {
        (network_policy::resolve_target(&target, strict).await?, CLIENT_TTL)
    } else {
        (Vec::new(), CLIENT_TTL)
    };
    let http = Arc::new(build_client(host, &addrs, &route)?);
    let now = Instant::now();
    let mut cache = CLIENTS.lock().map_err(|_| "HTTP 客户端锁失败")?;
    // 同时到达的请求可能已完成解析；不延长已有结果的有效期。
    let http = cached_client(&cache, &key, now).unwrap_or(http);
    if !cache.get(&key).is_some_and(|(expires, _)| now < *expires) {
        cache.retain(|_, (expires, _)| now < *expires);
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(key, (now + ttl, http.clone()));
    }
    Ok((target, http))
}

pub fn refresh_client() {
    // A periodic main-site probe can rebuild clients without changing proxy or
    // line. Preserve KEY/SEG caches unless the actual configuration changed.
    refresh_media_scope();
    // Builders still resolving DNS must not repopulate the new generation.
    CLIENT_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut cache) = CLIENTS.lock() {
        cache.clear();
    }
    if let Ok(mut routes) = MEDIA_DNS_ROUTES.lock() {
        *routes = crate::media_dns::Routes::default();
    }
}

/// 不可信 GET 的统一入口；自动重定向被关闭，每一跳重新检查 URL、DNS 并固定解析地址。
pub async fn get(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
) -> Result<reqwest::Response, String> {
    get_with_dns(raw, timeout, accept, referer, false).await
}

async fn get_with_dns(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
    public_dns: bool,
) -> Result<reqwest::Response, String> {
    tokio::time::timeout(timeout, async {
        let policy_error = |phase: &str, error: String| {
            crate::playback_log::record("network.target_failed", json!({"resource": crate::playback_log::resource_id(raw), "phase": phase, "error_kind": crate::playback_log::error_kind(&error)}));
            error
        };
        let mut next = network_policy::parse_target(raw).map_err(|e| policy_error("parse", e))?;
        for hop in 0..=5 {
            let resolving = Instant::now();
            let (target, http) = client_for_dns(next.as_str(), public_dns).await.map_err(|e| policy_error("dns_or_client", e))?;
            crate::playback_log::record("network.target_ready", json!({"resource": crate::playback_log::resource_id(raw), "target_resource": crate::playback_log::resource_id(target.as_str()), "dns_or_client_ms": resolving.elapsed().as_millis() as u64, "hop": hop}));
            let mut request = http.get(target.clone()).timeout(timeout);
            if let Some(value) = accept {
                request = request.header("Accept", value);
            }
            if let Some(value) = referer {
                request = request.header("Referer", value);
            }
            let response = request.send().await.map_err(|e| err_text(&e))?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            if hop == 5 {
                return Err("重定向次数超过限制".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("重定向缺少有效 Location")?;
            next = network_policy::redirect_target(&target, location).map_err(|e| policy_error("redirect", e))?;
            crate::playback_log::record("network.redirect", json!({"resource": crate::playback_log::resource_id(raw), "from": crate::playback_log::resource_id(target.as_str()), "to": crate::playback_log::resource_id(next.as_str()), "status": response.status().as_u16(), "hop": hop + 1}));
        }
        Err("重定向次数超过限制".into())
    })
    .await
    .map_err(|_| "请求超时".to_string())?
}

/// 只返回代理的协议/主机/端口；解析失败时隐藏整个值，绝不回传认证或查询参数。
pub fn redact_proxy(raw: &str) -> String {
    let parsed = url::Url::parse(raw.trim())
        .ok()
        .filter(|u| u.host_str().is_some());
    match parsed {
        Some(url) => {
            let mut safe = format!("{}://{}", url.scheme(), url.host_str().unwrap());
            if let Some(port) = url.port() {
                safe.push_str(&format!(":{port}"));
            }
            safe
        }
        None => "[已配置，原始值已隐藏]".into(),
    }
}

/// 看起来像代理 / 隧道问题（而不是目标站点本身不可达）。
pub fn is_proxy_error(e: &str) -> bool {
    let e = e.to_ascii_lowercase();
    e.contains("tunnel") || e.contains("proxy")
}

static LAST_HEAL: Lazy<std::sync::Mutex<Option<Instant>>> =
    Lazy::new(|| std::sync::Mutex::new(None));

/// 请求失败后按需重建客户端：代理隧道错误、连接被拒 / 超时都算「网络环境可能变了」。
/// 3 秒内只重建一次，批量探测不会反复重建。
pub fn heal_client(reason: &str) {
    let connectish = reason.contains("Connect")
        || reason.contains("timed out")
        || reason.contains("refused")
        || reason.contains("dns");
    if !is_proxy_error(reason) && !connectish {
        return;
    }
    let mut last = match LAST_HEAL.lock() {
        Ok(l) => l,
        Err(_) => return,
    };
    if let Some(t) = *last {
        if t.elapsed() < Duration::from_secs(3) {
            return;
        }
    }
    *last = Some(Instant::now());
    drop(last);
    refresh_client();
}

/// reqwest 的 `Display` 只有「error sending request for url (...)」，
/// 真正的原因（dns error / connection refused / invalid peer certificate）
/// 藏在 `source()` 链里。展开成一行，界面和 debug.log 才有排查价值。
pub fn err_text(e: &reqwest::Error) -> String {
    let mut out = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        let t = s.to_string();
        if !t.is_empty() && !out.contains(&t) {
            out.push_str(" ← ");
            out.push_str(&t);
        }
        src = s.source();
    }
    redact_error_proxy_auth(&out)
}

/// Transport source chains are not guaranteed to redact proxy userinfo. Remove
/// userinfo from embedded URLs while keeping hosts and useful failure details.
fn redact_error_proxy_auth(message: &str) -> String {
    let mut output = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(separator) = rest.find("://") {
        let authority_start = separator + 3;
        output.push_str(&rest[..authority_start]);
        rest = &rest[authority_start..];
        let authority_end = rest.find(|ch: char| ch.is_whitespace() || matches!(ch, '/' | '?' | '#' | '\'' | '"' | '<' | '>'))
            .unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        if let Some(at) = authority.rfind('@') {
            output.push_str("[redacted]@");
            output.push_str(&authority[at + 1..]);
        } else {
            output.push_str(authority);
        }
        rest = &rest[authority_end..];
    }
    output.push_str(rest);
    output
}

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
            .iter().find_map(|key| std::env::var(key).ok().filter(|value| !value.trim().is_empty()))
            .map(|value| redact_proxy(&value))
            .or_else(|| Some("system".to_owned()))
    };
    json!({
        "mode": config.mode.as_str(), "url": config.url, "effective": effective,
        "system_proxy": system_proxy_enabled(), "env_proxy": env_proxy_set(),
    })
}

fn healthy_proxy_response(status: u16, body: &[u8]) -> bool {
    if status != 200 { return false; }
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
    let result = tokio::time::timeout(Duration::from_secs(8),
        probe_proxy_origin(&origin, &config, network_policy::strict_security())).await;
    let mut value = match result {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => json!({"ok": false, "error": error}),
        Err(_) => json!({"ok": false, "error": "代理连通性测试超时（8 秒）"}),
    };
    value["ms"] = json!(started.elapsed().as_millis() as u64);
    value
}

async fn probe_proxy_origin(origin: &str, config: &crate::proxy::Config, strict: bool) -> Result<Value, String> {
    let mut next = network_policy::parse_target_with_mode(&format!("{origin}/api/edge/request"), strict)?;
    let envelope = json!({ "method": "GET", "path": "/api/videos?page=1&size=1", "body": "", "content_type": "" });
    for hop in 0..=5 {
        let route = ProxyRoute::for_config(config, &next);
        let addresses = if strict && !route.active { network_policy::resolve_target(&next, strict).await? } else { Vec::new() };
        let client = build_client(next.host_str().ok_or("目标缺少主机名")?, &addresses, &route)?;
        let response = client.post(next.clone())
            .header("Accept", "application/json")
            .header("Referer", format!("{origin}/"))
            .json(&envelope).send().await.map_err(proxy_probe_error)?;
        let status = response.status().as_u16();
        if response.status().is_redirection() {
            if hop == 5 { return Err("重定向次数超过限制".into()) }
            let location = response.headers().get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok()).ok_or("重定向缺少有效 Location")?;
            next = edge_redirect_target(&next, status, location, true)?;
            continue;
        }
        if status != 200 {
            return Ok(json!({"ok": false, "status": status, "via": route.label(), "error": "视频接口返回错误状态码"}));
        }
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(proxy_probe_error)? {
            if body.len() + chunk.len() > 1024 * 1024 { return Err("视频接口响应超过测试大小限制".into()) }
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
    if error.is_timeout() { "代理连通性测试超时" }
    else if error.is_connect() { "代理或目标连接失败，请检查地址、认证信息和网络" }
    else if error.is_body() || error.is_decode() { "视频接口响应读取失败" }
    else { "代理连通性测试请求失败" }.into()
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

fn retryable_error(error: &str) -> bool {
    if error == "401" {
        return false;
    }
    if let Some(status) = error
        .strip_prefix("HTTP ")
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse::<u16>().ok())
    {
        return matches!(status, 408 | 425 | 429 | 500..=599);
    }
    !matches!(
        crate::playback_log::error_kind(error),
        "https_downgrade_denied"
            | "private_address_denied"
            | "target_policy_denied"
            | "redirect_error"
    )
}

/// 只重试可能恢复的错误；404/权限错误/安全拒绝直接结束，避免无效等待。
/// 站点偶发 TLS 抖动；碰上代理隧道错误就先重建客户端再试
/// （代理软件开关后旧客户端会一直卡在 tunnel error 上）。
async fn with_retry<F, Fut, T>(retry: bool, mut f: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut last = String::from("network error");
    let attempts = if retry { 3 } else { 1 };
    for attempt in 0..attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e;
                if !retryable_error(&last) {
                    return Err(last);
                }
                heal_client(&last);
                if attempt + 1 < attempts {
                    tokio::time::sleep(Duration::from_millis(350 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last)
}

// 只记录固定的操作类型，不写搜索词、账号、内容 ID 或查询参数。
fn edge_operation(path: &str) -> &'static str {
    let path = path.split('?').next().unwrap_or("");
    if path.starts_with("/api/videos/category/") {
        "category"
    } else if path.starts_with("/api/videos/") && path.ends_with("/play") {
        "play"
    } else if path == "/api/videos" {
        "feed"
    } else if path.starts_with("/api/videos/") {
        "video"
    } else if path == "/api/posts" {
        "posts"
    } else if path.starts_with("/api/posts/") {
        "post"
    } else if path.starts_with("/api/ranks/") {
        "rank"
    } else if path == "/api/search" {
        "search"
    } else if path.starts_with("/api/account/") {
        "account"
    } else {
        "other"
    }
}

/// 仅无请求体、无凭据的逻辑 GET 可以迁移网关；信封本身仍使用 POST。
fn edge_redirect_target(
    current: &url::Url,
    status: u16,
    location: &str,
    guest_get: bool,
) -> Result<url::Url, String> {
    if !guest_get || !matches!(status, 301 | 302 | 303) {
        return Err("业务接口重定向已拒绝".into());
    }
    network_policy::redirect_target(current, location)
}

/// 业务请求：走边缘信封。
pub async fn edge(
    origin: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value, String> {
    let cur = normalize_base(origin).ok_or("业务请求必须使用安全 HTTPS 线路")?;
    if network_policy::strict_security()
        && (token.is_some()
            || matches!(
                path,
                "/api/account/loginByPassword" | "/api/account/registerByPassword"
            ))
        && !trusted_auth_origin(&cur)
    {
        if cur != base() || crate::lines::verify_published_origin(&cur).await.is_err() {
            return Err("镜像线路仅供游客浏览；登录/注册请切换到固定线路或重新加载发布页验证镜像".into());
        }
    }
    let (encoded, ctype) = match &body {
        Some(v) => (
            B64.encode(serde_json::to_vec(v).map_err(|e| e.to_string())?),
            "application/json",
        ),
        None => (String::new(), ""),
    };
    let envelope = json!({
        "method": method,
        "path": path,
        "body": encoded,
        "content_type": ctype,
    });

    let url = format!("{cur}/api/edge/request");
    let referer = format!("{cur}/");
    let token = token.map(|s| s.to_string());

    static NEXT_EDGE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let request = NEXT_EDGE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let line_host = url::Url::parse(&cur)
        .unwrap()
        .host_str()
        .unwrap()
        .to_string();
    let operation = edge_operation(path);
    let mut attempt = 0;
    let guest_get = method.eq_ignore_ascii_case("GET") && body.is_none() && token.is_none();
    let can_retry = method.eq_ignore_ascii_case("GET") && body.is_none();
    let value = with_retry(can_retry, || {
        attempt += 1;
        let attempt = attempt;
        let envelope = envelope.clone();
        let token = token.clone();
        let url = url.clone();
        let referer = referer.clone();
        let line_host = line_host.clone();
        async move {
            let started = Instant::now();
            crate::playback_log::record("api.begin", json!({"request": request, "attempt": attempt, "operation": operation, "method": method, "line_host": line_host}));
            let mut status_code = None;
            let mut headers_ms = None;
            let mut target_host = line_host.clone();
            let mut response_kind = "unknown";
            let mut gateway = "other";
            let result = async {
                let mut next = network_policy::parse_target(&url)?;
                for hop in 0..=5 {
                    let (target, client) = client_for(next.as_str()).await?;
                    target_host = target.host_str().unwrap_or("").to_string();
                    let mut req = client
                        .post(target.clone())
                        .header("Accept", "application/json")
                        .header("Referer", &referer)
                        .json(&envelope);
                    if let Some(t) = token.as_deref() {
                        if !t.is_empty() {
                            req = req.header("Authorization", format!("Bearer {t}"));
                        }
                    }
                    let resp = req.send().await.map_err(|e| err_text(&e))?;
                    let status = resp.status();
                    status_code = Some(status.as_u16());
                    headers_ms = Some(started.elapsed().as_millis() as u64);
                    let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
                    response_kind = if ctype.contains("json") { "json" } else if ctype.contains("html") { "html" } else { "other" };
                    gateway = if resp.headers().contains_key("x-amz-cf-id") { "cloudfront" } else if resp.headers().contains_key("cf-ray") { "cloudflare" } else { "other" };
                    // 逐跳重建并检查客户端；不自动把信封 POST 改成无信封 GET。
                    if status.is_redirection() {
                        if hop == 5 {
                            return Err("重定向次数超过限制".into());
                        }
                        let location = resp
                            .headers()
                            .get(reqwest::header::LOCATION)
                            .and_then(|h| h.to_str().ok())
                            .ok_or("重定向缺少有效 Location")?;
                        next = edge_redirect_target(&target, status.as_u16(), location, guest_get)?;
                        continue;
                    }
                    let text = resp.text().await.map_err(|e| err_text(&e))?;
                    if status.as_u16() == 401 || status.as_u16() == 403 {
                        return Err("401".to_string());
                    }
                    if !status.is_success() {
                        return Err(format!(
                            "HTTP {status}: {}",
                            text.chars().take(160).collect::<String>()
                        ));
                    }
                    if text.trim().is_empty() {
                        return Ok(Value::Null);
                    }
                    return serde_json::from_str::<Value>(&text)
                        .map_err(|e| format!("{e}: {}", text.chars().take(160).collect::<String>()));
                }
                Err("重定向次数超过限制".into())
            }.await;
            crate::playback_log::record("api.end", json!({
                "request": request, "attempt": attempt, "operation": operation, "method": method,
                "line_host": line_host, "target_host": target_host, "status": status_code,
                "headers_ms": headers_ms, "elapsed_ms": started.elapsed().as_millis() as u64,
                "response_kind": response_kind, "gateway": gateway,
                "business_status": result.as_ref().ok().and_then(|v: &Value| v.get("status")).and_then(Value::as_i64),
                "error_kind": result.as_ref().err().map(|e: &String| crate::playback_log::error_kind(e)),
                "retryable": can_retry && result.as_ref().err().is_some_and(|e| retryable_error(e)),
            }));
            result
        }
    })
    .await?;

    if value.is_null() {
        return Ok(Value::Null);
    }

    if value.get("status").and_then(|v| v.as_i64()) == Some(1) {
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(value
            .get("msg")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("接口返回失败")
            .to_string())
    }
}

/// 拉原始字节（图片 / m3u8 / 分片）。
pub async fn fetch_bytes(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    static NEXT_REQUEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let request = NEXT_REQUEST.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let resource = crate::playback_log::resource_id(url);
    let mut attempt = 0;
    let url = url.to_string();
    let target = url::Url::parse(&url).ok();
    let host = target.as_ref().and_then(|target| target.host_str()).unwrap_or("").to_string();
    let public_dns = AtomicBool::new(MEDIA_DNS_ROUTES.lock().ok()
        .is_some_and(|routes| routes.prefers_public(&host, Instant::now())));
    let referer = format!("{}/", base());
    with_retry(true, || {
        attempt += 1;
        let attempt = attempt;
        let resource = resource.clone();
        let url = url.clone();
        let referer = referer.clone();
        let host = &host;
        let target = &target;
        let public_dns = &public_dns;
        async move {
            let using_public_dns = public_dns.load(Ordering::Relaxed);
            let started = Instant::now();
            crate::playback_log::record("network.begin", json!({"request": request, "resource": resource, "attempt": attempt}));
            let mut status = None;
            let mut headers_ms = None;
            let result = async {
                let resp = get_with_dns(&url, Duration::from_secs(20), None, Some(&referer), using_public_dns).await?;
                status = Some(resp.status().as_u16());
                headers_ms = Some(started.elapsed().as_millis() as u64);
                if !resp.status().is_success() {
                    return Err(format!("HTTP {}", resp.status()));
                }
                let ctype = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let bytes = resp.bytes().await.map_err(|e| err_text(&e))?.to_vec();
                Ok((ctype, bytes))
            }.await;
            if using_public_dns {
                if let Ok(mut routes) = MEDIA_DNS_ROUTES.lock() {
                    if result.is_ok() {
                        routes.remember(host, Instant::now());
                    } else {
                        routes.forget(host);
                    }
                }
            }
            if let Err(error) = &result {
                if target.as_ref().is_some_and(|target| crate::media_dns::eligible(target, error)) {
                    public_dns.store(!using_public_dns, Ordering::Relaxed);
                    crate::playback_log::record("network.dns_fallback", json!({"resource": resource, "attempt": attempt, "public_dns": !using_public_dns, "error_kind": crate::playback_log::error_kind(error)}));
                }
            }
            crate::playback_log::record("network.end", json!({"request": request, "resource": resource, "attempt": attempt, "public_dns": using_public_dns, "status": status, "headers_ms": headers_ms, "elapsed_ms": started.elapsed().as_millis() as u64, "bytes": result.as_ref().ok().map(|(_, bytes)| bytes.len()), "error_kind": result.as_ref().err().map(|e: &String| crate::playback_log::error_kind(e))}));
            result
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_generation_survives_repeated_refreshes_of_same_configuration() {
        let config = crate::proxy::Config::for_test("system", "").unwrap();
        let fingerprint = media_config_fingerprint(DEFAULT_BASE, true, &config, 17);
        let generation = std::sync::atomic::AtomicU64::new(0);
        let mut previous = None;
        update_media_generation(&mut previous, fingerprint, &generation);
        for _ in 0..8 {
            update_media_generation(&mut previous, fingerprint, &generation);
        }
        assert_eq!(generation.load(Ordering::Acquire), 1);
        let changed = media_config_fingerprint(DEFAULT_BASE, true, &config, 18);
        update_media_generation(&mut previous, changed, &generation);
        assert_eq!(generation.load(Ordering::Acquire), 2);
        // Returning to a previous configuration is a new epoch too: an old
        // in-flight response must not repopulate the newly selected scope.
        update_media_generation(&mut previous, fingerprint, &generation);
        assert_eq!(generation.load(Ordering::Acquire), 3);
    }

    #[test]
    fn media_fingerprint_changes_with_active_transport_configuration() {
        let system = crate::proxy::Config::for_test("system", "").unwrap();
        let direct = crate::proxy::Config::for_test("off", "").unwrap();
        let custom = crate::proxy::Config::for_test("custom", "http://127.0.0.1:7897").unwrap();
        let other_custom = crate::proxy::Config::for_test("custom", "http://127.0.0.1:7898").unwrap();
        let initial = media_config_fingerprint(DEFAULT_BASE, true, &system, 17);
        // The origin participates even when media URLs happen to be identical.
        assert_ne!(initial, media_config_fingerprint("https://huangguoai.ai", true, &system, 17));
        assert_ne!(initial, media_config_fingerprint(DEFAULT_BASE, false, &system, 17));
        assert_ne!(initial, media_config_fingerprint(DEFAULT_BASE, true, &system, 18));
        assert_ne!(initial, media_config_fingerprint(DEFAULT_BASE, true, &direct, 17));
        assert_ne!(initial, media_config_fingerprint(DEFAULT_BASE, true, &custom, 17));
        assert_ne!(
            media_config_fingerprint(DEFAULT_BASE, true, &custom, 17),
            media_config_fingerprint(DEFAULT_BASE, true, &other_custom, 17),
        );
    }

    #[test]
    fn media_fingerprint_ignores_inactive_proxy_preferences() {
        let direct = crate::proxy::Config::for_test("off", "").unwrap();
        let dormant_custom = crate::proxy::Config {
            mode: crate::proxy::Mode::Off,
            url: "http://127.0.0.1:7897".into(),
        };
        // Switching an OS proxy or retaining the previous custom address while
        // direct mode is selected does not alter the active transport.
        assert_eq!(
            media_config_fingerprint(DEFAULT_BASE, true, &direct, 17),
            media_config_fingerprint(DEFAULT_BASE, true, &dormant_custom, 18),
        );
        let custom = crate::proxy::Config::for_test("custom", "http://127.0.0.1:7897").unwrap();
        assert_eq!(
            media_config_fingerprint(DEFAULT_BASE, true, &custom, 17),
            media_config_fingerprint(DEFAULT_BASE, true, &custom, 18),
        );
        let system = crate::proxy::Config::for_test("system", "").unwrap();
        let dormant_custom = crate::proxy::Config {
            mode: crate::proxy::Mode::System,
            url: "http://127.0.0.1:7897".into(),
        };
        assert_eq!(
            media_config_fingerprint(DEFAULT_BASE, true, &system, 17),
            media_config_fingerprint(DEFAULT_BASE, true, &dormant_custom, 17),
        );
    }

    #[test]
    fn transport_errors_redact_proxy_auth_without_hiding_failure_category() {
        let raw = "error sending request for url (https://example.com/) ← proxy http://demo:secret@[::1]:7897 refused; socks5h://name:token@proxy.example:1080/path";
        let safe = redact_error_proxy_auth(raw);
        assert!(!safe.contains("demo") && !safe.contains("secret") && !safe.contains("name:token"));
        assert!(safe.contains("https://example.com/") && safe.contains("[::1]:7897 refused"));
        assert!(safe.contains("socks5h://[redacted]@proxy.example:1080/path"));
        assert_eq!(redact_error_proxy_auth("tls handshake eof"), "tls handshake eof");
    }

    #[test]
    fn proxy_probe_checks_feed_envelope_instead_of_http_status_only() {
        let valid = json!({"status": 1, "data": {"items": [{"id": 1, "title": "fixture"}], "pagination": {"page": 1, "size": 1, "pages": 1, "total": 1}}});
        assert!(healthy_proxy_response(200, valid.to_string().as_bytes()));
        assert!(!healthy_proxy_response(403, valid.to_string().as_bytes()));
        for body in [b"<html>homepage</html>".as_slice(), br#"{"status":0,"data":{}}"#, br#"{"status":1,"data":[]}"#, br#"{"status":1,"data":{"items":[],"pagination":{}}}"#] {
            assert!(!healthy_proxy_response(200, body));
        }
    }

    #[test]
    fn proxy_cache_identity_changes_with_mode_and_address_without_exposing_secrets() {
        let target = url::Url::parse("https://example.com/").unwrap();
        let custom = crate::proxy::Config::for_test("custom", "http://name:{{PASSWORD_pp0rajep}}@127.0.0.1:7897").unwrap();
        let route = ProxyRoute::for_config(&custom, &target);
        let first = client_key(true, "example.com", 443, false, &route);
        assert!(!first.contains("{{PASSWORD_pp0rajep}}"));
        assert_eq!(route.label(), "http://127.0.0.1:7897");
        for config in [crate::proxy::Config::for_test("off", "").unwrap(), crate::proxy::Config::for_test("custom", "http://127.0.0.1:7898").unwrap()] {
            let changed = ProxyRoute::for_config(&config, &target);
            assert_ne!(first, client_key(true, "example.com", 443, false, &changed));
        }
        assert!(!ProxyRoute::for_config(&crate::proxy::Config::for_test("off", "").unwrap(), &target).active);
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
            let mut request = String::new(); reader.read_line(&mut request).unwrap();
            let mut length = 0; let mut auth = false;
            loop {
                let mut line = String::new(); reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() { break; }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") { length = value.trim().parse::<usize>().unwrap(); }
                if line.to_ascii_lowercase().starts_with("authorization:") { auth = true; }
            }
            let mut body = vec![0; length]; reader.read_exact(&mut body).unwrap();
            let data = json!({"status":1,"data":{"items":[],"pagination":{"page":1,"size":1,"pages":0,"total":0}}}).to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}", data.len()).unwrap();
            (request, serde_json::from_slice::<Value>(&body).unwrap(), auth)
        });
        let before = crate::proxy::snapshot();
        let config = crate::proxy::Config::for_test("custom", &format!("http://{address}")).unwrap();
        // Host has no DNS record; only the explicitly supplied HTTP proxy can answer.
        let result = probe_proxy_origin("http://unresolved.fixture.invalid", &config, false).await.unwrap();
        assert_eq!(result["ok"], true);
        let (request, body, auth) = serving.join().unwrap();
        assert!(request.starts_with("POST http://unresolved.fixture.invalid/api/edge/request HTTP/1.1"));
        assert_eq!(body, json!({"method":"GET","path":"/api/videos?page=1&size=1","body":"","content_type":""}));
        assert!(!auth);
        assert!(crate::proxy::snapshot() == before);
    }

    #[tokio::test]
    #[ignore = "联网测试：需要 HGHUBX_TEST_MEDIA_URL 为当前有效的媒体地址"]
    async fn media_recovers_from_failed_system_dns() {
        let raw = crate::env::var("TEST_MEDIA_URL").expect("HGHUBX_TEST_MEDIA_URL");
        let target = url::Url::parse(&raw).unwrap();
        let host = target.host_str().unwrap();
        let port = target.port_or_known_default().unwrap();
        let failed_client = reqwest::Client::builder()
            .no_proxy()
            .resolve_to_addrs(host, &["127.0.0.1:9".parse().unwrap()])
            .connect_timeout(Duration::from_millis(100))
            .build()
            .unwrap();
        refresh_client();
        CLIENTS.lock().unwrap().insert(
            client_key(network_policy::strict_security(), host, port, false, &ProxyRoute::for_config(&crate::proxy::snapshot(), &target)),
            (Instant::now() + CLIENT_TTL, Arc::new(failed_client)),
        );
        let (_, bytes) = fetch_bytes(&raw).await.expect("备用 DNS 应恢复真实媒体下载");
        assert!(!bytes.is_empty());
        assert!(MEDIA_DNS_ROUTES.lock().unwrap().prefers_public(host, Instant::now()));
        let (_, again) = fetch_bytes(&raw).await.expect("后续请求应复用恢复的路径");
        if bytes.starts_with(b"#EXTM3U") {
            assert!(again.starts_with(b"#EXTM3U"));
        } else {
            assert_eq!(bytes, again);
        }
        if let Some(path) = crate::env::var("TEST_MEDIA_OUTPUT") {
            std::fs::write(path, bytes).unwrap();
        }
    }

    #[tokio::test]
    async fn terminal_errors_do_not_retry_but_transient_failures_can_recover() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for error in [
            "HTTP 404 Not Found: <html>nginx</html>",
            "HTTP 403 Forbidden",
            "401",
            "禁止访问内网",
            "重定向次数超过限制",
        ] {
            let calls = AtomicUsize::new(0);
            assert!(with_retry(true, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>(error.to_string())
            })
            .await
            .is_err());
            assert_eq!(calls.load(Ordering::SeqCst), 1, "{error}");
        }
        for error in ["HTTP 503 Service Unavailable", "请求超时"] {
            let calls = AtomicUsize::new(0);
            let value = with_retry(true, || {
                let attempt = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        Err(error.to_string())
                    } else {
                        Ok(42)
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(value, 42);
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }
    }

    #[test]
    fn api_operation_labels_exclude_user_input() {
        for (path, expected) in [
            ("/api/videos?page=1&size=10", "feed"),
            ("/api/videos/category/private?x=secret", "category"),
            ("/api/videos/42/play?ep=1", "play"),
            ("/api/search?q=private-search", "search"),
            ("/api/account/loginByPassword", "account"),
            ("/unknown/private", "other"),
        ] {
            assert_eq!(edge_operation(path), expected);
        }
    }

    #[tokio::test]
    async fn non_idempotent_operations_are_attempted_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for (retry, expected) in [(false, 1), (true, 3)] {
            let calls = AtomicUsize::new(0);
            let result = with_retry(retry, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>("rejected".to_string())
            })
            .await;
            assert!(result.is_err());
            assert_eq!(calls.load(Ordering::SeqCst), expected);
        }
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

    #[test]
    fn pinned_clients_expire_without_extending_the_dns_ttl() {
        let now = Instant::now();
        let client = Arc::new(reqwest::Client::new());
        let mut cache = ClientCache::new();
        cache.insert(
            "true:example.com:443".into(),
            (now + CLIENT_TTL, client.clone()),
        );
        assert!(Arc::ptr_eq(
            &cached_client(
                &cache,
                "true:example.com:443",
                now + Duration::from_secs(29)
            )
            .unwrap(),
            &client
        ));
        assert!(cached_client(&cache, "true:example.com:443", now + CLIENT_TTL).is_none());
        assert!(cached_client(&cache, "false:example.com:443", now).is_none());
        assert!(cached_client(&cache, "true:example.com:8443", now).is_none());
    }

    #[test]
    fn edge_redirects_only_replay_anonymous_reads() {
        let current = url::Url::parse("https://huangguoai.ai/api/edge/request").unwrap();
        assert_eq!(
            edge_redirect_target(
                &current,
                301,
                "https://huangguoai.com/api/edge/request",
                true
            )
            .unwrap()
            .host_str(),
            Some("huangguoai.com")
        );
        assert!(edge_redirect_target(&current, 302, "/next", true).is_ok());
        for status in [301, 302, 303, 307, 308] {
            assert!(edge_redirect_target(&current, status, "/next", false).is_err());
        }
        for status in [307, 308] {
            assert!(edge_redirect_target(&current, status, "/next", true).is_err());
        }
        assert!(edge_redirect_target(&current, 301, "http://example.com/", true).is_err());
        assert!(edge_redirect_target(&current, 301, "https://127.0.0.1/", true).is_err());
    }

    #[test]
    fn proxy_credentials_and_query_are_redacted() {
        assert_eq!(
            redact_proxy("http://alice:p%40ss@127.0.0.1:7897/path?token=secret#hidden"),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            redact_proxy("socks5://alice:secret@[::1]:1080"),
            "socks5://[::1]:1080"
        );
        for raw in ["alice:secret@127.0.0.1:7897", "not a url secret", ""] {
            assert_eq!(redact_proxy(raw), "[已配置，原始值已隐藏]");
        }
    }

    #[test]
    fn base_requires_https_origin_and_auth_trust_is_static() {
        assert_eq!(
            normalize_base("https://HUANGGUOAI.COM:443/"),
            Some(DEFAULT_BASE.into())
        );
        for raw in [
            "http://huangguoai.com",
            "https://user:pass@huangguoai.com",
            "https://huangguoai.com/path",
            "https://huangguoai.com/?secret=1",
            "https://huangguoai.com/#fragment",
            "https://192.168.1.1",
        ] {
            assert_eq!(normalize_base(raw), None, "{raw}");
        }
        assert!(trusted_auth_origin(DEFAULT_BASE));
        assert!(trusted_auth_origin("https://huangguoai.ai"));
        assert!(!trusted_auth_origin("https://mirror.example"));
        assert!(!trusted_auth_origin("https://huangguoai.com.evil.example"));
    }

    #[test]
    fn saved_line_is_restored_without_granting_credential_trust() {
        assert_eq!(
            persisted_base(r#"{"base":"https://legacy-mirror.invalid/"}"#),
            Some("https://legacy-mirror.invalid".into())
        );
        assert!(!trusted_auth_origin("https://legacy-mirror.invalid"));
        assert_eq!(persisted_base(r#"{"base":"https://huangguoai.com/"}"#), Some(DEFAULT_BASE.into()));
        for raw in [
            "invalid",
            r#"{"base":123}"#,
            r#"{"base":"http://example.com"}"#,
            r#"{"base":"https://localhost"}"#,
            r#"{"base":"https://192.168.1.1"}"#,
            r#"{"base":"https://example.com/path"}"#,
        ] {
            assert_eq!(persisted_base(raw), None, "{raw}");
        }
    }

    #[test]
    fn custom_line_consent_only_survives_explicit_v2_configuration() {
        for raw in [
            r#"{"base":"https://mirror.fixture.invalid","custom":true}"#,
            r#"{"v":1,"base":"https://mirror.fixture.invalid","custom":true}"#,
            r#"{"v":2,"base":"https://mirror.fixture.invalid"}"#,
            r#"{"v":2,"base":"https://mirror.fixture.invalid","custom":false}"#,
        ] {
            let config = persisted_line(raw).unwrap();
            assert_eq!(config.base, "https://mirror.fixture.invalid");
            assert!(!config.custom);
        }
        assert!(persisted_line(r#"{"v":2,"base":"https://mirror.fixture.invalid/","custom":true}"#).unwrap().custom);
        assert!(!persisted_line(r#"{"v":2,"base":"https://huangguoai.com","custom":true}"#).unwrap().custom);
    }

    #[test]
    fn custom_line_round_trip_and_failed_save_preserve_previous_selection() {
        let dir = std::env::temp_dir().join(format!("hghubx-line-save-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("line.json");
        let next = LineConfig { base: "https://mirror.fixture.invalid".into(), custom: true };
        let mut current = LineConfig::default();
        save_line(&mut current, next.clone(), Some(&path)).unwrap();
        assert_eq!(persisted_line(&std::fs::read_to_string(&path).unwrap()), Some(next.clone()));
        let failed_path = dir.join("missing").join("line.json");
        assert!(save_line(&mut current, LineConfig::default(), Some(&failed_path)).is_err());
        assert_eq!(current, next);
        assert_eq!(persisted_line(&std::fs::read_to_string(&path).unwrap()), Some(next));
        save_line(&mut current, LineConfig::default(), Some(&path)).unwrap();
        assert_eq!(persisted_line(&std::fs::read_to_string(&path).unwrap()), Some(LineConfig::default()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn untrusted_origins_reject_credentials_before_network() {
        for (path, body, token) in [
            (
                "/api/account/loginByPassword",
                Some(json!({"password":"secret"})),
                None,
            ),
            (
                "/api/account/registerByPassword",
                Some(json!({"password":"secret"})),
                None,
            ),
            ("/api/videos", None, Some("secret-token")),
        ] {
            let err = edge("https://mirror.invalid", "POST", path, body, token)
                .await
                .unwrap_err();
            assert!(err.contains("镜像线路仅供游客浏览"));
        }
    }

    #[tokio::test]
    async fn private_get_is_rejected_before_network() {
        let err = get(
            "http://127.0.0.1:1/private",
            Duration::from_secs(1),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("禁止访问"));
    }

    /// 手动跑：`cargo test --lib -- --ignored net::tests::diag -- --nocapture`
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
