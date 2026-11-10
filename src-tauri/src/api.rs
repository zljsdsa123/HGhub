//! 业务命令：登录 / 列表 / 详情 / 播放 / 互动。

use crate::net::{base, edge};
use crate::session::SessionStore;
use serde_json::{json, Value};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

pub struct Api {
    pub session: SessionStore,
}

impl Api {
    pub fn new() -> Self {
        Self {
            session: SessionStore::new(),
        }
    }

    /// POST 信封：新播放接口 /api/videos/{id}/episodes/{ep}/playback 需要。
    async fn post(&self, path: &str, body: Option<Value>) -> Result<Value, String> {
        let origin = base();
        let token = self.session.token(&origin);
        edge(&origin, "POST", path, body, token.as_deref()).await
    }

    async fn get(&self, path: &str) -> Result<Value, String> {
        let origin = base();
        let token = self.session.token(&origin);
        edge(&origin, "GET", path, None, token.as_deref()).await
    }

    async fn authed(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let origin = base();
        let token = self
            .session
            .token(&origin)
            .ok_or_else(|| "请先登录".to_string())?;
        edge(&origin, method, path, body, Some(&token)).await
    }
}

/// API/运行错误与自检统一写入 debug.log，每行附 RFC 3339 UTC 时间和进程编号。
#[tauri::command]
pub async fn debug_log(app: tauri::AppHandle, msg: String) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::logging::append_debug(&dir, &msg)
}

/// 网络自检：系统代理 / DNS / 连通性快照，用于远程定位「打不开」。
#[tauri::command]
pub async fn net_diag() -> Result<Value, String> {
    Ok(crate::net::diagnose().await)
}

/* ───────────────────────── 线路（数据源） ───────────────────────── */

/// 当前线路 + 固定线路清单（镜像线路另外按需拉取）。
#[tauri::command]
pub async fn line_state() -> Result<Value, String> {
    Ok(json!({
        "base": base(),
        "default": crate::net::DEFAULT_BASE,
        "fixed": crate::lines::fixed(),
    }))
}

/// 手动切换线路：立即生效并落盘（下次启动沿用）。
#[tauri::command]
pub async fn line_set(state: State<'_, Api>, url: String) -> Result<String, String> {
    let previous = base();
    let next = crate::net::set_base(&url)?;
    if previous != next {
        state.session.clear();
    }
    Ok(next)
}

/// 从地址发布页抓镜像线路（只在用户点开「线路」时调用）。
#[tauri::command]
pub async fn line_mirrors() -> Result<Value, String> {
    // 用户手动点「刷新 / 打开线路」时重新读一次系统代理：代理软件开关过之后旧客户端会卡死
    crate::net::refresh_client();
    crate::lines::mirrors().await
}

/// 可达性探测：只报结果，不做自动检查 / 自动切换。
#[tauri::command]
pub async fn line_probe(urls: Vec<String>) -> Result<Value, String> {
    crate::net::refresh_client();
    Ok(crate::lines::probe(urls).await)
}

/// 自动选线：`.com` 与 `.ai` 各探一次，选通的那条、快的那条。
///
/// 和 [`line_set`] 的区别是**不清会话**：两个域名是同一个站点，登录态本来就通用；
/// 自动切换如果清会话，用户每换一次网络就被踢下线，那是不能接受的。
#[tauri::command]
pub async fn line_auto() -> Result<Value, String> {
    crate::net::refresh_client();
    let pick = crate::lines::auto_pick().await;
    let chosen = pick
        .get("base")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let previous = base();
    let mut switched = false;
    if !chosen.is_empty() && chosen != previous {
        let next = crate::net::set_base(&chosen)?;
        switched = next != previous;
    }
    Ok(json!({
        "previous": previous,
        "base": crate::net::base(),
        "switched": switched,
        "pick": pick,
    }))
}

/// 当前走的是镜像时，敲一次主站：通了就切回（不清会话）。
///
/// 和 [`line_auto`] 的分工：[`line_auto`] 是「整体比一次」，要抓发布页；
/// 这个只问一句「主站现在通不通」，代价一个请求，可以频繁调用。
#[tauri::command]
pub async fn line_try_main() -> Result<Value, String> {
    crate::net::refresh_client();
    let probe = crate::lines::try_main().await;
    let previous = base();
    let mut switched = false;
    if probe.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let chosen = probe.get("base").and_then(Value::as_str).unwrap_or_default();
        if !chosen.is_empty() && chosen != previous {
            let next = crate::net::set_base(chosen)?;
            switched = next != previous;
        }
    }
    Ok(json!({
        "previous": previous,
        "base": crate::net::base(),
        "switched": switched,
        "probe": probe,
    }))
}

