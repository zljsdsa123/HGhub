//! iOS AVFoundation cannot fetch WKWebView custom schemes. Give native video a
//! process-local, capability-protected HTTP endpoint without exposing images or
//! the business API. The listener exists only after the first player asks for it.

use std::io;
use std::sync::Arc;
use std::time::Duration;
use tauri::http::{HeaderName, HeaderValue, Response};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinHandle;

const MAX_CONNECTIONS: usize = 24;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_HEADERS: usize = 64;
const HEADER_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

static SERVER: Mutex<Option<Running>> = Mutex::const_new(None);

struct Running {
    endpoint: Endpoint,
    task: JoinHandle<()>,
}

#[derive(Clone)]
struct Endpoint {
    host: String,
    capability: String,
    origin: String,
}

impl Endpoint {
    fn new(port: u16) -> Result<Self, String> {
        let mut random = [0_u8; 32];
        getrandom::fill(&mut random).map_err(|_| "生成媒体通道标识失败".to_string())?;
        let capability: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let host = format!("127.0.0.1:{port}");
        let origin = format!("http://{host}/{capability}");
        Ok(Self { host, capability, origin })
    }
}

/// A completed listener is replaced on the next call instead of caching its
/// now-unusable address. The mutex also coalesces simultaneous player requests.
pub(crate) async fn origin() -> Result<String, String> {
    let mut state = SERVER.lock().await;
    if let Some(running) = state.as_ref().filter(|running| !running.task.is_finished()) {
        return Ok(running.endpoint.origin.clone());
    }
    let running = start(Handler::Media).await?;
    let origin = running.endpoint.origin.clone();
    *state = Some(running);
    Ok(origin)
}

async fn start(handler: Handler) -> Result<Running, String> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await
        .map_err(|_| "启动原生媒体通道失败".to_string())?;
    let port = listener.local_addr().map_err(|_| "读取媒体通道地址失败".to_string())?.port();
    let endpoint = Endpoint::new(port)?;
    let task = tokio::spawn(listen(listener, endpoint.clone(), handler));
    Ok(Running { endpoint, task })
}

#[derive(Clone)]
enum Handler {
    Media,
    #[cfg(test)]
    Fixture(Arc<std::sync::atomic::AtomicUsize>),
}

impl Handler {
    async fn response(&self, request: &Request, origin: &str) -> Response<Vec<u8>> {
        match self {
            Self::Media => crate::media::handle(&request.path, &request.query, origin, request.range.as_deref()).await,
            #[cfg(test)]
            Self::Fixture(calls) => {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let (mime, bytes) = if request.query == "u=playlist" || request.path == "/hls" {
                    ("application/vnd.apple.mpegurl", b"#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio.m3u8\"\n#EXTINF:4,\nclip.ts\n".as_slice())
                } else if request.query == "u=nested" {
                    // A sub-playlist is often served with an unhelpful MIME type.
                    ("application/octet-stream", b"#EXTM3U\n#EXTINF:4,\nnested.ts\n".as_slice())
                } else {
                    ("video/mp2t", b"0123456789".as_slice())
                };
                crate::media::fixture_response("https://fixture.example/video/master.m3u8", mime, bytes, origin, request.range.as_deref())
            }
        }
    }
}

async fn listen(listener: TcpListener, endpoint: Endpoint, handler: Handler) {
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        // No unbounded queue of waiting tasks; excess accepted sockets close.
        let Ok((stream, peer)) = listener.accept().await else { break };
        if !peer.ip().is_loopback() { continue; }
        let Ok(slot) = slots.clone().try_acquire_owned() else { continue };
        let endpoint = endpoint.clone();
        let handler = handler.clone();
        tokio::spawn(async move {
            let _slot = slot;
            // One deadline includes header reads, media loading and all writes.
            // Slow clients cannot hold a permit indefinitely by trickling bytes.
            let _ = tokio::time::timeout(REQUEST_TIMEOUT, serve(stream, &endpoint, &handler)).await;
        });
    }
}

struct Request {
    head: bool,
    path: String,
    query: String,
    range: Option<String>,
    origin: Option<String>,
}

fn app_origin(origin: &str) -> bool {
    if matches!(origin, "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost") {
        return true;
    }
    // A relaxed upstream network policy never relaxes the loopback boundary.
    cfg!(debug_assertions) && url::Url::parse(origin).is_ok_and(|url| {
        url.scheme() == "http" && url.port() == Some(1420)
            && url.host_str().is_some_and(crate::allowed_dev_host)
            && url.origin().ascii_serialization() == origin
    })
}

