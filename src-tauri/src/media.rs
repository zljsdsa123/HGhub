//! 媒体层：封面解密 + HLS 代理。
//!
//! 站点封面是 AES-128-CBC 密文，m3u8 内部分片/key 又可能被 WebView 的 CORS 拦住，
//! 所以图片与视频统一走本地自定义协议（Windows/Android 为 `http://hg.localhost`，
//! macOS 为 `hg://localhost`，见 [`LOCAL_ORIGIN`]）。

use crate::net::fetch_bytes;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex, Weak};
use tauri::http::{Response, StatusCode};

/// 本平台自定义协议的完整基址。
///
/// Tauri 的自定义协议地址随平台不同：Windows / Android 是 `http://<scheme>.localhost`，
/// macOS / iOS / Linux 是 `<scheme>://localhost`。m3u8 里的分片与 key 地址按它改写。
/// 前端 `src/api.ts` 的 `LOCAL` 必须与此一致，否则封面与视频全部加载失败。
#[cfg(any(target_os = "windows", target_os = "android"))]
pub const LOCAL_ORIGIN: &str = "http://hg.localhost";
/// Linux 走 loopback HTTP：WebKitGTK 的播放器是 GStreamer，它拿不到自定义 scheme。
#[cfg(target_os = "linux")]
pub const LOCAL_ORIGIN: &str = crate::linux_http::ORIGIN;
#[cfg(not(any(target_os = "windows", target_os = "android", target_os = "linux")))]
pub const LOCAL_ORIGIN: &str = "hg://localhost";

const IMG_KEY: &[u8] = b"f5d965df75336270";
const IMG_IV: &[u8] = b"97b60394abc2fbe1";

