//! Protocol responses, byte ranges and playlist/segment response shaping.

use tauri::http::{Response, StatusCode};

use super::hls::rewrite_playlist;

// Linux can selectively clear WebKit's durable cache, so proxied media must not
// regrow it without bound. Other platforms lack that safe clearing path here;
// keep the original WebKit disk-cache fallback for native HLS and seeks.
#[cfg(target_os = "linux")]
pub(super) const PROXIED_MEDIA_CACHE_CONTROL: &str = "no-store";
#[cfg(not(target_os = "linux"))]
pub(super) const PROXIED_MEDIA_CACHE_CONTROL: &str = "public, max-age=3600";

#[cfg(target_os = "linux")]
pub(super) const PROXIED_IMAGE_CACHE_CONTROL: &str = "no-store";
#[cfg(not(target_os = "linux"))]
pub(super) const PROXIED_IMAGE_CACHE_CONTROL: &str = "public, max-age=86400";

/* ───────────────────────── 协议响应 ───────────────────────── */

pub(super) fn respond(status: u16, ctype: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
    let len = body.len().to_string();
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .header("Content-Type", ctype)
        // 长度以最终响应字节为准；播放列表始终完整返回，媒体分片支持 Range。
        .header("Content-Length", len)
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Type, Accept-Ranges, Content-Range")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", cache)
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 为原生播放器提供单段 byte range；无效/多段范围按 HTTP 语义退回完整 200。
pub(super) fn apply_byte_range(mut response: Response<Vec<u8>>, range: Option<&str>) -> Response<Vec<u8>> {
    use tauri::http::HeaderValue;

    if response.status() != StatusCode::OK {
        return response;
    }
    // A native HLS loader may send a byte probe for a playlist. Returning only
    // its first bytes hides #EXTM3U and nested URLs, so both /hls and playlists
    // discovered through /seg must remain complete 200 responses.
    if response.headers().get("Content-Type").and_then(|v| v.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("mpegurl"))
    {
        return response;
    }
    response.headers_mut().insert("Accept-Ranges", HeaderValue::from_static("bytes"));
    let Some((first, last)) = range
        .and_then(|v| v.trim().strip_prefix("bytes="))
        .and_then(|v| v.split_once('-'))
    else {
        return response;
    };
    let number = |s: &str| -> Option<usize> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            None
        } else {
            s.parse().ok()
        }
    };
    let len = response.body().len();
    let bounds = if first.is_empty() {
        let Some(suffix) = number(last) else { return response };
        (suffix > 0 && len > 0).then(|| (len.saturating_sub(suffix), len - 1))
    } else {
        let Some(start) = number(first) else { return response };
        let end = if last.is_empty() {
            len.saturating_sub(1)
        } else {
            let Some(end) = number(last) else { return response };
            if end < start { return response; }
            end
        };
        (start < len).then(|| (start, end.min(len - 1)))
    };

    let content_range = if let Some((start, end)) = bounds {
        // 原响应已经持有完整字节；原位截取，避免再复制完整视频分片。
        let body = response.body_mut();
        body.truncate(end + 1);
        if start > 0 {
            body.drain(..start);
        }
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
        format!("bytes {start}-{end}/{len}")
    } else {
        response.body_mut().clear();
        *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
        response.headers_mut().insert("Cache-Control", HeaderValue::from_static("no-store"));
        format!("bytes */{len}")
    };
    let length = response.body().len().to_string();
    response.headers_mut().insert("Content-Length", HeaderValue::from_str(&length).unwrap());
    response.headers_mut().insert("Content-Range", HeaderValue::from_str(&content_range).unwrap());
    response
}

