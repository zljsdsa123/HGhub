//! 网络层：与上游站点对话。
//!
//! 站点把全部 `/api/**` 调用收敛成 `POST /api/edge/request` 的信封，
//! 我们只实现这一个入口，其余接口都是「填 path」。
//!
//! # 代理（用户反馈「浏览器能开、HGhubX 打不开」的根因就在这里）
//!
//! 客户端的流量**全部**走本模块的 reqwest，跟 WebView2 无关，所以它既不共享
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

mod client;
mod edge;
mod line;
mod proxy_env;
mod redact;

use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// 默认上游（固定线路 1）。
pub const DEFAULT_BASE: &str = "https://huangguoai.com";

/// 当前上游基址（不带结尾斜杠）。可在设置里切到可信镜像或自定义线路，运行时立即生效。
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

static CLIENT_GENERATION: AtomicU64 = AtomicU64::new(0);
// Rebuilding HTTP clients for a probe does not change the media transport.
// Only a different effective configuration invalidates completed media caches.
static MEDIA_CONFIG_GENERATION: AtomicU64 = AtomicU64::new(0);
static MEDIA_CONFIG_FINGERPRINT: Lazy<Mutex<Option<u64>>> = Lazy::new(|| Mutex::new(None));
const CLIENT_TTL: Duration = Duration::from_secs(30);
type ClientCache = HashMap<String, (Instant, Arc<reqwest::Client>)>;
static CLIENTS: Lazy<Mutex<ClientCache>> = Lazy::new(|| Mutex::new(HashMap::new()));
static MEDIA_DNS_ROUTES: Lazy<Mutex<crate::media_dns::Routes>> =
    Lazy::new(|| Mutex::new(crate::media_dns::Routes::default()));
static LAST_HEAL: Lazy<Mutex<Option<Instant>>> = Lazy::new(|| Mutex::new(None));
static NEXT_EDGE: AtomicU64 = AtomicU64::new(0);
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(0);

#[allow(unused_imports)]
pub use client::{get, refresh_client, UA};
pub(crate) use client::{build_client, proxy_active, request_scope, ProxyRoute, RequestScope};
pub use crate::net_diag::{diagnose, proxy_state, test_proxy};
pub use edge::{edge, fetch_bytes, fetch_bytes_with_url};
pub(crate) use edge::edge_redirect_target;
pub use line::{
    base, bind_base, is_custom_line, normalize_base, set_base, set_custom_base,
    trusted_auth_origin,
};
pub(crate) use proxy_env::{env_proxy_set, gnome_proxy, proxy_override, system_proxy_enabled};
#[allow(unused_imports)]
pub use redact::{err_text, heal_client, is_proxy_error, redact_error_proxy_auth, redact_proxy};

#[cfg(test)]
use client::{cached_client, client_key, media_config_fingerprint, update_media_generation};
#[cfg(test)]
use edge::{edge_operation, with_retry};
#[cfg(test)]
use line::{persisted_base, persisted_line, save_line};

#[cfg(test)]
mod tests;