static IMG_CACHE: Lazy<Mutex<HashMap<String, Arc<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
type ImageResult = Result<(String, Arc<Vec<u8>>), String>;
type ImageLoad = tokio::sync::OnceCell<ImageResult>;
// 背景、视频 poster 和详情可能同时请求同一张图，共享下载和解密。
// 弱引用不保留已完成任务/错误；图片重试仍可发起新的请求。
static IMG_LOADING: Lazy<Mutex<HashMap<(u64, String), Weak<ImageLoad>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static IMG_GENERATION: AtomicU64 = AtomicU64::new(0);
static PL_CACHE: Lazy<Mutex<HashMap<String, Arc<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static PL_CACHE_GENERATION: AtomicU64 = AtomicU64::new(0);
/// AES Key / 分片：拖进度条时同一 key、同一片会被反复拉，缓存住省一次往返。
static KEY_CACHE: Lazy<Mutex<HashMap<String, (String, Arc<Vec<u8>>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SEG_CACHE: Lazy<Mutex<HashMap<String, (String, Arc<Vec<u8>>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SEG_CACHE_GENERATION: AtomicU64 = AtomicU64::new(0);
type SegmentResult = Result<(Option<String>, Arc<Vec<u8>>), String>;
type SegmentLoad = tokio::sync::OnceCell<SegmentResult>;
// hls.js can issue the same segment concurrently (ABR probes, seek re-entry).
// Share the in-progress download, but never across a proxy/security generation.
static SEG_LOADING: Lazy<Mutex<HashMap<String, Weak<SegmentLoad>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SegmentScope {
    request: crate::net::RequestScope,
    cache_generation: u64,
}

fn segment_scope() -> SegmentScope {
    SegmentScope {
        request: crate::net::request_scope(),
        cache_generation: SEG_CACHE_GENERATION.load(Ordering::Acquire),
    }
}

fn segment_cache_key(scope: SegmentScope, url: &str) -> String {
    format!(
        "{}:{}:{}:{url}",
        u8::from(scope.request.strict),
        scope.request.generation,
        scope.cache_generation
    )
}

fn cached_segment(scope: SegmentScope, url: &str) -> Option<(String, Arc<Vec<u8>>)> {
    let key = segment_cache_key(scope, url);
    if let Some(hit) = KEY_CACHE.lock().unwrap().get(&key).cloned() {
        return Some(hit);
    }
    SEG_CACHE.lock().unwrap().get(&key).cloned()
}

/// Discard a response that belongs to a superseded transport or cache epoch.
/// The epoch prevents an old in-flight request from repopulating a cache that
/// the user just cleared.
fn store_segment_for_scope(
    scope: SegmentScope,
    current: SegmentScope,
    url: &str,
    mime: String,
    bytes: Arc<Vec<u8>>,
    len: usize,
) -> bool {
    store_segment_for_scope_with(scope, current, url, mime, bytes, len, segment_scope)
}

fn store_segment_for_scope_with<F>(
    scope: SegmentScope,
    current: SegmentScope,
    url: &str,
    mime: String,
    bytes: Arc<Vec<u8>>,
    len: usize,
    current_scope: F,
) -> bool
where
    F: FnOnce() -> SegmentScope,
{
    if scope != current {
        return false;
    }
    if len > SEG_CACHE_MAX_BYTES {
        return true;
    }
    let key = segment_cache_key(scope, url);
    let (cache, max) = if len <= 65536 {
        (&KEY_CACHE, KEY_CACHE_MAX)
    } else {
        (&SEG_CACHE, SEG_CACHE_MAX)
    };
    let mut cache = cache.lock().unwrap();
    // clear_caches advances the epoch before clearing maps. Recheck while
    // holding the map lock so a late writer can never insert after that clear.
    if current_scope() != scope {
        return false;
    }
    if cache.len() >= max {
        if let Some(oldest) = cache.keys().next().cloned() {
            cache.remove(&oldest);
        }
    }
    cache.insert(key, (mime, bytes));
    true
}

const IMG_CACHE_MAX: usize = 240;
const PL_CACHE_MAX: usize = 60;
const KEY_CACHE_MAX: usize = 120;
const SEG_CACHE_MAX: usize = 36;
const SEG_CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;

// Linux can selectively clear WebKit's durable cache, so proxied media must not
// regrow it without bound. Other platforms lack that safe clearing path here;
// keep the original WebKit disk-cache fallback for native HLS and seeks.
#[cfg(target_os = "linux")]
const PROXIED_MEDIA_CACHE_CONTROL: &str = "no-store";
#[cfg(not(target_os = "linux"))]
const PROXIED_MEDIA_CACHE_CONTROL: &str = "public, max-age=3600";

#[cfg(target_os = "linux")]
const PROXIED_IMAGE_CACHE_CONTROL: &str = "no-store";
#[cfg(not(target_os = "linux"))]
const PROXIED_IMAGE_CACHE_CONTROL: &str = "public, max-age=86400";

/// Run one in-progress request per key. Every waiter clones the same result,
/// including an error. Failed cells are removed immediately so a later request
/// can retry instead of inheriting a short-lived failed flight.
async fn coalesce<T, F, Fut>(
    registry: &Mutex<HashMap<String, Weak<tokio::sync::OnceCell<Result<T, String>>>>>,
    key: String,
    fetch: F,
) -> Result<T, String>
where
    T: Clone,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let load = {
        let mut requests = registry.lock().unwrap();
        requests.retain(|_, request| request.strong_count() > 0);
        if let Some(load) = requests.get(&key).and_then(Weak::upgrade) {
            load
        } else {
            let load = Arc::new(tokio::sync::OnceCell::new());
            requests.insert(key.clone(), Arc::downgrade(&load));
            load
        }
    };
    let result = load.get_or_init(fetch).await.clone();
    if result.is_err() {
        if let Ok(mut requests) = registry.lock() {
            if requests
                .get(&key)
                .and_then(Weak::upgrade)
                .is_some_and(|request| Arc::ptr_eq(&request, &load))
            {
                requests.remove(&key);
            }
        }
    }
    result
}

/* ───────────────────────── AES ───────────────────────── */

fn aes_cbc_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() || data.len() % 16 != 0 {
        return None;
    }
    let cipher = Aes128::new_from_slice(IMG_KEY).ok()?;
    let mut prev = [0u8; 16];
    prev.copy_from_slice(IMG_IV);
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = ct;
    }
    Some(out)
}

fn strip_padding(mut buf: Vec<u8>) -> Vec<u8> {
    let pad = *buf.last().unwrap_or(&0) as usize;
    if pad > 0 && pad <= 16 && buf.len() >= pad {
        if buf[buf.len() - pad..].iter().all(|b| *b as usize == pad) {
            buf.truncate(buf.len() - pad);
        }
    }
    buf
}

