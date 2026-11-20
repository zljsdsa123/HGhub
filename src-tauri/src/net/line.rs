use super::client::refresh_media_scope;
use super::{LineConfig, BASE, BASE_FILE, DEFAULT_BASE};
use crate::network_policy;
use serde_json::{json, Value};

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

/// 哪些 origin 允许携带凭据：固定主站，加上发布页推荐过、且当前可能作为线路的镜像。
///
/// 国内网络连不上 `.com`，只能用镜像；镜像和主站是同一后端、同一个账号体系。
/// huangguoai.ai 只是导航站（API 全 404），不是固定线路，也不授予凭据信任。
/// 自定义线路必须由用户显式保存；旧格式文件只恢复地址，不自动授予登录权限。
/// 会话仍绑定 origin；只有可信↔可信切换会经 SessionStore::rebase_if_trusted 改写 origin，
/// 其余切换不会把已有 token 发送给另一个站点。
pub fn trusted_auth_origin(origin: &str) -> bool {
    matches!(origin, "https://huangguoai.com")
        || crate::lines::is_trusted_mirror(origin)
        || BASE.read().is_ok_and(|line| line.custom && line.base == origin)
}

pub(super) fn persisted_base(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    normalize_base(value.get("base")?.as_str()?)
}

pub(super) fn persisted_line(text: &str) -> Option<LineConfig> {
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

pub(super) fn save_line(current: &mut LineConfig, next: LineConfig, path: Option<&std::path::Path>) -> Result<(), String> {
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