/// 主清单的子清单也经 /seg 返回：必须继续改写，不能把内层 URL 原样交给播放器。
pub(super) fn segment_response(
    target: &str,
    ctype: Option<&str>,
    bytes: Vec<u8>,
    origin: &str,
) -> Response<Vec<u8>> {
    let playlist = ctype.is_some_and(|t| t.to_ascii_lowercase().contains("mpegurl"))
        || bytes.starts_with(b"#EXTM3U")
        || bytes.starts_with(b"\xef\xbb\xbf#EXTM3U");
    if playlist {
        return match std::str::from_utf8(&bytes) {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                rewrite_playlist(target, text, origin).into_bytes(),
                PROXIED_MEDIA_CACHE_CONTROL,
            ),
            Err(_) => respond(
                502,
                "text/plain",
                b"invalid playlist encoding".to_vec(),
                "no-store",
            ),
        };
    }
    respond(
        200,
        ctype.unwrap_or("application/octet-stream"),
        bytes,
        PROXIED_MEDIA_CACHE_CONTROL,
    )
}

/// Socket tests supply bytes without contacting an upstream. They use the same
/// playlist rewrite, MIME detection and range implementation as real requests.
#[cfg(test)]
pub(crate) fn fixture_response(
    target: &str,
    ctype: &str,
    bytes: &[u8],
    origin: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    apply_byte_range(segment_response(target, Some(ctype), bytes.to_vec(), origin), range)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::hls::rewrite_playlist;
    use crate::media::LOCAL_ORIGIN;

    #[test]
    fn native_range_probe_returns_only_requested_segment_bytes() {
        let body = b"0123456789abcdef";
        for (range, start, end) in [
            ("bytes=0-1", 0, 1),
            ("bytes=0-7", 0, 7),
            ("bytes=8-", 8, body.len() - 1),
            ("bytes=-4", body.len() - 4, body.len() - 1),
            ("bytes=0-999", 0, body.len() - 1),
        ] {
            let response = apply_byte_range(
                respond(200, "video/mp2t", body.to_vec(), "no-store"),
                Some(range),
            );
            assert_eq!(response.status(), 206, "{range}");
            assert_eq!(response.body().as_slice(), &body[start..=end]);
            assert_eq!(response.headers()["Content-Type"], "video/mp2t");
            assert_eq!(response.headers()["Content-Length"], (end - start + 1).to_string());
            assert_eq!(response.headers()["Content-Range"], format!("bytes {start}-{end}/{}", body.len()));
        }
    }

    #[test]
    fn native_range_probes_keep_playlists_complete() {
        let body = b"#EXTM3U\n#EXTINF:4,\nsegment.ts\n";
        for range in ["bytes=0-1", "bytes=99999-", "bytes=-4"] {
            let response = apply_byte_range(
                respond(200, "application/vnd.apple.mpegurl", body.to_vec(), "no-store"),
                Some(range),
            );
            assert_eq!(response.status(), 200);
            assert_eq!(response.body(), body);
            assert_eq!(response.headers()["Content-Length"], body.len().to_string());
            assert!(!response.headers().contains_key("Content-Range"));
            assert!(!response.headers().contains_key("Accept-Ranges"));
        }
    }

    #[test]
    fn ranges_preserve_full_responses_and_reject_unsatisfiable_offsets() {
        for range in [None, Some("bytes=0-1,4-5"), Some("bytes=bad"), Some("bytes=3-1"), Some("items=0-1")] {
            let response = apply_byte_range(respond(200, "video/mp2t", b"data".to_vec(), "no-store"), range);
            assert_eq!(response.status(), 200);
            assert_eq!(response.body(), b"data");
            assert!(!response.headers().contains_key("Content-Range"));
        }
        for (body, range) in [(b"data".as_slice(), "bytes=4-"), (b"data".as_slice(), "bytes=-0"), (b"".as_slice(), "bytes=0-1")] {
            let response = apply_byte_range(respond(200, "video/mp2t", body.to_vec(), "no-store"), Some(range));
            assert_eq!(response.status(), 416);
            assert!(response.body().is_empty());
            assert_eq!(response.headers()["Content-Length"], "0");
            assert_eq!(response.headers()["Content-Range"], format!("bytes */{}", body.len()));
        }
        let error = apply_byte_range(respond(502, "text/plain", b"upstream failed".to_vec(), "no-store"), Some("bytes=0-1"));
        assert_eq!(error.status(), 502);
        assert_eq!(error.body(), b"upstream failed");
        assert!(!error.headers().contains_key("Accept-Ranges"));
    }

    #[test]
    fn nested_playlists_and_alternate_uris_stay_behind_proxy() {
        let text = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/list.m3u8\"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"http://127.0.0.1/key\"\n#EXT-X-PART:DURATION=1,URI=\"part.ts\"\nvariant/list.m3u8\n";
        let response = segment_response(
            "https://cdn.example/master.m3u8",
            Some("application/octet-stream"),
            text.as_bytes().to_vec(),
            LOCAL_ORIGIN,
        );
        let body = std::str::from_utf8(response.body()).unwrap();
        assert_eq!(body.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(), 4);
        // Linux 上 LOCAL_ORIGIN 本身就是 `http://127.0.0.1:<port>`，
        // 所以不能断言「不含 127.0.0.1」，要断言上游那条 key 地址已被代理包起来
        assert!(!body.contains("URI=\"http://127.0.0.1/key\""));
        assert!(body.contains("https%3A%2F%2Fcdn%2Eexample%2Faudio%2Flist%2Em3u8"));
        assert_eq!(
            response.headers()["Content-Type"],
            "application/vnd.apple.mpegurl"
        );
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        assert_eq!(
            response.headers()["Cache-Control"],
            PROXIED_MEDIA_CACHE_CONTROL
        );
        assert!(!response
            .headers()
            .contains_key("Access-Control-Allow-Origin"));
        let optional = rewrite_playlist("https://cdn.example/list.m3u8",
            "#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://other.example/list.json\"\n#EXT-X-DATERANGE:ID=\"ad\",X-ASSET-LIST=\"http://127.0.0.1/assets\"\nsegment.ts\n", LOCAL_ORIGIN);
        assert!(!optional.contains("CONTENT-STEERING") && !optional.contains("X-ASSET-LIST"));
        assert!(optional.contains("#EXT-X-DATERANGE:ID=\"ad\""));
        let bom = segment_response(
            "https://cdn.example/list.m3u8",
            None,
            b"\xef\xbb\xbf#EXTM3U\nsegment.ts\n".to_vec(),
            LOCAL_ORIGIN,
        );
        assert!(bom.body().starts_with(b"#EXTM3U\n"));
    }

    #[test]
    fn proxied_media_uses_platform_cache_policy() {
        let segment = segment_response(
            "https://cdn.example/seg-1.ts",
            Some("video/mp2t"),
            b"segment-bytes".to_vec(),
            LOCAL_ORIGIN,
        );
        assert_eq!(
            segment.headers()["Cache-Control"],
            PROXIED_MEDIA_CACHE_CONTROL
        );
        let playlist = segment_response(
            "https://cdn.example/list.m3u8",
            None,
            b"#EXTM3U\nseg-1.ts\n".to_vec(),
            LOCAL_ORIGIN,
        );
        assert_eq!(
            playlist.headers()["Cache-Control"],
            PROXIED_MEDIA_CACHE_CONTROL
        );
    }

    #[test]
    fn platform_cache_policy_matches_selective_clear_support() {
        #[cfg(target_os = "linux")]
        {
            assert_eq!(PROXIED_MEDIA_CACHE_CONTROL, "no-store");
            assert_eq!(PROXIED_IMAGE_CACHE_CONTROL, "no-store");
        }
        #[cfg(not(target_os = "linux"))]
        {
            assert_eq!(PROXIED_MEDIA_CACHE_CONTROL, "public, max-age=3600");
            assert_eq!(PROXIED_IMAGE_CACHE_CONTROL, "public, max-age=86400");
        }
    }
}