fn image_kind(buf: &[u8]) -> Option<&'static str> {
    if buf.len() < 12 {
        return None;
    }
    if buf[0] == 0xFF && buf[1] == 0xD8 {
        return Some("image/jpeg");
    }
    if buf.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("image/png");
    }
    if buf.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if buf.starts_with(b"RIFF") && &buf[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// 取封面：命中缓存直接返回；同地址的进行中请求共享下载和解密结果。
pub async fn load_image(url: &str) -> ImageResult {
    let generation = {
        let cache = IMG_CACHE.lock().unwrap();
        if let Some(hit) = cache.get(url).cloned() {
            let kind = image_kind(&hit).unwrap_or("image/jpeg");
            return Ok((kind.to_string(), hit));
        }
        IMG_GENERATION.load(Ordering::Acquire)
    };
    let loading = {
        let mut requests = IMG_LOADING.lock().unwrap();
        requests.retain(|_, request| request.strong_count() > 0);
        let key = (generation, url.to_string());
        if let Some(request) = requests.get(&key).and_then(Weak::upgrade) {
            request
        } else {
            let request = Arc::new(ImageLoad::new());
            requests.insert(key, Arc::downgrade(&request));
            request
        }
    };
    loading.get_or_init(|| download_image(url, generation)).await.clone()
}

async fn download_image(url: &str, generation: u64) -> ImageResult {
    // 缓存检查与领取任务之间，另一请求可能已完成。
    if let Some(hit) = IMG_CACHE.lock().unwrap().get(url).cloned() {
        let kind = image_kind(&hit).unwrap_or("image/jpeg");
        return Ok((kind.to_string(), hit));
    }
    let (_, bytes) = fetch_bytes(url).await?;
    let plain = if image_kind(&bytes).is_some() {
        bytes
    } else {
        let dec = aes_cbc_decrypt(&bytes).ok_or_else(|| "封面解密失败".to_string())?;
        strip_padding(dec)
    };
    let kind = image_kind(&plain).unwrap_or("image/jpeg").to_string();
    let arc = Arc::new(plain);
    let mut cache = IMG_CACHE.lock().unwrap();
    // 清缓存后，旧下载可完成当前显示，但不再把结果写回新一代缓存。
    if IMG_GENERATION.load(Ordering::Acquire) == generation {
        if cache.len() >= IMG_CACHE_MAX {
            if let Some(key) = cache.keys().next().cloned() {
                cache.remove(&key);
            }
        }
        cache.insert(url.to_string(), arc.clone());
    }
    Ok((kind, arc))
}

/* ───────────────────────── HLS ───────────────────────── */

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

fn dec(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().to_string()
}

fn absolutize(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    if let Ok(b) = url::Url::parse(base) {
        if let Ok(j) = b.join(target) {
            return j.to_string();
        }
    }
    target.to_string()
}

/// 属性列表中的引号内可含逗号，不能直接 split(',')。
fn hls_attributes(line: &str) -> Option<(&str, Vec<&str>)> {
    let (tag, rest) = line.split_once(':')?;
    let mut attributes = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (i, ch) in rest.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == ',' && !quoted {
            attributes.push(&rest[start..i]);
            start = i + 1;
        }
    }
    attributes.push(&rest[start..]);
    Some((tag, attributes))
}

fn map_uri_attributes(line: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let Some((tag, attributes)) = hls_attributes(line) else {
        return line.to_string();
    };
    let mapped: Vec<String> = attributes
        .into_iter()
        .map(|attribute| {
            if let Some((key, value)) = attribute.split_once('=') {
                if key.trim() == "URI" {
                    if let Some(uri) = value
                        .trim()
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                    {
                        return format!("{key}=\"{}\"", rewrite(uri));
                    }
                }
            }
            attribute.to_string()
        })
        .collect();
    format!("{tag}:{}", mapped.join(","))
}

fn rewrite_uri_attr(line: &str, prefix: &str) -> String {
    map_uri_attributes(line, |uri| format!("{prefix}/seg?u={}", enc(uri)))
}