/* ───────────────────────── 更新检查 ───────────────────────── */

const REPO: &str = "zxsos/HGhub";

fn ver_parts(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(['.', '-', '+'])
        .map(|s| s.trim().parse::<u64>().unwrap_or(0))
        .collect()
}

/// 只比较数字段：`v1.2.0` > `1.1.9`；解析不出的段按 0 处理。
fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (ver_parts(latest), ver_parts(current));
    for i in 0..a.len().max(b.len()) {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// 从 tag / name 里取出 `x.y.z`。
///
/// 我们的 tag 是 `hgfix-1.2.1-r5`，上游是 `v1.2.0`，release name 是 `HGhub 1.2.1+hg.1`。
/// 直接拿去比会从第一位就判负（`hgfix-1` 解析成 0），所以先抠出版本号。
fn version_in(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        let mut dots = 0;
        let mut j = i;
        while j < chars.len() && (chars[j].is_ascii_digit() || (chars[j] == '.' && dots < 2)) {
            if chars[j] == '.' {
                dots += 1;
            }
            j += 1;
        }
        if dots == 2 {
            return chars[start..j].iter().collect();
        }
        i = j.max(i + 1);
    }
    String::new()
}

/// 线路体检：探一次 `/api/videos`，和自动选线用同一个判据。
#[tauri::command]
pub async fn line_health() -> Result<Value, String> {
    Ok(crate::lines::health().await)
}
/// 对比 GitHub Release 的 tag 与当前版本（未认证 60 次/小时/IP，够用）。
#[tauri::command]
pub async fn check_update() -> Result<Value, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = crate::net::get(
        &url,
        std::time::Duration::from_secs(12),
        Some("application/vnd.github+json"),
        None,
    )
    .await?;

    let status = resp.status();
    if status.as_u16() == 404 {
        // 还没发过 release
        return Ok(json!({
            "current": current, "latest": "", "has_update": false,
            "url": format!("https://github.com/{REPO}/releases"),
        }));
    }
    if !status.is_success() {
        return Err(format!("GitHub 返回 HTTP {status}"));
    }

    let v: Value = resp.json().await.map_err(|e| crate::net::err_text(&e))?;
    let tag = v
        .get("tag_name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let html = v
        .get("html_url")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("https://github.com/{REPO}/releases"));
    let notes = v.get("body").and_then(|x| x.as_str()).unwrap_or("");
    // tag 是 `hgfix-1.2.1-r5`，不能直接拿整串比大小
    let latest = {
        let found = version_in(&tag);
        if found.is_empty() {
            tag.trim_start_matches(['v', 'V']).to_string()
        } else {
            found
        }
    };

    // 顺手把「这个平台该下哪个包」挑出来，前端好直接应用内更新
    let assets = v.get("assets").and_then(Value::as_array).cloned().unwrap_or_default();
    let asset = assets
        .iter()
        .filter_map(|a| {
            let name = a.get("name").and_then(Value::as_str)?;
            let url = a.get("browser_download_url").and_then(Value::as_str)?;
            Some((name.to_string(), url.to_string()))
        })
        .filter(|(n, _)| asset_rank(n) > 0)
        .max_by_key(|(n, _)| asset_rank(n));
    Ok(json!({
        "current": current,
        "latest": latest,
        "tag": tag,
        "has_update": !latest.is_empty() && is_newer(&latest, &current),
        "asset": asset.map(|(name, url)| json!({ "name": name, "url": url })),
        "url": html,
        "name": v.get("name").and_then(|x| x.as_str()).unwrap_or(""),
        "published_at": v.get("published_at").and_then(|x| x.as_str()).unwrap_or(""),
        "notes": notes.chars().take(800).collect::<String>(),
    }))
}

