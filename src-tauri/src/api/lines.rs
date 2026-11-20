//! Line (data source) commands.

use super::Api;
use crate::net::base;
use serde_json::{json, Value};
use tauri::State;

/* ───────────────────────── 线路（数据源） ───────────────────────── */
// Network probes run without holding this lock. Manual selection/cancellation
// invalidates older probes; applying a result is serialized with manual writes.
static LINE_SELECTION: std::sync::Mutex<u64> = std::sync::Mutex::new(0);

fn begin_line_selection() -> Result<u64, String> {
    let mut generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    *generation = generation.wrapping_add(1);
    Ok(*generation)
}

#[tauri::command]
pub async fn line_cancel() -> Result<(), String> {
    begin_line_selection().map(|_| ())
}

/// 当前线路 + 固定线路清单（镜像线路另外按需拉取）。
#[tauri::command]
pub async fn line_state() -> Result<Value, String> {
    Ok(json!({
        "base": base(),
        "default": crate::net::DEFAULT_BASE,
        "custom": crate::net::is_custom_line(),
        "fixed": crate::lines::fixed(),
    }))
}

/// 手动切换线路：只允许固定线路或刚从可信发布页读取的镜像。
/// 可信↔可信切换保留会话（同一账号体系）；任一端不可信则清空。
#[tauri::command]
pub async fn line_set(state: State<'_, Api>, url: String) -> Result<String, String> {
    let mut generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    *generation = generation.wrapping_add(1);
    let previous = base();
    let applied = crate::net::set_base(&url)?;
    crate::net::refresh_client();
    if previous != applied { state.session.rebase_or_clear(&applied, crate::session::rebase_trust); }
    Ok(applied)
}

#[tauri::command]
pub async fn line_custom_set(state: State<'_, Api>, url: String) -> Result<Value, String> {
    let mut generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    *generation = generation.wrapping_add(1);
    let previous = base();
    let applied = crate::net::set_custom_base(&url)?;
    crate::net::refresh_client();
    // Custom lines never join the trusted rebase: even a trusted old origin
    // must not hand its token to a user-specified site.
    let _ = previous;
    state.session.clear();
    Ok(json!({ "base": applied, "custom": crate::net::is_custom_line() }))
}

#[tauri::command]
pub async fn line_reset(state: State<'_, Api>) -> Result<Value, String> {
    let base = line_set(state, crate::net::DEFAULT_BASE.to_string()).await?;
    Ok(json!({ "base": base, "custom": false }))
}

#[tauri::command]
pub async fn proxy_state() -> Result<Value, String> {
    Ok(crate::net::proxy_state())
}

#[tauri::command]
pub async fn proxy_set(mode: String, url: String) -> Result<Value, String> {
    // Serialize with line application: probes using the previous proxy must
    // never switch the line after the new proxy has been saved.
    let mut generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    crate::proxy::set(&mode, &url)?;
    *generation = generation.wrapping_add(1);
    crate::net::refresh_client();
    let state = crate::net::proxy_state();
    crate::playback_log::record("proxy.changed", json!({
        "mode": state.get("mode"), "proxy": state.get("effective"),
    }));
    Ok(state)
}

#[tauri::command]
pub async fn proxy_test(mode: String, url: String) -> Result<Value, String> {
    Ok(crate::net::test_proxy(&mode, &url).await)
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

/// 自动选线：探测主站与可信发布页镜像，全部失败时保持当前线路。
///
/// 切换两端都可信（固定线路或本进程发布页确认的镜像）时保留会话并 rebase origin；
/// 旧 origin 不可信（如自定义线路）时清空会话，绝不把 token 带给新站点。
#[tauri::command]
pub async fn line_auto(state: State<'_, Api>) -> Result<Value, String> {
    let selection = begin_line_selection()?;
    crate::net::refresh_client();
    let pick = crate::lines::auto_pick().await;
    let chosen = pick
        .get("base")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut switched = false;
    let generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    let previous = base();
    if *generation == selection
        && pick.get("reason").and_then(Value::as_str) != Some("all-down")
        && !chosen.is_empty() && chosen != previous {
        let next = crate::net::set_base(&chosen)?;
        crate::net::refresh_client();
        switched = next != previous;
        if switched { state.session.rebase_or_clear(&next, crate::session::rebase_trust); }
    }
    Ok(json!({
        "previous": previous,
        "base": crate::net::base(),
        "switched": switched,
        "cancelled": *generation != selection,
        "pick": pick,
    }))
}

/// 当前走的是镜像时，敲一次主站：通了就切回（可信会话保留并 rebase 到主站）。
///
/// 和 [`line_auto`] 的分工：[`line_auto`] 是「整体比一次」，要抓发布页；
/// 这个只问一句「主站现在通不通」，代价一个请求，可以频繁调用。
#[tauri::command]
pub async fn line_try_main(state: State<'_, Api>) -> Result<Value, String> {
    let selection = begin_line_selection()?;
    crate::net::refresh_client();
    let probe = crate::lines::try_main().await;
    let mut switched = false;
    let generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    let previous = base();
    if *generation == selection && probe.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let chosen = probe.get("base").and_then(Value::as_str).unwrap_or_default();
        if !chosen.is_empty() && chosen != previous {
            let next = crate::net::set_base(chosen)?;
            crate::net::refresh_client();
            switched = next != previous;
            if switched { state.session.rebase_or_clear(&next, crate::session::rebase_trust); }
        }
    }
    Ok(json!({
        "previous": previous,
        "base": crate::net::base(),
        "switched": switched,
        "probe": probe,
        "cancelled": *generation != selection,
    }))
}

/// 线路体检：探一次 `/api/videos`，和自动选线用同一个判据。
#[tauri::command]
pub async fn line_health() -> Result<Value, String> {
    Ok(crate::lines::health().await)
}
