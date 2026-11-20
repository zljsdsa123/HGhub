//! Video detail, playback and comments.

use super::Api;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn api_video(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/videos/{id}")).await
}

fn non_empty(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null() && x.as_str().is_some_and(|s| !s.trim().is_empty()))
}

/// 把新接口返回的 streams.main / streams.hevc 回填到 video_url / video_url_hevc，
/// 前端只认 video_url，旧字段缺失时也兼容。
fn normalize_play_info(info: &mut Value) {
    let Some(obj) = info.as_object_mut() else { return };
    for (field, key) in [("video_url", "main"), ("video_url_hevc", "hevc")] {
        let url = obj
            .get("streams")
            .and_then(|st| st.get(key))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned);
        if let Some(url) = url {
            if non_empty(obj.get(field)).is_none() {
                obj.insert(field.into(), json!(url));
            }
        }
    }
    if non_empty(obj.get("video_url")).is_none() {
        if let Some(hevc) = non_empty(obj.get("video_url_hevc")).cloned() {
            obj.insert("video_url".into(), hevc);
        }
    }
}

fn has_play_url(info: &Value) -> bool {
    non_empty(info.get("video_url")).is_some() || non_empty(info.get("video_url_hevc")).is_some()
}

#[tauri::command]
pub async fn api_play(state: State<'_, Api>, id: i64, ep: u32) -> Result<Value, String> {
    // 优先走新接口；失败或没有可用地址时退回旧接口，两者都不行就返回新接口的结果/错误。
    let primary = state
        .post(
            &format!("/api/videos/{id}/episodes/{ep}/playback"),
            Some(json!({})),
        )
        .await
        .map(|mut info| {
            normalize_play_info(&mut info);
            info
        });
    if let Ok(info) = &primary {
        if has_play_url(info) {
            return primary;
        }
    }
    match state
        .get(&format!("/api/videos/{id}/play?ep={ep}&page_texts=0"))
        .await
    {
        Ok(mut legacy) => {
            normalize_play_info(&mut legacy);
            if has_play_url(&legacy) || primary.is_err() {
                Ok(legacy)
            } else {
                primary
            }
        }
        Err(_) => primary,
    }
}

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
    state.account_request("POST", &path, Some(body), None, None).await
}

#[cfg(test)]
mod tests {
    use super::{has_play_url, normalize_play_info};
    use serde_json::json;

    #[test]
    fn hevc_only_stream_is_recognized_as_playable_fallback() {
        let mut info = json!({
            "id": "42",
            "ep": 1,
            "streams": {
                "main": "",
                "hevc": "https://cdn.example/video/hevc.m3u8"
            }
        });
        normalize_play_info(&mut info);
        assert!(has_play_url(&info));
        assert_eq!(info["video_url_hevc"], "https://cdn.example/video/hevc.m3u8");
        assert_eq!(info["video_url"], "https://cdn.example/video/hevc.m3u8");
    }
}