/// 用系统默认浏览器打开链接（只允许 http/https）。
/// 这个平台该更新哪个包，数字越大越优先。
///
/// 安卓的 release 里同时有 arm64 / arm(v7) / x86_64 三个 apk，光看「是不是 apk」
/// 会先撞上 armv7 那个，64 位机器就降到 32 位跑了。所以按架构给分，取最高。
fn asset_rank(name: &str) -> u8 {
    let n = name.to_ascii_lowercase();
    if cfg!(target_os = "android") {
        if !n.ends_with(".apk") {
            0
        } else if cfg!(target_arch = "aarch64") {
            if n.contains("arm64") || n.contains("aarch64") {
                3
            } else {
                1
            }
        } else if cfg!(target_arch = "x86_64") {
            if n.contains("x86_64") {
                3
            } else {
                1
            }
        } else if n.contains("x86") || n.contains("arm64") {
            1
        } else {
            2
        }
    } else if cfg!(target_os = "windows") {
        if n.ends_with(".exe") { 3 } else { 0 }
    } else if cfg!(target_os = "macos") {
        if n.ends_with(".dmg") { 3 } else { 0 }
    } else if n.ends_with(".deb") {
        3
    } else if n.ends_with(".appimage") {
        2
    } else {
        0
    }
}

/// GitHub 下载加速：国内直连 release 资产基本拉不动，逐个试。
const UPDATE_PROXIES: [&str; 3] = [
    "https://ghfast.top",
    "https://gh-proxy.com",
    "https://ghproxy.net",
];

async fn fetch_update_bytes(url: &str) -> Result<Vec<u8>, String> {
    let resp = crate::net::get(
        url,
        std::time::Duration::from_secs(180),
        Some("application/octet-stream"),
        None,
    )
    .await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| crate::net::err_text(&e))?;
    Ok(bytes.to_vec())
}

/// 应用内更新第一步：把安装包拉到本机缓存。
///
/// 顺序是「直连 → 三个加速源」，谁先成用谁；拉回来太小的当失败（加速源
/// 常常 200 回来一段 HTML 错误页，不能写进文件当 apk）。
#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    url: String,
    name: String,
) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | '+') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let target = dir.join(if safe.is_empty() { "update.bin".into() } else { safe });

    let mut tried: Vec<String> = vec![url.clone()];
    for proxy in UPDATE_PROXIES {
        tried.push(format!("{proxy}/{url}"));
    }
    let mut last = String::from("未知错误");
    for u in tried {
        let proxied = u != url;
        match fetch_update_bytes(&u).await {
            Ok(bytes) if bytes.len() > 512 * 1024 => {
                std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
                crate::playback_log::record(
                    "update.downloaded",
                    json!({ "bytes": bytes.len(), "via_proxy": proxied }),
                );
                return Ok(target.to_string_lossy().to_string());
            }
            Ok(bytes) => last = format!("{} 只回来 {} 字节", if proxied { "加速源" } else { "直连" }, bytes.len()),
            Err(e) => last = format!("{}: {e}", if proxied { "加速源" } else { "直连" }),
        }
    }
    Err(format!(
        "下载失败（直连和 {} 个加速源都没成）：{last}",
        UPDATE_PROXIES.len()
    ))
}

/// 应用内更新第二步：把安装包交给系统。
///
/// 安卓走 FileProvider + ACTION_VIEW，系统弹安装器（首次会问「允许来自此来源」）；
/// 桌面直接把文件丢给默认程序。
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err("安装包不见了，重新下载一次".to_string());
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("调不起安装器：{e}"))
}

#[tauri::command]
pub async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let target = crate::network_policy::parse_target(&url)?;
    // 固定使用默认处理器；不向前端暴露可指定程序的 opener 命令。
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

/* ───────────────────────── 会话 ───────────────────────── */

#[tauri::command]
pub async fn app_boot(state: State<'_, Api>) -> Result<Value, String> {
    let origin = base();
    Ok(json!({
        "user": state.session.user(&origin),
        "logged_in": state.session.token(&origin).is_some(),
        "base": origin,
        "strict_security": crate::network_policy::strict_security(),
        "cli_relaxed": crate::network_policy::cli_strict_override() == Some(false),
    }))
}

/// 切换严格安全模式（关闭后回退到兼容清洗与网络守卫模式，立即生效并落盘）。
#[tauri::command]
pub async fn security_set(strict: bool) -> Result<bool, String> {
    crate::network_policy::set_strict_security(strict)?;
    crate::net::refresh_client();
    crate::playback_log::record(
        "security.mode_changed",
        json!({"strict": crate::network_policy::strict_security()}),
    );
    Ok(crate::network_policy::strict_security())
}