fn parse_request(bytes: &[u8], endpoint: &Endpoint) -> Result<Request, u16> {
    let text = std::str::from_utf8(bytes).map_err(|_| 400_u16)?;
    let text = text.strip_suffix("\r\n\r\n").ok_or(400_u16)?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next().ok_or(400_u16)?.split(' ');
    let method = first.next().ok_or(400_u16)?;
    let target = first.next().ok_or(400_u16)?;
    let version = first.next().ok_or(400_u16)?;
    if first.next().is_some() || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || !target.starts_with('/') || target.contains('#') || target.bytes().any(|b| b.is_ascii_control())
    {
        return Err(400);
    }
    if !matches!(method, "GET" | "HEAD") { return Err(405); }
    let mut hosts = Vec::new();
    let mut origins = Vec::new();
    let mut ranges = Vec::new();
    let mut if_range = false;
    for (index, line) in lines.enumerate() {
        if index >= MAX_HEADERS { return Err(431); }
        let (name, value) = line.split_once(':').ok_or(400_u16)?;
        HeaderName::from_bytes(name.as_bytes()).map_err(|_| 400_u16)?;
        let value = value.trim_matches([' ', '\t']);
        HeaderValue::from_str(value).map_err(|_| 400_u16)?;
        if name.eq_ignore_ascii_case("host") { hosts.push(value); }
        if name.eq_ignore_ascii_case("origin") { origins.push(value); }
        if name.eq_ignore_ascii_case("range") { ranges.push(value); }
        if name.eq_ignore_ascii_case("if-range") { if_range = true; }
        if name.eq_ignore_ascii_case("transfer-encoding")
            || (name.eq_ignore_ascii_case("content-length") && value != "0")
        {
            return Err(400);
        }
    }
    if hosts.len() != 1 || hosts[0] != endpoint.host { return Err(403); }
    if origins.len() > 1 || origins.first().is_some_and(|origin| !app_origin(origin)) {
        return Err(403);
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let path = path.strip_prefix(&format!("/{}", endpoint.capability)).ok_or(404_u16)?;
    if !matches!(path, "/hls" | "/seg") { return Err(404); }
    let range = if method == "GET" && !if_range && ranges.len() == 1 {
        Some(ranges[0].to_owned())
    } else {
        None
    };
    Ok(Request {
        head: method == "HEAD", path: path.to_owned(), query: query.to_owned(), range,
        origin: origins.first().map(|origin| (*origin).to_owned()),
    })
}

async fn read_headers(stream: &mut TcpStream, bytes: &mut Vec<u8>) -> Result<(), u16> {
    let mut buffer = [0_u8; 1024];
    loop {
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            bytes.truncate(end + 4);
            return Ok(());
        }
        if bytes.len() >= MAX_HEADER_BYTES { return Err(431); }
        let remaining = buffer.len().min(MAX_HEADER_BYTES - bytes.len());
        let count = stream.read(&mut buffer[..remaining]).await.map_err(|_| 400_u16)?;
        if count == 0 { return Err(400); }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

fn error_response(status: u16) -> Response<Vec<u8>> {
    let message = match status {
        400 => "bad request", 403 => "forbidden", 404 => "not found",
        405 => "method not allowed", 408 => "request timeout", 431 => "headers too large",
        _ => "request failed",
    };
    Response::builder().status(status).header("Content-Type", "text/plain")
        .body(message.as_bytes().to_vec()).expect("fixed HTTP response")
}

async fn serve(mut stream: TcpStream, endpoint: &Endpoint, handler: &Handler) -> io::Result<()> {
    let mut headers = Vec::with_capacity(2048);
    let read = tokio::time::timeout(HEADER_TIMEOUT, read_headers(&mut stream, &mut headers)).await;
    // Even a rejected HEAD carries the corresponding GET length, never a body.
    let head = headers.starts_with(b"HEAD ");
    match read {
        Ok(Ok(())) => {}
        Ok(Err(status)) => return write_response(&mut stream, head, None, error_response(status)).await,
        Err(_) => return write_response(&mut stream, head, None, error_response(408)).await,
    }
    let request = match parse_request(&headers, endpoint) {
        Ok(request) => request,
        Err(status) => return write_response(&mut stream, head, None, error_response(status)).await,
    };
    let response = handler.response(&request, &endpoint.origin).await;
    write_response(&mut stream, request.head, request.origin.as_deref(), response).await
}

async fn write_response(
    stream: &mut TcpStream,
    head: bool,
    origin: Option<&str>,
    response: Response<Vec<u8>>,
) -> io::Result<()> {
    let (parts, body) = response.into_parts();
    let status = parts.status;
    let mut headers = format!("HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n",
        status.as_u16(), status.canonical_reason().unwrap_or("Response"), body.len());
    for (name, value) in &parts.headers {
        if matches!(name.as_str(), "content-length" | "connection" | "transfer-encoding" | "cache-control" | "access-control-allow-origin" | "vary") {
            continue;
        }
        if let Ok(value) = value.to_str() {
            headers.push_str(name.as_str());
            headers.push_str(": ");
            headers.push_str(value);
            headers.push_str("\r\n");
        }
    }
    if let Some(origin) = origin {
        headers.push_str("Access-Control-Allow-Origin: ");
        headers.push_str(origin);
        headers.push_str("\r\nVary: Origin\r\n");
    }
    headers.push_str("\r\n");
    stream.write_all(headers.as_bytes()).await?;
    if !head { stream.write_all(&body).await?; }
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixture {
        running: Running,
        calls: Arc<AtomicUsize>,
    }

    impl Fixture {
        async fn new() -> Self {
            let calls = Arc::new(AtomicUsize::new(0));
            let running = start(Handler::Fixture(calls.clone())).await.expect("fixture listener");
            Self { running, calls }
        }

        async fn request(&self, method: &str, route: &str, headers: &str) -> Reply {
            let endpoint = &self.running.endpoint;
            exchange(endpoint, &format!("{method} /{}{route} HTTP/1.1\r\nHost: {}\r\n{headers}\r\n", endpoint.capability, endpoint.host)).await
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) { self.running.task.abort(); }
    }

    struct Reply {
        status: u16,
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    async fn exchange(endpoint: &Endpoint, raw: &str) -> Reply {
        tokio::time::timeout(Duration::from_secs(3), async {
            let mut stream = TcpStream::connect(&endpoint.host).await.expect("connect fixture");
            stream.write_all(raw.as_bytes()).await.expect("write request");
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).await.expect("read response");
            let split = bytes.windows(4).position(|part| part == b"\r\n\r\n").expect("HTTP headers");
            let text = std::str::from_utf8(&bytes[..split]).unwrap();
            let mut lines = text.split("\r\n");
            let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
            let headers = lines.map(|line| {
                let (key, value) = line.split_once(':').unwrap();
                (key.to_ascii_lowercase(), value.trim().to_owned())
            }).collect();
            Reply { status, headers, body: bytes[split + 4..].to_vec() }
        }).await.expect("socket request deadline")
    }

    #[tokio::test]
    async fn socket_rejects_bad_capabilities_paths_hosts_and_origins_before_media() {
        let fixture = Fixture::new().await;
        let endpoint = &fixture.running.endpoint;
        for route in ["/img?u=binary", "/other?u=binary", "/seg/extra?u=binary", "/../seg?u=binary"] {
            assert_eq!(fixture.request("GET", route, "").await.status, 404);
        }
        let wrong = format!("GET /wrong/seg?u=binary HTTP/1.1\r\nHost: {}\r\n\r\n", endpoint.host);
        assert_eq!(exchange(endpoint, &wrong).await.status, 404);
        for host in ["localhost:123", "attacker.example", "127.0.0.1"] {
            let request = format!("GET /{}/seg?u=binary HTTP/1.1\r\nHost: {host}\r\n\r\n", endpoint.capability);
            assert_eq!(exchange(endpoint, &request).await.status, 403);
        }
        assert_eq!(fixture.request("GET", "/seg?u=binary", &format!("Host: {}\r\n", endpoint.host)).await.status, 403);
        for headers in ["Origin: https://attacker.example\r\n", "Origin: null\r\n", "Origin: \r\n", "Origin: tauri://localhost\r\nOrigin: tauri://localhost\r\n"] {
            assert_eq!(fixture.request("GET", "/seg?u=binary", headers).await.status, 403);
        }
        assert_eq!(fixture.request("POST", "/seg?u=binary", "").await.status, 405);
        let rejected_head = fixture.request("HEAD", "/other?u=binary", "").await;
        assert_eq!(rejected_head.status, 404);
        assert!(rejected_head.body.is_empty());
        assert_eq!(rejected_head.headers["content-length"], "9");
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
        let native = fixture.request("GET", "/seg?u=binary", "").await;
        assert_eq!(native.status, 200);
        assert!(!native.headers.contains_key("access-control-allow-origin"));
        let app = fixture.request("GET", "/seg?u=binary", "Origin: tauri://localhost\r\n").await;
        assert_eq!(app.status, 200);
        assert_eq!(app.headers["access-control-allow-origin"], "tauri://localhost");
    }

    #[tokio::test]
    async fn socket_missing_u_uses_real_media_handler_without_upstream() {
        let running = start(Handler::Media).await.unwrap();
        for method in ["GET", "HEAD"] {
            let endpoint = &running.endpoint;
            let response = exchange(endpoint, &format!("{method} /{}/hls HTTP/1.1\r\nHost: {}\r\n\r\n", endpoint.capability, endpoint.host)).await;
            assert_eq!(response.status, 400);
            assert_eq!(response.headers["content-length"], "9");
            assert_eq!(response.body.as_slice(), if method == "HEAD" { b"".as_slice() } else { b"missing u".as_slice() });
        }
        running.task.abort();
    }

    #[tokio::test]
    async fn socket_range_head_and_conditional_requests_follow_media_semantics() {
        let fixture = Fixture::new().await;
        let partial = fixture.request("GET", "/seg?u=binary", "Range: bytes=2-5\r\n").await;
        assert_eq!(partial.status, 206);
        assert_eq!(partial.body, b"2345");
        assert_eq!(partial.headers["content-range"], "bytes 2-5/10");
        assert_eq!(partial.headers["content-length"], "4");
        for headers in ["Range: bytes=0-1\r\nIf-Range: \"etag\"\r\n", "Range: bytes=0-1\r\nRange: bytes=2-3\r\n", "Range: bytes=0-1,4-5\r\n", "Range: bytes=invalid\r\n"] {
            let full = fixture.request("GET", "/seg?u=binary", headers).await;
            assert_eq!(full.status, 200);
            assert_eq!(full.body, b"0123456789");
            assert!(!full.headers.contains_key("content-range"));
        }
        let head = fixture.request("HEAD", "/seg?u=binary", "Range: bytes=2-5\r\n").await;
        assert_eq!(head.status, 200);
        assert!(head.body.is_empty());
        assert_eq!(head.headers["content-length"], "10");
        assert!(!head.headers.contains_key("content-range"));
        let unsatisfiable = fixture.request("GET", "/seg?u=binary", "Range: bytes=20-\r\n").await;
        assert_eq!(unsatisfiable.status, 416);
        assert!(unsatisfiable.body.is_empty());
        assert_eq!(unsatisfiable.headers["content-range"], "bytes */10");
    }

    #[tokio::test]
    async fn socket_playlists_remain_complete_and_keep_capability_in_nested_urls() {
        let fixture = Fixture::new().await;
        let prefix = format!("{}/seg?u=", fixture.running.endpoint.origin);
        for route in ["/hls?u=playlist", "/seg?u=playlist", "/seg?u=nested"] {
            let full = fixture.request("GET", route, "Range: bytes=0-1\r\n").await;
            assert_eq!(full.status, 200);
            assert!(!full.headers.contains_key("content-range"));
            assert!(!full.headers.contains_key("accept-ranges"));
            let body = std::str::from_utf8(&full.body).unwrap();
            assert!(body.starts_with("#EXTM3U\n"));
            assert!(body.contains(&prefix));
            assert!(!body.contains("URI=\"audio.m3u8\""));
            assert_eq!(full.headers["content-length"], full.body.len().to_string());
            let head = fixture.request("HEAD", route, "Range: bytes=0-1\r\n").await;
            assert_eq!(head.status, 200);
            assert!(head.body.is_empty());
            assert_eq!(head.headers["content-length"], full.headers["content-length"]);
        }
    }

    #[tokio::test]
    async fn socket_rejects_oversized_and_ambiguous_headers() {
        let fixture = Fixture::new().await;
        let endpoint = &fixture.running.endpoint;
        // Hit the limit without leaving unread data that would reset the socket
        // on close and hide its 431 response on some operating systems.
        let mut oversized = format!("GET /{}/seg?u=binary HTTP/1.1\r\nHost: {}\r\nX-Long: ", endpoint.capability, endpoint.host);
        oversized.push_str(&"x".repeat(MAX_HEADER_BYTES - oversized.len()));
        assert_eq!(exchange(endpoint, &oversized).await.status, 431);
        let many = "X-Header: value\r\n".repeat(MAX_HEADERS);
        assert_eq!(fixture.request("GET", "/seg?u=binary", &many).await.status, 431);
        for headers in ["Transfer-Encoding: chunked\r\n", "Content-Length: 1\r\n", "Host : example\r\n", " folded: value\r\n"] {
            assert_eq!(fixture.request("GET", "/seg?u=binary", headers).await.status, 400);
        }
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn origin_is_shared_and_restarts_after_listener_exit() {
        let (first, simultaneous) = tokio::join!(origin(), origin());
        let first = first.unwrap();
        assert_eq!(first, simultaneous.unwrap());
        let old = SERVER.lock().await.take().unwrap();
        assert_eq!(old.endpoint.capability.len(), 64);
        old.task.abort();
        let _ = old.task.await;
        // Keep the finished listener in state to exercise the recovery branch.
        let finished = tokio::spawn(async {});
        while !finished.is_finished() { tokio::task::yield_now().await; }
        *SERVER.lock().await = Some(Running { endpoint: old.endpoint, task: finished });
        let second = origin().await.unwrap();
        assert_ne!(first, second);
        SERVER.lock().await.take().unwrap().task.abort();
    }
}