/// 取 m3u8 并把 key / 分片地址改写到本地协议。
pub async fn load_playlist(url: &str, prefix: &str) -> Result<Arc<String>, String> {
    // 缓存 key 要带 prefix：同一份 m3u8 在不同 scheme 下改写结果不一样
    let cache_key = format!("{prefix}|{url}");
    let generation = PL_CACHE_GENERATION.load(Ordering::Acquire);
    if let Some(hit) = PL_CACHE.lock().unwrap().get(&cache_key).cloned() {
        return Ok(hit);
    }
    let (_, bytes) = fetch_bytes(url).await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "播放列表不是 UTF-8 文本")?;
    if !text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err("响应不是 HLS 播放列表".into());
    }
    let arc = Arc::new(rewrite_playlist(url, text, prefix));
    let mut cache = PL_CACHE.lock().unwrap();
    // clear_caches advances the epoch first; never let an older in-flight
    // playlist repopulate the cache after that clear.
    if PL_CACHE_GENERATION.load(Ordering::Acquire) == generation {
        if cache.len() >= PL_CACHE_MAX {
            if let Some(key) = cache.keys().next().cloned() {
                cache.remove(&key);
            }
        }
        cache.insert(cache_key, arc.clone());
    }
    Ok(arc)
}

fn rewrite_playlist(url: &str, text: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len() + 512);
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with('#') {
            // 禁用可派生 URL 的内容引导；DATERANGE 保留时间线/SCTE-35 元数据。
            if line.starts_with("#EXT-X-CONTENT-STEERING:") {
                continue;
            }
            if line.starts_with("#EXT-X-DATERANGE:") {
                if let Some((tag, attributes)) = hls_attributes(line) {
                    let safe: Vec<&str> = attributes
                        .into_iter()
                        .filter(|attribute| {
                            let key = attribute
                                .split('=')
                                .next()
                                .unwrap_or("")
                                .trim()
                                .to_ascii_uppercase();
                            !key.contains("URI") && key != "X-ASSET-LIST"
                        })
                        .collect();
                    out.push_str(&format!("{tag}:{}\n", safe.join(",")));
                }
                continue;
            }
            if line.contains("URI=\"") {
                // KEY/MAP/MEDIA/SESSION-KEY/PART/PRELOAD-HINT 等 URI 都必须经过目标检查。
                let absolute = absolutize_uri_in_attr(url, line);
                out.push_str(&rewrite_uri_attr(&absolute, prefix));
            } else {
                out.push_str(line);
            }
        } else {
            let absolute = absolutize(url, line);
            out.push_str(&format!("{prefix}/seg?u={}", enc(&absolute)));
        }
        out.push('\n');
    }

    out
}

fn absolutize_uri_in_attr(base: &str, line: &str) -> String {
    map_uri_attributes(line, |uri| absolutize(base, uri))
}

/// 分片 / AES Key 带内存缓存：拖动进度条时避免重复拉取同一片造成卡顿。
pub async fn load_segment(url: &str) -> SegmentResult {
    let scope = segment_scope();
    if let Some((ctype, hit)) = cached_segment(scope, url) {
        return Ok((Some(ctype), hit));
    }
    let key = segment_cache_key(scope, url);
    coalesce(&SEG_LOADING, key, || download_segment(url, scope)).await
}

async fn download_segment(url: &str, scope: SegmentScope) -> SegmentResult {
    // Another request may have populated the completed cache while this one
    // was waiting for the single-flight lock.
    if let Some((ctype, hit)) = cached_segment(scope, url) {
        return Ok((Some(ctype), hit));
    }
    let (ctype, bytes) = fetch_bytes(url).await?;
    let mime = ctype.clone().unwrap_or_else(|| {
        let p = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
        if p.ends_with(".ts") {
            "video/mp2t".to_string()
        } else if p.ends_with(".m4s") || p.ends_with(".mp4") {
            "video/mp4".to_string()
        } else {
            "application/octet-stream".to_string()
        }
    });
    let len = bytes.len();
    let arc = Arc::new(bytes);
    store_segment_for_scope(
        scope,
        segment_scope(),
        url,
        mime.clone(),
        arc.clone(),
        len,
    );
    Ok((Some(mime), arc))
}

/// 清空封面 / 播放列表 / Key / 分片内存缓存
pub fn clear_caches() {
    SEG_CACHE_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut g) = IMG_CACHE.lock() {
        IMG_GENERATION.fetch_add(1, Ordering::AcqRel);
        g.clear();
    }
    PL_CACHE_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut g) = PL_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = KEY_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = SEG_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = SEG_LOADING.lock() {
        g.clear();
    }
}

/* ───────────────────────── 协议响应 ───────────────────────── */

