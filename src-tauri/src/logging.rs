//! Shared UTC timestamps and the always-on debug journal.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use time::{format_description::well_known::Rfc3339, OffsetDateTime, UtcOffset};

static DEBUG_WRITER: Mutex<()> = Mutex::new(());

fn format_utc(at: OffsetDateTime) -> Result<String, String> {
    at.to_offset(UtcOffset::UTC)
        .format(&Rfc3339)
        .map_err(|_| "日志时间格式错误".to_string())
}

pub(crate) fn utc_timestamp() -> Result<String, String> {
    format_utc(OffsetDateTime::now_utc())
}

pub(crate) fn append_debug(dir: &Path, message: &str) -> Result<(), String> {
    let _writer = DEBUG_WRITER.lock().map_err(|_| "日志锁失败")?;
    fs::create_dir_all(dir).map_err(|_| "无法创建日志目录")?;
    let at = utc_timestamp()?;
    let prefix = format!("[{at}] [pid={}] ", std::process::id());
    let mut record = String::new();
    // Stamp continuation lines too, including stack traces, HTML errors and pretty JSON.
    for line in message.lines() {
        record.push_str(&prefix);
        record.push_str(line);
        record.push('\n');
    }
    if record.is_empty() {
        record.push_str(&prefix);
        record.push('\n');
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("debug.log"))
        .and_then(|mut f| f.write_all(record.as_bytes()))
        .map_err(|_| "无法写入调试日志".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn test_dir() -> std::path::PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "hghubx-debug-log-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn timestamps_are_utc_even_when_input_has_another_offset() {
        let instant = OffsetDateTime::from_unix_timestamp(0)
            .unwrap()
            .replace_nanosecond(123_456_789)
            .unwrap();
        for offset in [
            UtcOffset::UTC,
            UtcOffset::from_hms(8, 0, 0).unwrap(),
            UtcOffset::from_hms(-7, 0, 0).unwrap(),
        ] {
            assert_eq!(
                format_utc(instant.to_offset(offset)).unwrap(),
                "1970-01-01T00:00:00.123456789Z"
            );
        }
    }

    #[test]
    fn debug_errors_and_continuation_lines_have_utc_and_preserve_history() {
        let dir = test_dir();
        let path = dir.join("debug.log");
        fs::write(&path, "legacy entry without timestamp\n").unwrap();
        append_debug(&dir, "[api] api_feed → HTTP 503\r\n<html>\r\nerror\n").unwrap();
        append_debug(&dir, "[reject] failure\n    at handler").unwrap();
        append_debug(&dir, "").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines[0], "legacy entry without timestamp");
        assert_eq!(lines.len(), 7);
        for line in &lines[1..] {
            let (at, rest) = line.strip_prefix('[').unwrap().split_once("] ").unwrap();
            assert!(at.ends_with('Z'));
            assert!(at.contains('T'));
            assert!(rest.starts_with(&format!("[pid={}] ", std::process::id())));
            assert!(!line.contains('\r'));
        }
        assert!(lines[1].ends_with("[api] api_feed → HTTP 503"));
        assert!(lines[5].ends_with("    at handler"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_multiline_records_remain_together() {
        let dir = test_dir();
        let writers: Vec<_> = (0..4)
            .map(|worker| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    for entry in 0..8 {
                        append_debug(
                            &dir,
                            &format!("start {worker}/{entry}\nend {worker}/{entry}"),
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let text = fs::read_to_string(dir.join("debug.log")).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 64);
        for pair in lines.chunks_exact(2) {
            assert_eq!(pair[1], pair[0].replace("start ", "end "));
            assert!(pair[0].contains("Z] [pid="));
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
