//! Like, favorite and follow commands for videos and posts.

use super::Api;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn api_like(state: State<'_, Api>, id: i64, ep: u32, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/videos/{id}/like?ep={ep}"), None, expected_user_id, expected_origin.as_deref())
        .await
}

#[tauri::command]
pub async fn api_collect(state: State<'_, Api>, id: i64, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/videos/{id}/collect"), None, expected_user_id, expected_origin.as_deref())
        .await
}

#[tauri::command]
pub async fn api_follow(state: State<'_, Api>, uid: i64, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/users/{uid}/follow"), None, expected_user_id, expected_origin.as_deref())
        .await
}

/* ───────────────────────── 吃瓜帖子互动 ───────────────────────── */

#[tauri::command]
pub async fn api_post_like(state: State<'_, Api>, id: i64, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/posts/{id}/like"), None, expected_user_id, expected_origin.as_deref())
        .await
}

#[tauri::command]
pub async fn api_post_collect(state: State<'_, Api>, id: i64, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/posts/{id}/collect"), None, expected_user_id, expected_origin.as_deref())
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
