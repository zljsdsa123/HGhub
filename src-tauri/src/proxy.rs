//! App-local upstream proxy preferences. WebView loopback routing is separate.
//! Adopted from zhujinrun/HGhubX, with atomic state/persistence and URL validation.

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mode {
    System,
    Custom,
    Off,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Custom => "custom",
            Self::Off => "off",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "system" | "auto" | "" => Ok(Self::System),
            "custom" | "manual" => Ok(Self::Custom),
            "off" | "none" | "direct" => Ok(Self::Off),
            _ => Err("代理模式无效".into()),
        }
    }
}

#[derive(Clone, Hash, PartialEq, Eq)]
pub(crate) struct Config {
    pub mode: Mode,
    pub url: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            mode: Mode::System,
            url: String::new(),
        }
    }
}

impl Config {
    /// An unsaved test must depend only on its input, not the current app mode.
    pub(crate) fn for_test(mode: &str, url: &str) -> Result<Self, String> {
        let mode = Mode::parse(mode)?;
        Ok(Self {
            mode,
            url: if mode == Mode::Custom {
                normalize_proxy(url)?
            } else {
                String::new()
            },
        })
    }

    fn decode(text: &str) -> Self {
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            return Self::default();
        };
        let Ok(mode) = Mode::parse(
            value
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("system"),
        ) else {
            return Self::default();
        };
        let url = normalize_proxy(value.get("url").and_then(Value::as_str).unwrap_or(""))
            .unwrap_or_default();
        if mode == Mode::Custom && url.is_empty() {
            return Self::default();
        }
        Self { mode, url }
    }
}

#[derive(Default)]
struct State {
    config: Config,
    path: Option<PathBuf>,
}

impl State {
    fn bind(&mut self, dir: &Path) {
        let path = dir.join("proxy.json");
        self.config = std::fs::read_to_string(&path)
            .map(|text| Config::decode(&text))
            .unwrap_or_default();
        self.path = Some(path);
    }

    fn set(&mut self, mode: &str, url: &str) -> Result<(), String> {
        let mode = Mode::parse(mode)?;
        let url = if mode == Mode::Custom || !url.trim().is_empty() {
            normalize_proxy(url)?
        } else {
            self.config.url.clone()
        };
        let path = self.path.as_ref().ok_or("代理设置尚未初始化")?;
        write_atomic(
            path,
            &json!({"mode": mode.as_str(), "url": url}).to_string(),
        )?;
        self.config = Config { mode, url };
        Ok(())
    }
}

static STATE: Lazy<RwLock<State>> = Lazy::new(|| RwLock::new(State::default()));

pub(crate) fn snapshot() -> Config {
    STATE
        .read()
        .map(|state| state.config.clone())
        .unwrap_or_default()
}

pub fn mode() -> Mode {
    snapshot().mode
}
pub fn custom_url() -> Option<String> {
    let config = snapshot();
    (config.mode == Mode::Custom).then_some(config.url)
}

pub fn bind(dir: &Path) {
    if let Ok(mut state) = STATE.write() {
        state.bind(dir);
    }
}

pub fn set(mode: &str, url: &str) -> Result<Value, String> {
    let mut state = STATE.write().map_err(|_| "代理设置锁失败")?;
    state.set(mode, url)?;
    Ok(json!({"mode": state.config.mode.as_str()}))
}

