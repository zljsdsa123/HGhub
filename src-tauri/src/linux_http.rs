//! Linux 桌面端的媒体通道：把 [`crate::media::handle`] 挂到一个只监听
//! 127.0.0.1 的 HTTP 服务上。
//!
//! 为什么需要它：Tauri 的自定义协议只对 WebView 自己的资源加载生效，而
//! WebKitGTK 的 `<video>` 是交给 GStreamer 播放的，GStreamer 只认 http/https/file
//! 这类常规 URI，直接给它 `hg://localhost` 打不开；同时 WebKitGTK 4.1 默认不提供
//! MediaSource，hls.js 也用不上。Linux 端的播放只能让 GStreamer 的 hlsdemux
//! 原生完成，而它需要一个真正可取的 HTTP 地址——就是这个服务。
//!
//! 端口固定，前端 `src/shared/api/api.ts` 的 `LOCAL` 必须与 [`ORIGIN`] 一致。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// 监听端口。前端硬编码同一个值，两边必须同时改。
pub const PORT: u16 = 17650;

/// 前端与 m3u8 分片改写共用的 origin。
pub const ORIGIN: &str = "http://127.0.0.1:17650";

const MAX_CONNECTIONS: usize = 24;
const MAX_HEADERS: usize = 64;
const MAX_LINE_BYTES: u64 = 8 * 1024;

/// 在后台线程里起服务。绑定失败时记日志并退出，本地媒体服务不可用，播放会失败。
pub fn start() {
    std::thread::spawn(|| {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("[hg] 媒体端口 {PORT} 绑定失败：{err}");
                return;
            }
        };
        eprintln!("[hg] 媒体代理就绪：{ORIGIN}");
        let active = Arc::new(AtomicUsize::new(0));
        for stream in listener.incoming().flatten() {
            if !stream.peer_addr().is_ok_and(|peer| peer.ip().is_loopback()) {
                continue;
            }
            if active.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
                active.fetch_sub(1, Ordering::AcqRel);
                continue;
            }
            let active = active.clone();
            std::thread::spawn(move || {
                struct Guard(Arc<AtomicUsize>);
                impl Drop for Guard {
                    fn drop(&mut self) {
                        self.0.fetch_sub(1, Ordering::AcqRel);
                    }
                }
                let _guard = Guard(active);
                if let Err(err) = serve(stream) {
                    eprintln!("[hg] 媒体请求失败：{err}");
                }
            });
        }
    });
}

fn read_bounded_line(reader: &mut BufReader<TcpStream>, buf: &mut String) -> std::io::Result<usize> {
    buf.clear();
    let n = reader.take(MAX_LINE_BYTES).read_line(buf)?;
    if n as u64 == MAX_LINE_BYTES && !buf.ends_with('\n') {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "header line too long"));
    }
    Ok(n)
}

fn serve(mut stream: TcpStream) -> std::io::Result<()> {
    let timeout = Some(std::time::Duration::from_secs(30));
    stream.set_read_timeout(timeout)?;
    stream.set_write_timeout(timeout)?;

    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if read_bounded_line(&mut reader, &mut request_line)? == 0 {
        return Ok(());
    }
    let mut request = request_line.split_whitespace();
    let method = request.next().unwrap_or_default();
    let target = request.next().unwrap_or("/");
    let mut range = None;
    let mut range_count = 0;
    let mut if_range = false;
    let mut header_pairs = Vec::new();
    let mut header_count = 0;
    loop {
        let mut line = String::new();
        if read_bounded_line(&mut reader, &mut line)? == 0 || line.trim_end().is_empty() {
            break;
        }
        header_count += 1;
        if header_count > MAX_HEADERS {
            return write_plain(&mut stream, method, 431, "request header fields too large");
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim();
            let value = value.trim();
            if name.eq_ignore_ascii_case("Host") || name.eq_ignore_ascii_case("Origin") {
                header_pairs.push((name.to_owned(), value.to_owned()));
            } else if name.eq_ignore_ascii_case("Range") {
                range_count += 1;
                range = Some(value.to_owned());
            } else if name.eq_ignore_ascii_case("If-Range") {
                if_range = true;
            }
        }
    }
    let borrowed: Vec<(&str, &str)> = header_pairs
        .iter()
        .map(|(n, v)| (n.as_str(), v.as_str()))
        .collect();
    if !headers_allowed(&borrowed) {
        return write_plain(&mut stream, method, 403, "forbidden");
    }
    if method != "GET" && method != "HEAD" {
        return write_plain(&mut stream, method, 405, "method not allowed");
    }

    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };

    let range = if method == "GET" && range_count == 1 && !if_range {
        range.as_deref()
    } else {
        None
    };
    let response = tauri::async_runtime::block_on(crate::media::handle(path, query, ORIGIN, range));
    let (parts, body) = response.into_parts();

    write_response(&mut stream, method, parts, &body)
}

