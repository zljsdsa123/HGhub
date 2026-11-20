//! Account: login, registration, logout, profile and watch history.

use super::Api;
use crate::net::{base, edge};
use serde_json::{json, Value};
use tauri::State;

/// Older mirrors wrap `user`; current account/me returns the User directly.
fn normalize_account(value: Value, origin: &str) -> Result<Value, String> {
    let source = value.get("user").filter(|v| v.is_object()).unwrap_or(&value);
    let mut user = json!({});
    // Only profile fields cross IPC; a legacy direct login response can also contain a token.
    for key in ["id", "username", "nickname", "avatar", "avatar_color", "sign", "desc", "user_type", "counts", "interactions"] {
        if let Some(field) = source.get(key) { user[key] = field.clone(); }
    }
    if !user.get("id").and_then(Value::as_i64).is_some_and(|id| id > 0) {
        return Err("账号资料响应无效，请重新登录".into());
    }
    let interactions = value.get("interactions").or_else(|| user.get("interactions")).cloned();
    if let Some(ref interactions) = interactions { user["interactions"] = interactions.clone(); }
    let mut result = json!({"user": user, "origin": origin});
    if let Some(interactions) = interactions { result["interactions"] = interactions; }
    Ok(result)
}

fn normalize_account_history(value: Value) -> Result<Value, String> {
    let items = value.get("items").and_then(Value::as_array).ok_or("观看历史响应无效")?;
    let pagination = value.get("pagination").filter(|v| v.is_object()).ok_or("观看历史分页信息无效")?;
    let items: Vec<Value> = items.iter().filter_map(|item| {
        if item.get("target_type").and_then(Value::as_str) != Some("video") { return None; }
        let id = item.get("id")?.as_i64()?;
        let video_id = item.get("video_id")?.as_i64()?;
        if id <= 0 || video_id <= 0 { return None; }
        Some(json!({"id": id, "video_id": video_id, "target_type": "video",
            "last_ep": item.get("last_ep").and_then(Value::as_u64).unwrap_or(1).max(1),
            "updated_at": item.get("updated_at").and_then(Value::as_str).unwrap_or("")}))
    }).collect();
    for field in ["page", "pages", "size", "total"] {
        if pagination.get(field).and_then(Value::as_u64).is_none() { return Err("观看历史分页信息无效".into()); }
    }
    Ok(json!({"items": items, "pagination": pagination}))
}

#[tauri::command]
pub async fn api_login(
    state: State<'_, Api>,
    username: String,
    password: String,
    expected_user_id: Option<i64>,
    expected_origin: Option<String>,
    credential_origin: Option<String>,
) -> Result<Value, String> {
    // Manual login has no expected identity. Automatic login must still belong
    // to the initiating session and may only cross verified shared-account lines.
    let (origin, revision) = match (expected_user_id, expected_origin.as_deref(), credential_origin.as_deref()) {
        (None, None, None) => (base(), state.session.revision()),
        (Some(id), Some(expected), Some(saved)) => {
            let session = state.account_session(Some(id), Some(expected))?;
            if saved != expected && !(crate::session::rebase_trust(saved) && crate::session::rebase_trust(expected)) {
                return Err("登录信息不适用于当前线路，请手动重新登录".into());
            }
            (session.origin, session.revision)
        }
        _ => return Err("自动重新登录缺少账号或线路信息".into()),
    };
    let data = edge(
        &origin,
        "POST",
        "/api/account/loginByPassword",
        Some(json!({ "username": username, "password": password })),
        None,
    )
    .await?;
    if base() != origin {
        return Err("登录期间线路已变化，请重新登录".into());
    }
    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "登录返回缺少 token".to_string())?
        .to_string();
    let account = normalize_account(data, &origin)?;
    state.session.commit_login(revision, &origin, expected_user_id, token, account["user"].clone())?;
    Ok(account)
}

#[tauri::command]
pub async fn api_register(
    state: State<'_, Api>,
    username: String,
    password: String,
    email: String,
) -> Result<Value, String> {
    let origin = base();
    let revision = state.session.revision();
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
    let account = normalize_account(data, &origin)?;
    let user = account["user"].clone();
    if base() != origin {
        return Err("注册期间线路已变化，请重新登录".into());
    }
    if !state.session.set_if_revision(revision, &origin, token, user) {
        return Err("注册期间账号状态已变化，请重试".into());
    }
    Ok(account)
}