#[tauri::command]
pub async fn api_login(
    state: State<'_, Api>,
    username: String,
    password: String,
) -> Result<Value, String> {
    let origin = base();
    let data = edge(
        &origin,
        "POST",
        "/api/account/loginByPassword",
        Some(json!({ "username": username, "password": password })),
        None,
    )
    .await?;
    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "登录返回缺少 token".to_string())?
        .to_string();
    let user = data.get("user").cloned().unwrap_or(Value::Null);
    if base() != origin {
        return Err("登录期间线路已变化，请重新登录".into());
    }
    state.session.set(&origin, token, user.clone());
    Ok(json!({ "user": user }))
}

#[tauri::command]
pub async fn api_register(
    state: State<'_, Api>,
    username: String,
    password: String,
    email: String,
) -> Result<Value, String> {
    let origin = base();
    let mut body = json!({
        "username": username,
        "password": password,
        "confirm_password": password,
    });
    if !email.trim().is_empty() {
        body["email"] = json!(email);
    }
    let data = edge(
        &origin,
        "POST",
        "/api/account/registerByPassword",
        Some(body),
        None,
    )
    .await?;
    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "注册返回缺少 token".to_string())?
        .to_string();
    let user = data.get("user").cloned().unwrap_or(Value::Null);
    if base() != origin {
        return Err("注册期间线路已变化，请重新登录".into());
    }
    state.session.set(&origin, token, user.clone());
    Ok(json!({ "user": user }))
}