fn respond(status: u16, ctype: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
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
fn apply_byte_range(mut response: Response<Vec<u8>>, range: Option<&str>) -> Response<Vec<u8>> {
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
fn segment_response(
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

/// 统一入口：`<LOCAL_ORIGIN>/img?u=` / `hls?u=` / `seg?u=`
///
/// `origin` 是本平台自定义协议的完整基址，见 [`LOCAL_ORIGIN`]；用于改写 m3u8 里的
/// 分片与 key 地址。正常情况下调用方直接传 [`LOCAL_ORIGIN`]。
pub async fn handle(path: &str, query: &str, origin: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let target = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("u="))
        .map(dec)
        .unwrap_or_default();

    if target.is_empty() {
        return respond(400, "text/plain", b"missing u".to_vec(), "no-store");
    }

    let started = std::time::Instant::now();
    let route = match path {
        "/img" => "image",
        "/hls" => "playlist",
        "/seg" => "segment_or_key",
        _ => "unknown",
    };
    crate::playback_log::record(
        "proxy.begin",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target)}),
    );
    let response = match path {
        "/img" => match load_image(&target).await {
            Ok((kind, bytes)) => respond(
                200,
                &kind,
                bytes.as_ref().clone(),
                PROXIED_IMAGE_CACHE_CONTROL,
            ),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/hls" => match load_playlist(&target, origin).await {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                text.as_bytes().to_vec(),
                "no-store",
            ),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/seg" => match load_segment(&target).await {
            Ok((ctype, bytes)) => segment_response(&target, ctype.as_deref(), bytes.as_ref().clone(), origin),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        _ => respond(404, "text/plain", b"not found".to_vec(), "no-store"),
    };
    let response = apply_byte_range(response, range);
    crate::playback_log::record(
        "proxy.end",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target), "status": response.status().as_u16(), "bytes": response.body().len(), "content_type": response.headers().get("Content-Type").and_then(|v| v.to_str().ok()), "content_range": response.headers().get("Content-Range").and_then(|v| v.to_str().ok()), "elapsed_ms": started.elapsed().as_millis() as u64}),
    );
    response
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
    use std::sync::atomic::AtomicUsize;

    #[tokio::test]
    async fn concurrent_segment_flights_share_one_download() {
        let registry: Mutex<HashMap<String, Weak<tokio::sync::OnceCell<Result<u64, String>>>>> =
            Mutex::new(HashMap::new());
        let calls = AtomicUsize::new(0);
        let (first, second) = tokio::join!(
            coalesce(&registry, "same-segment".into(), || async {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                Ok(42)
            }),
            coalesce(&registry, "same-segment".into(), || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(99)
            })
        );
        assert_eq!(first, Ok(42));
        assert_eq!(second, Ok(42));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn segment_flight_failure_reaches_every_waiter_and_allows_retry() {
        let registry: Mutex<HashMap<String, Weak<tokio::sync::OnceCell<Result<u64, String>>>>> =
            Mutex::new(HashMap::new());
        let (first, second) = tokio::join!(
            coalesce(&registry, "failed-segment".into(), || async {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                Err("upstream failed".to_string())
            }),
            coalesce(&registry, "failed-segment".into(), || async {
                Ok(1)
            })
        );
        assert_eq!(first, Err("upstream failed".to_string()));
        assert_eq!(second, Err("upstream failed".to_string()));

        let retry = coalesce(&registry, "failed-segment".into(), || async { Ok(7) }).await;
        assert_eq!(retry, Ok(7));
    }

    #[test]
    fn segment_keys_do_not_cross_security_proxy_or_cache_generations() {
        let base = SegmentScope {
            request: crate::net::RequestScope {
                strict: true,
                generation: 11,
            },
            cache_generation: 3,
        };
        let key = segment_cache_key(base, "https://cdn.example/seg.ts");
        assert_eq!(key, segment_cache_key(base, "https://cdn.example/seg.ts"));
        assert_ne!(
            key,
            segment_cache_key(
                SegmentScope {
                    request: crate::net::RequestScope {
                        strict: false,
                        ..base.request
                    },
                    ..base
                },
                "https://cdn.example/seg.ts"
            )
        );
        assert_ne!(
            key,
            segment_cache_key(
                SegmentScope {
                    request: crate::net::RequestScope {
                        generation: 12,
                        ..base.request
                    },
                    ..base
                },
                "https://cdn.example/seg.ts"
            )
        );
        assert_ne!(
            key,
            segment_cache_key(
                SegmentScope {
                    cache_generation: 4,
                    ..base
                },
                "https://cdn.example/seg.ts"
            )
        );
        assert_ne!(
            key,
            segment_cache_key(base, "https://cdn.example/other.ts")
        );
    }

    #[test]
    fn late_old_scope_segment_is_discarded_instead_of_polluting_new_cache() {
        let url = "https://cdn.example/late-scope-test.ts";
        let old = SegmentScope {
            request: crate::net::RequestScope {
                strict: true,
                generation: 20,
            },
            cache_generation: 8,
        };
        let new = SegmentScope {
            request: crate::net::RequestScope {
                strict: true,
                generation: 21,
            },
            cache_generation: 9,
        };
        let bytes = Arc::new(vec![0x5a; 70_000]);

        assert!(!store_segment_for_scope(
            old,
            new,
            url,
            "video/mp2t".into(),
            bytes.clone(),
            bytes.len(),
        ));
        assert!(cached_segment(new, url).is_none());
        assert!(cached_segment(old, url).is_none());

        assert!(store_segment_for_scope_with(
            old,
            old,
            url,
            "video/mp2t".into(),
            bytes.clone(),
            bytes.len(),
            || old,
        ));
        assert!(cached_segment(old, url).is_some());
        assert!(cached_segment(new, url).is_none());

        SEG_CACHE
            .lock()
            .unwrap()
            .remove(&segment_cache_key(old, url));

        // clear_caches can advance the epoch after the first scope check but
        // before the map lock is acquired. The second check must still reject.
        assert!(!store_segment_for_scope_with(
            old,
            old,
            url,
            "video/mp2t".into(),
            bytes.clone(),
            bytes.len(),
            || new,
        ));
        assert!(cached_segment(old, url).is_none());
        assert!(cached_segment(new, url).is_none());
    }

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
    fn dateranges_keep_timing_and_scte_metadata_but_drop_external_resources() {
        let line = "#EXTM3U\n#EXT-X-DATERANGE:ID=\"event\",START-DATE=\"2026-11-07T00:00:00Z\",DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\",X-ASSET-URI=\"https://evil.example/ad\",X-ASSET-LIST=\"https://evil.example/list.json\"\n";
        let out = rewrite_playlist("https://cdn.example/master.m3u8", line, LOCAL_ORIGIN);
        assert!(out.contains("DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\""));
        assert!(out.contains("START-DATE="));
        assert!(!out.contains("evil.example") && !out.contains("X-ASSET"));
    }

    #[test]
    fn every_uri_attribute_is_rewritten_without_splitting_quoted_commas() {
        let line = "#EXT-X-MEDIA:NAME=\"audio,main\",URI=\"first.m3u8\",URI=\"second.m3u8\"";
        let absolute = absolutize_uri_in_attr("https://cdn.example/master.m3u8", line);
        let rewritten = rewrite_uri_attr(&absolute, LOCAL_ORIGIN);
        assert_eq!(
            rewritten.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(),
            2
        );
        assert!(rewritten.contains("NAME=\"audio,main\""));
        assert!(!rewritten.contains("URI=\"https://"));
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

    /// 联网测试：默认跳过，手动跑 `cargo test --lib -- --ignored`。
    /// 依赖上游 `/api/videos/117/play` 返回的实时播放地址。
    #[tokio::test]
    #[ignore = "联网测试：依赖上游实时播放地址，手动用 --ignored 运行"]
    async fn live_play_chain() {
        use crate::net::edge;
        let play = edge(
            &crate::net::base(),
            "GET",
            "/api/videos/117/play?ep=3&page_texts=0",
            None,
            None,
        )
        .await
        .expect("play api");
        let url = play["video_url"].as_str().expect("video_url").to_string();
        println!("play url: {}", &url[..url.len().min(90)]);
        let (_, bytes) = fetch_bytes(&url).await.expect("fetch playlist");
        let text = String::from_utf8_lossy(&bytes);
        println!(
            "raw playlist len={} head={}",
            text.len(),
            &text[..text.len().min(160)]
        );
        let q = format!("u={}", enc(&url));
        let resp = handle("/hls", &q, LOCAL_ORIGIN, None).await;
        let body = String::from_utf8_lossy(resp.body()).to_string();
        println!("proxied status={} len={}", resp.status(), body.len());
        assert!(body.contains("#EXTM3U"));
        // 取一个分片验证
        let seg_line = body
            .lines()
            .find(|l| !l.starts_with('#') && l.contains("/seg?u="))
            .expect("seg line")
            .to_string();
        println!("seg line: {}", &seg_line[..seg_line.len().min(120)]);
        let seg_q = seg_line.split("?u=").nth(1).unwrap();
        let seg = handle("/seg", &format!("u={seg_q}"), LOCAL_ORIGIN, None).await;
        println!("segment status={} len={}", seg.status(), seg.body().len());
        assert_eq!(seg.status(), 200);
        assert!(seg.body().len() > 1000);
    }

    /// 离线回归：不再依赖带 auth_key 时效的真实上游地址（旧地址已过期，会 403）。
    /// 与真实播放列表同构：带签名的分片地址 + 加密 KEY + 相对路径分片。
    #[test]
    fn playlist_rewrite_works() {
        let base = "https://cdn.example/videos5/abc/abc.m3u8?auth_key=9999999999-0-0-deadbeef&v=3&via=hgdj";
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?auth_key=9999999999-0-0-deadbeef\"\n#EXTINF:4,\nseg-1.ts?auth_key=9999999999-0-0-deadbeef\n";
        let body = rewrite_playlist(base, text, LOCAL_ORIGIN);

        assert!(body.contains("#EXTM3U"), "not a playlist: {body}");
        assert!(
            body.contains(&format!("{LOCAL_ORIGIN}/seg?u=")),
            "segments not rewritten: {body}"
        );
        // 分片必须绝对化到源站，并保留签名查询串。
        assert!(
            body.contains("https%3A%2F%2Fcdn%2Eexample%2Fvideos5%2Fabc%2Fseg%2D1%2Ets%3Fauth%5Fkey%3D"),
            "segment not absolutized with query: {body}"
        );
        // 加密 KEY 也要走本地代理，否则 hls.js 会直接打源站被 CORS 拦住。
        assert!(
            body.contains("URI=\"") && body.contains("%2Fkey%2Ebin%3Fauth%5Fkey%3D"),
            "key uri not rewritten: {body}"
        );
        assert!(!body.contains("URI=\"key.bin"), "key uri left relative");
    }

    /// 离线回归：用已知明文 + 项目内置 key/IV 构造密文，验证解密、去填充与类型识别。
    /// 真实封面抓取那条仍保留为 `#[ignore]` 联网测试。
    #[test]
    fn cover_decrypt_roundtrip() {
        use aes::cipher::BlockEncrypt;

        let plain = b"\xFF\xD8\xFF\xE0cover-payload-for-test".to_vec();
        let mut buf = plain.clone();
        let pad = 16 - plain.len() % 16;
        buf.extend(std::iter::repeat_n(pad as u8, pad));

        let cipher = Aes128::new_from_slice(IMG_KEY).expect("key");
        let mut prev = [0u8; 16];
        prev.copy_from_slice(IMG_IV);
        let mut encrypted = Vec::with_capacity(buf.len());
        for chunk in buf.chunks(16) {
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);
            for i in 0..16 {
                block[i] ^= prev[i];
            }
            let mut out_block = block;
            cipher.encrypt_block((&mut out_block).into());
            encrypted.extend_from_slice(&out_block);
            prev = out_block;
        }

        let decrypted = aes_cbc_decrypt(&encrypted).expect("decrypt");
        let stripped = strip_padding(decrypted);
        assert_eq!(stripped, plain);
        assert_eq!(image_kind(&stripped), Some("image/jpeg"));
    }

    /// 联网测试：默认跳过。封面地址带时效签名，不能硬编码进仓库，
    /// 需要用当次上游返回的地址显式传入：
    /// `HGHUBX_TEST_COVER_URL='https://…?auth_key=…' cargo test --lib -- --ignored`
    #[tokio::test]
    #[ignore = "联网测试：需要 HGHUBX_TEST_COVER_URL，手动用 --ignored 运行"]
    async fn cover_decrypt_works() {
        let url = crate::env::var("TEST_COVER_URL")
            .expect("需要设置 HGHUBX_TEST_COVER_URL 为当前有效的封面地址");
        match load_image(&url).await {
            Ok((kind, bytes)) => {
                println!("kind={kind} len={}", bytes.len());
                assert!(kind.starts_with("image/"));
            }
            Err(e) => panic!("image failed: {e}"),
        }
    }
}
