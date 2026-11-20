//! Process commands: logging, diagnostics, orientation, boot, security, cache.

use super::Api;
use crate::net::base;
use serde_json::{json, Value};
use tauri::State;

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

/// 切换移动端屏幕方向（iOS 原生旋转：横屏 Landscape / 竖屏 Portrait）。
#[tauri::command]
pub async fn set_orientation(app: tauri::AppHandle, landscape: bool) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let _ = app.run_on_main_thread(move || {
            crate::ios_layout::request_orientation(landscape);
        });
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (&app, landscape);
    }
    Ok(())
}

/// iOS 专用：切换 WKWebView 文本交互。
/// 主界面默认关闭以消除长按快进时的系统放大镜；输入框聚焦时前端调用此命令重新打开，
/// 失焦后再关闭，避免影响搜索/评论/登录等文本输入。
#[tauri::command]
pub fn set_text_interaction(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            crate::ios_layout::set_text_interaction_on_webview(window.as_ref(), enabled);
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (&app, enabled);
    }
    Ok(())
}

/* ───────────────────────── 会话 ───────────────────────── */

#[tauri::command]
pub async fn app_boot(state: State<'_, Api>) -> Result<Value, String> {
    let origin = base();
    if crate::network_policy::strict_security() {
        state.session.reconcile_on_boot(&origin).await;
    }
    let origin = base();
    let credentials_allowed = crate::session::boot_credentials_visible(
        crate::network_policy::strict_security(),
        crate::net::trusted_auth_origin(&origin),
        state.session.token(&origin).is_some(),
    );
    Ok(json!({
        "user": if credentials_allowed { state.session.user(&origin) } else { Value::Null },
        "logged_in": credentials_allowed && state.session.token(&origin).is_some(),
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

/* ───────────────────────── 本地缓存 ───────────────────────── */

#[tauri::command]
pub async fn cache_clear(
    webview: tauri::Webview,
) -> Result<crate::cache::CacheClearReport, String> {
    crate::media::clear_caches();
    crate::cache::clear_web_cache(&webview).await
}
