//! Feed, topics, tags, search, posts and user list commands.

use super::Api;
use serde_json::{json, Value};
use tauri::State;

/* ───────────────────────── 列表 ───────────────────────── */

#[tauri::command]
pub async fn api_feed(state: State<'_, Api>, page: u32, size: u32) -> Result<Value, String> {
    state
        .get(&format!("/api/videos?page={page}&size={size}"))
        .await
}

/// 原创频道，返回分页视频卡（结构同 api_feed）。
/// `cate="all"` 走 `/api/videos?is_original=1`；`ai-duanju`/`ai-manju` 走
/// `/api/videos/category/{cate}?is_original=1`。
#[tauri::command]
pub async fn api_original_videos(
    state: State<'_, Api>,
    cate: String,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    let sort = match sort.as_deref() {
        Some(s) if !s.trim().is_empty() => format!("&sort={s}"),
        _ => String::new(),
    };
    let path = if cate == "all" {
        format!("/api/videos?is_original=1&page={page}&size={size}{sort}")
    } else {
        format!("/api/videos/category/{cate}?is_original=1&page={page}&size={size}{sort}")
    };
    state.get(&path).await
}

/* ───────────────────────── 专题 / 标签 ───────────────────────── */

/// 专题列表：`/api/topics` 返回 data.items（标题/封面/简介/收录数）。
#[tauri::command]
pub async fn api_topics(state: State<'_, Api>) -> Result<Value, String> {
    state.get("/api/topics?size=100").await
}

/// 专题详情：`/api/topics/{slug}` 返回 data = { topic, videos, related }。
/// `videos` 是分页对象；专题可能有上百部，不能只读第一页。
#[tauri::command]
pub async fn api_topic(state: State<'_, Api>, slug: String, page: u32, size: u32) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(slug.as_bytes()).collect();
    let page = page.max(1);
    let size = size.clamp(1, 100);
    state.get(&format!("/api/topics/{encoded}?page={page}&size={size}")).await
}

/// 标签分组：`/api/tags` 返回 data.categories[]，每个含 tags[]（name/slug/hot_score）。
#[tauri::command]
pub async fn api_tags(state: State<'_, Api>) -> Result<Value, String> {
    state.get("/api/tags").await
}

/// 按标签取短剧：后端按中文标签名匹配；社区标签需使用 api_post_tag。
#[tauri::command]
pub async fn api_tag_videos(
    state: State<'_, Api>,
    tag: String,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(tag.as_bytes()).collect();
    state
        .get(&format!("/api/videos/tag/{encoded}?page={page}&size={size}"))
        .await
}

/// 按标签取吃瓜帖：`/api/posts/tag/{name}` 按标签名称匹配，不接受网页 slug。
#[tauri::command]
pub async fn api_post_tag(
    state: State<'_, Api>,
    tag: String,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(tag.as_bytes()).collect();
    let page = page.max(1);
    let size = size.clamp(1, 100);
    state
        .get(&format!("/api/posts/tag/{encoded}?page={page}&size={size}"))
        .await
}

#[tauri::command]
pub async fn api_category(
    state: State<'_, Api>,
    cate: String,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    let sort = match sort.as_deref() {
        Some(s) if !s.trim().is_empty() => format!("&sort={s}"),
        _ => String::new(),
    };
    state
        .get(&format!(
            "/api/videos/category/{cate}?page={page}&size={size}{sort}"
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

/// 全站搜索：`/api/search?q=...&type=video|post`。
///
/// `type` 省略时后端默认只搜短剧；吃瓜帖必须显式传 `type=post`，
/// 否则搜「吃瓜频道关键词」永远是空结果（issue #34）。
#[tauri::command]
pub async fn api_search(
    state: State<'_, Api>,
    q: String,
    page: u32,
    size: u32,
    kind: Option<String>,
) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(q.as_bytes()).collect();
    let scope = match kind.as_deref() {
        Some("post") => "&type=post",
        Some("video") => "&type=video",
        _ => "",
    };
    state
        .get(&format!("/api/search?q={encoded}&page={page}&size={size}{scope}"))
        .await
}

/// 热搜榜：解析官网搜索页服务端渲染的热搜影片列表。
#[tauri::command]
pub async fn api_search_hot(_state: State<'_, Api>) -> Result<Value, String> {
    crate::search_hot::fetch().await
}

#[tauri::command]
pub async fn api_posts(
    state: State<'_, Api>,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    let sort = match sort.as_deref() {
        Some(s) if !s.trim().is_empty() => format!("&sort={s}"),
        _ => String::new(),
    };
    state
        .get(&format!("/api/posts?page={page}&size={size}{sort}"))
        .await
}

#[tauri::command]
pub async fn api_post(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/posts/{id}")).await
}

/// 吃瓜帖视频：`POST /api/posts/{id}/playback` → `data.videos[].url`（mode=1 为明文 m3u8）。
///
/// 帖详情里的 `video_url` / `video_api` 恒为空，视频地址只由这个接口下发；
/// 不调它的话吃瓜页永远只有图文（issue #11）。无视频时接口返回 status=0
/// 「视频不存在或不可播放」，经 `edge()` 转换后就是 Err，前端按「无视频」处理。
#[tauri::command]
pub async fn api_post_playback(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state
        .post(&format!("/api/posts/{id}/playback"), Some(json!({})))
        .await
}

/// 吃瓜分类：`/api/site/categories/post` 返回 data.items（name/route）。
#[tauri::command]
pub async fn api_post_categories(state: State<'_, Api>) -> Result<Value, String> {
    state.get("/api/site/categories/post").await
}

/// 按分类取吃瓜帖：`/api/posts/category/{route}`；`sort=latest` 走最新排序。
#[tauri::command]
pub async fn api_post_category(
    state: State<'_, Api>,
    route: String,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(route.as_bytes()).collect();
    let sort = match sort.as_deref() {
        Some(s) if !s.trim().is_empty() => format!("&sort={s}"),
        _ => String::new(),
    };
    state
        .get(&format!(
            "/api/posts/category/{encoded}?page={page}&size={size}{sort}"
        ))
        .await
}

/// 相关推荐：`/api/videos/{id}/related` 返回 data.items。
#[tauri::command]
pub async fn api_related(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/videos/{id}/related")).await
}

/// 关注流：`/api/videos/following`（需登录）。
#[tauri::command]
pub async fn api_following(
    state: State<'_, Api>,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .account_request("GET", &format!("/api/videos/following?page={page}&size={size}"), None, None, None)
        .await
}

/// 用户主页：`/api/users/{id}`。
#[tauri::command]
pub async fn api_user(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/users/{id}")).await
}

/// 用户统计：`/api/users/{id}/stats`。
#[tauri::command]
pub async fn api_user_stats(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/users/{id}/stats")).await
}

/// 用户作品：`/api/videos/user/{id}`。
#[tauri::command]
pub async fn api_user_videos(
    state: State<'_, Api>,
    id: i64,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .get(&format!("/api/videos/user/{id}?page={page}&size={size}"))
        .await
}