#[tauri::command]
pub async fn api_logout(state: State<'_, Api>) -> Result<Value, String> {
    let origin = base();
    let token = state.session.token(&origin);
    let _ = edge(
        &origin,
        "POST",
        "/api/account/logout",
        None,
        token.as_deref(),
    )
    .await;
    state.session.clear();
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn api_me(state: State<'_, Api>) -> Result<Value, String> {
    let origin = base();
    let token = state.session.token(&origin);
    let me = edge(&origin, "GET", "/api/account/me", None, token.as_deref()).await?;
    if base() != origin {
        return Err("读取账号期间线路已变化".into());
    }
    if let Some(token) = state.session.token(&origin) {
        state.session.set(&origin, token, me.clone());
    }
    Ok(me)
}

/* ───────────────────────── 列表 ───────────────────────── */

#[tauri::command]
pub async fn api_feed(state: State<'_, Api>, page: u32, size: u32) -> Result<Value, String> {
    state
        .get(&format!("/api/videos?page={page}&size={size}"))
        .await
}

#[tauri::command]
pub async fn api_category(
    state: State<'_, Api>,
    cate: String,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .get(&format!(
            "/api/videos/category/{cate}?page={page}&size={size}"
        ))
        .await
}

#[tauri::command]
pub async fn api_rank(state: State<'_, Api>, kind: String) -> Result<Value, String> {
    let kind = match kind.as_str() {
        "recommend" | "potential" => kind,
        _ => "hot".to_string(),
    };
    state.get(&format!("/api/ranks/{kind}")).await
}

#[tauri::command]
pub async fn api_search(
    state: State<'_, Api>,
    q: String,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(q.as_bytes()).collect();
    state
        .get(&format!("/api/search?q={encoded}&page={page}&size={size}"))
        .await
}

#[tauri::command]
pub async fn api_posts(state: State<'_, Api>, page: u32, size: u32) -> Result<Value, String> {
    state
        .get(&format!("/api/posts?page={page}&size={size}"))
        .await
}

#[tauri::command]
pub async fn api_post(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/posts/{id}")).await
}

/* ───────────────────────── 详情 / 播放 ───────────────────────── */

#[tauri::command]
pub async fn api_video(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/videos/{id}")).await
}

#[tauri::command]
pub async fn api_play(state: State<'_, Api>, id: i64, ep: u32) -> Result<Value, String> {
    state
        .post(
            &format!("/api/videos/{id}/episodes/{ep}/playback"),
            Some(json!({})),
        )
        .await
}

/* ───────────────────────── 评论 / 互动 ───────────────────────── */

#[tauri::command]
pub async fn api_comments(
    state: State<'_, Api>,
    id: i64,
    ep: u32,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .get(&format!(
            "/api/videos/{id}/comments?ep={ep}&page={page}&size={size}"
        ))
        .await
}

#[tauri::command]
pub async fn api_comment_send(
    state: State<'_, Api>,
    id: i64,
    ep: u32,
    text: String,
    reply_id: Option<i64>,
) -> Result<Value, String> {
    let mut body = json!({ "text": text });
    let path = match reply_id {
        Some(rid) if rid > 0 => {
            body["reply_id"] = json!(rid);
            format!("/api/videos/{id}/comments")
        }
        _ => format!("/api/videos/{id}/comments?ep={ep}"),
    };
    state.authed("POST", &path, Some(body)).await
}

#[tauri::command]
pub async fn api_like(state: State<'_, Api>, id: i64, ep: u32, on: bool) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .authed(method, &format!("/api/videos/{id}/like?ep={ep}"), None)
        .await
}

#[tauri::command]
pub async fn api_collect(state: State<'_, Api>, id: i64, on: bool) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .authed(method, &format!("/api/videos/{id}/collect"), None)
        .await
}

#[tauri::command]
pub async fn api_follow(state: State<'_, Api>, uid: i64, on: bool) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .authed(method, &format!("/api/users/{uid}/follow"), None)
        .await
}

/* ───────────────────────── 本地缓存 ───────────────────────── */

#[tauri::command]
pub async fn cache_clear() -> Result<(), String> {
    crate::media::clear_caches();
    Ok(())
}

/* ───────────────────────── 吃瓜帖子互动 ───────────────────────── */

#[tauri::command]
pub async fn api_post_like(state: State<'_, Api>, id: i64, on: bool) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .authed(method, &format!("/api/posts/{id}/like"), None)
        .await
}

#[tauri::command]
pub async fn api_post_collect(state: State<'_, Api>, id: i64, on: bool) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .authed(method, &format!("/api/posts/{id}/collect"), None)
        .await
}

#[tauri::command]
pub async fn api_post_comments(
    state: State<'_, Api>,
    id: i64,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .get(&format!("/api/posts/{id}/comments?page={page}&size={size}"))
        .await
}
#[cfg(test)]
mod tests {
    use super::{is_newer, version_in};
    use serde_json::Value;

    #[test]
    fn frontend_cannot_bypass_url_policy_with_opener_commands() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        for permission in capability["permissions"].as_array().unwrap() {
            let name = permission
                .as_str()
                .or_else(|| permission["identifier"].as_str())
                .unwrap();
            assert!(
                !name.starts_with("opener:"),
                "frontend opener command exposed: {name}"
            );
        }
    }

    #[test]
    fn external_links_are_urls_not_shell_commands() {
        for raw in [
            "https://example.com/|calc.exe",
            "https://example.com/?a=1&b=2",
            "https://example.com/%25PATH%25",
            "https://example.com/%VAR%",
        ] {
            assert!(crate::network_policy::parse_target(raw).is_ok());
        }
        for raw in [
            "file:///etc/passwd",
            "mailto:user@example.com",
            "tel:123",
            "data:text/html,test",
            "javascript:alert(1)",
            "https://example.com/\0cmd",
            "https://user:password@example.com/",
        ] {
            assert!(crate::network_policy::parse_target(raw).is_err());
        }
    }

    #[test]
    fn compares_versions() {
        assert!(is_newer("v1.0.2", "1.0.1"));
        assert!(is_newer("v1.1", "1.0.9"));
        assert!(is_newer("1.0.10", "1.0.9"));
        assert!(!is_newer("v1.0.1", "1.0.1"));
        assert!(!is_newer("v0.9.9", "1.0.1"));
        assert!(!is_newer("", "1.0.1"));
    }
    /// tag 不是纯版本号：`hgfix-1.2.1-r5` 整串拿去比会从第一位判负（`hgfix-1` 解析成 0），
    /// 结果就是「永远没有新版本」。所以先抠出 `x.y.z` 再比。
    #[test]
    fn reads_version_out_of_tag() {
        assert_eq!(version_in("hgfix-1.2.1-r5"), "1.2.1");
        assert_eq!(version_in("v1.2.0"), "1.2.0");
        assert_eq!(version_in("HGhub 1.2.1+hg.1"), "1.2.1");
        assert_eq!(version_in("release-notes"), "");
        assert!(is_newer(&version_in("hgfix-1.2.2-r6"), "1.2.1+hg.1"));
        assert!(is_newer(&version_in("hgfix-1.10.0-r9"), "1.9.9+hg.1"));
        assert!(!is_newer(&version_in("hgfix-1.2.1-r5"), "1.2.1+hg.1"));
    }
}