#[tauri::command]
pub async fn api_logout(state: State<'_, Api>, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let session = state.account_session(expected_user_id, expected_origin.as_deref())?;
    let _ = edge(
        &session.origin,
        "POST",
        "/api/account/logout",
        None,
        Some(&session.token),
    )
    .await;
    if !state.session.clear_if_current(&session) {
        return Err("账号已变化，请重试".into());
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn api_me(state: State<'_, Api>, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let session = state.account_session(expected_user_id, expected_origin.as_deref())?;
    let me = edge(&session.origin, "GET", "/api/account/me", None, Some(&session.token)).await?;
    let account = normalize_account(me, &session.origin)?;
    if base() != session.origin {
        return Err("读取账号期间线路已变化".into());
    }
    if !state.session.update_user_if_current(&session, account["user"].clone()) {
        return Err("读取账号期间登录状态已变化".into());
    }
    Ok(account)
}

#[tauri::command]
pub async fn api_account_history(state: State<'_, Api>, expected_user_id: i64, expected_origin: String, page: u32, size: u32) -> Result<Value, String> {
    let page = page.max(1);
    let size = size.clamp(1, 100);
    let value = state.account_request("GET", &format!("/api/users/me/history?page={page}&size={size}"), None,
        Some(expected_user_id), Some(&expected_origin)).await?;
    normalize_account_history(value)
}

#[tauri::command]
pub async fn api_account_history_record(state: State<'_, Api>, expected_user_id: i64, expected_origin: String, video_id: i64, ep: u32) -> Result<Value, String> {
    if video_id <= 0 || ep == 0 { return Err("观看记录参数无效".into()); }
    state.account_request("POST", "/api/users/me/history", Some(json!({"video_id": video_id, "ep": ep})),
        Some(expected_user_id), Some(&expected_origin)).await
}

#[tauri::command]
pub async fn api_account_history_delete(state: State<'_, Api>, expected_user_id: i64, expected_origin: String, ids: Vec<i64>) -> Result<Value, String> {
    if ids.is_empty() || ids.len() > 200 || ids.iter().any(|id| *id <= 0) { return Err("观看记录参数无效".into()); }
    state.account_request("POST", "/api/users/me/history/delete", Some(json!({"ids": ids})),
        Some(expected_user_id), Some(&expected_origin)).await
}

#[cfg(test)]
mod tests {
    use super::{normalize_account, normalize_account_history};
    use serde_json::json;

    #[test]
    fn account_snapshot_accepts_direct_and_wrapped_profiles_without_credentials() {
        for value in [json!({"id": 7, "nickname": "fixture", "token": "not-for-ipc", "interactions": {"favorite_video_ids": [9]}}),
            json!({"user": {"id": 7, "nickname": "fixture"}, "token": "not-for-ipc", "interactions": {"favorite_video_ids": [9]}})] {
            let result = normalize_account(value, "https://example.com").unwrap();
            assert_eq!(result["user"]["id"], 7);
            assert_eq!(result["interactions"]["favorite_video_ids"], json!([9]));
            assert_eq!(result["origin"], "https://example.com");
            assert!(result.get("token").is_none());
            assert!(result["user"].get("token").is_none());
        }
        assert!(normalize_account(json!({"user": {"nickname": "invalid"}}), "https://example.com").is_err());
        assert!(normalize_account(json!({"id": 0}), "https://example.com").is_err());
    }

    #[test]
    fn account_history_preserves_row_identity_and_pagination_without_media_metadata() {
        let result = normalize_account_history(json!({"items": [
            {"id": 18, "video_id": 9, "last_ep": 3, "target_type": "video", "updated_at": "2026-11-15 10:00:00", "title": "fixture", "cover": "unused"},
            {"id": 19, "video_id": 10, "last_ep": 1, "target_type": "post"},
            {"id": 20, "last_ep": 1, "target_type": "video"}
        ], "pagination": {"page": 2, "pages": 3, "size": 2, "total": 5}})).unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert_eq!(result["items"][0]["id"], 18);
        assert_eq!(result["items"][0]["video_id"], 9);
        assert_eq!(result["items"][0]["last_ep"], 3);
        assert!(result["items"][0].get("cover").is_none());
        assert!(result["items"][0].get("title").is_none());
        assert_eq!(result["pagination"]["pages"], 3);
        assert!(normalize_account_history(json!({"items": []})).is_err());
    }
}