/// Credentials are retained for the user's input field; callers must redact logs.
pub fn normalize_proxy(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("请填写代理地址（例：http://127.0.0.1:7897）".into());
    }
    if raw.chars().any(char::is_control) {
        return Err("代理地址含控制字符".into());
    }
    let with_scheme = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    };
    let parsed = url::Url::parse(&with_scheme).map_err(|_| "代理地址格式无效".to_string())?;
    if !["http", "https", "socks5", "socks5h", "socks4", "socks4a"].contains(&parsed.scheme()) {
        return Err("代理协议只支持 http / https / socks5 / socks4".into());
    }
    let host = parsed
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or("代理地址缺少主机名")?;
    if !matches!(parsed.path(), "" | "/") || parsed.query().is_some() || parsed.fragment().is_some()
    {
        return Err("代理地址不要带路径、参数或片段".into());
    }
    if parsed.port() == Some(0) {
        return Err("代理端口应为 1–65535".into());
    }
    if parsed.username().is_empty() && parsed.password().is_some() {
        return Err("代理认证缺少用户名".into());
    }
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let auth = match (parsed.username(), parsed.password()) {
        ("", _) => String::new(),
        (user, Some(pass)) => format!("{user}:{pass}@"),
        (user, None) => format!("{user}@"),
    };
    let port = parsed
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    let normalized = format!("{}://{auth}{host}{port}", parsed.scheme());
    reqwest::Proxy::all(&normalized).map_err(|_| "代理配置无效（已隐藏原始值）")?;
    Ok(normalized)
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let temp = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let write = || -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    };
    if write().is_err() {
        let _ = std::fs::remove_file(&temp);
        return Err("代理设置保存失败，已保留原设置".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("hghubx-proxy-{}-{unique}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn proxy_normalization_supports_auth_ipv6_and_rejects_invalid_targets() {
        assert_eq!(
            normalize_proxy("127.0.0.1:7897").unwrap(),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            normalize_proxy("socks5h://name:p%40ss@[::1]:1080/").unwrap(),
            "socks5h://name:p%40ss@[::1]:1080"
        );
        assert_eq!(
            normalize_proxy("https://proxy.example:443/").unwrap(),
            "https://proxy.example"
        );
        for bad in [
            "",
            "ftp://proxy.example",
            "http://proxy.example/path",
            "http://proxy.example?token=x",
            "http://proxy.example#fragment",
            "http://proxy.example:0",
            "http://:pass@proxy.example",
            "http://proxy.example\nname",
        ] {
            assert!(normalize_proxy(bad).is_err());
        }
    }

    #[test]
    fn configuration_persists_restores_and_keeps_saved_address_while_off() {
        let dir = temp_dir();
        let mut state = State::default();
        state.bind(&dir);
        state.set("custom", "127.0.0.1:7897").unwrap();
        let mut restarted = State::default();
        restarted.bind(&dir);
        assert!(state.config == restarted.config);
        restarted.set("off", "").unwrap();
        assert_eq!(restarted.config.mode, Mode::Off);
        assert_eq!(restarted.config.url, "http://127.0.0.1:7897");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir.join("proxy.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_save_does_not_change_live_configuration() {
        let dir = temp_dir();
        let mut state = State::default();
        state.bind(&dir);
        state.set("custom", "127.0.0.1:7897").unwrap();
        let previous = state.config.clone();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(state.set("off", "").is_err());
        assert!(state.config == previous);
    }

    #[test]
    fn invalid_or_missing_file_resets_to_system_and_test_input_is_independent() {
        for text in [
            "broken",
            r#"{"mode":"custom","url":"ftp://proxy.example"}"#,
            r#"{"mode":"unexpected"}"#,
        ] {
            assert!(Config::decode(text) == Config::default());
        }
        assert_eq!(
            Config::for_test("system", "invalid ignored draft")
                .unwrap()
                .mode,
            Mode::System
        );
        assert_eq!(
            Config::for_test("off", "invalid ignored draft")
                .unwrap()
                .mode,
            Mode::Off
        );
        assert!(Config::for_test("invalid", "").is_err());
        assert!(Config::for_test("custom", "").is_err());
        let dir = temp_dir();
        let mut state = State::default();
        state.bind(&dir);
        state.set("custom", "127.0.0.1:7897").unwrap();
        std::fs::remove_file(dir.join("proxy.json")).unwrap();
        state.bind(&dir);
        assert!(state.config == Config::default());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