fn write_response(
    stream: &mut impl Write,
    method: &str,
    parts: tauri::http::response::Parts,
    body: &[u8],
) -> std::io::Result<()> {
    let mut head = String::with_capacity(320);
    head.push_str(&format!(
        "HTTP/1.1 {} {}\r\n",
        parts.status.as_u16(),
        parts.status.canonical_reason().unwrap_or("OK")
    ));
    head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    for (name, value) in parts.headers.iter() {
        // This server sends a complete body and closes the connection. Do not
        // duplicate media::handle's length/CORS headers or forward framing for
        // an upstream connection (WebKit rejects ambiguous HTTP framing).
        if matches!(
            name.as_str(),
            "content-length" | "transfer-encoding" | "connection" | "access-control-allow-origin"
        ) {
            continue;
        }
        if let Ok(value) = value.to_str() {
            head.push_str(&format!("{}: {}\r\n", name.as_str(), value));
        }
    }
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    if method != "HEAD" {
        stream.write_all(body)?;
    }
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::{write_plain_to, write_response};
    use tauri::http::Response;

    #[test]
    fn duplicate_host_or_origin_headers_are_rejected_and_head_errors_omit_body() {
        assert!(super::headers_allowed(&[("Host", "127.0.0.1:17650")]));
        assert!(!super::headers_allowed(&[
            ("Host", "evil.example"),
            ("Host", "127.0.0.1:17650"),
        ]));
        assert!(!super::headers_allowed(&[
            ("Host", "127.0.0.1:17650"),
            ("Origin", "https://evil.example"),
            ("Origin", "tauri://localhost"),
        ]));
        let mut wire = Vec::new();
        write_plain_to(&mut wire, "HEAD", 403, "forbidden").unwrap();
        let text = String::from_utf8(wire).unwrap();
        assert!(text.contains("Content-Length: 9\r\n"));
        assert!(text.ends_with("\r\n\r\n"));
    }

    #[test]
    fn get_has_one_authoritative_length_and_cors_header() {
        let (parts, body) = Response::builder()
            .header("Content-Length", "999")
            .header("Transfer-Encoding", "chunked")
            .header("Connection", "keep-alive")
            .header("Access-Control-Allow-Origin", "*")
            .header("Content-Type", "application/vnd.apple.mpegurl")
            .body(b"#EXTM3U\n".to_vec())
            .unwrap()
            .into_parts();
        let mut wire = Vec::new();
        write_response(&mut wire, "GET", parts, &body).unwrap();
        let wire = String::from_utf8(wire).unwrap();
        let (head, data) = wire.split_once("\r\n\r\n").unwrap();
        let headers = head.to_ascii_lowercase();
        assert_eq!(headers.matches("content-length:").count(), 1);
        assert!(headers.contains("content-length: 8\r\n"));
        assert_eq!(headers.matches("access-control-allow-origin:").count(), 1);
        assert_eq!(headers.matches("connection:").count(), 1);
        assert!(headers.ends_with("connection: close"));
        assert!(!headers.contains("transfer-encoding:"));
        assert!(headers.contains("content-type: application/vnd.apple.mpegurl"));
        assert_eq!(data, "#EXTM3U\n");
    }

    #[test]
    fn head_keeps_representation_length_without_sending_body() {
        let (parts, body) = Response::builder()
            .status(206)
            .header("Content-Range", "bytes 0-3/20")
            .body(b"data".to_vec())
            .unwrap()
            .into_parts();
        let mut wire = Vec::new();
        write_response(&mut wire, "HEAD", parts, &body).unwrap();
        let wire = String::from_utf8(wire).unwrap();
        assert!(wire.starts_with("HTTP/1.1 206 Partial Content\r\n"));
        assert!(wire.contains("Content-Length: 4\r\n"));
        assert!(wire.contains("content-range: bytes 0-3/20\r\n"));
        assert!(wire.ends_with("\r\n\r\n"));
    }
}

fn headers_allowed(headers: &[(&str, &str)]) -> bool {
    let mut host_count = 0;
    let mut host_ok = false;
    let mut origin_count = 0;
    let mut origin_ok = true;
    for (name, value) in headers {
        if name.eq_ignore_ascii_case("Host") {
            host_count += 1;
            host_ok = matches!(*value, "127.0.0.1:17650" | "localhost:17650");
        } else if name.eq_ignore_ascii_case("Origin") {
            origin_count += 1;
            origin_ok = value.is_empty() || *value == "null" || crate::allowed_frontend_origin(value);
        }
    }
    host_count == 1 && host_ok && origin_count <= 1 && origin_ok
}

fn write_plain(stream: &mut TcpStream, method: &str, status: u16, message: &str) -> std::io::Result<()> {
    write_plain_to(stream, method, status, message)
}

fn write_plain_to(stream: &mut impl Write, method: &str, status: u16, message: &str) -> std::io::Result<()> {
    let reason = tauri::http::StatusCode::from_u16(status)
        .ok()
        .and_then(|code| code.canonical_reason())
        .unwrap_or("Error");
    let body = message.as_bytes();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    if method != "HEAD" {
        stream.write_all(body)?;
    }
    stream.flush()
}
