//! 业务命令：登录 / 列表 / 详情 / 播放 / 互动。
//!
//! Commands live in domain modules; `lib.rs` still registers them through
//! the re-exports below, so Tauri command names stay unchanged.

pub(crate) mod account;
pub(crate) mod feed;
pub(crate) mod interact;
pub(crate) mod lines;
pub(crate) mod platform;
pub(crate) mod update;
pub(crate) mod video;

#[allow(unused_imports)]
pub use account::*;
#[allow(unused_imports)]
pub use feed::*;
#[allow(unused_imports)]
pub use interact::*;
#[allow(unused_imports)]
pub use lines::*;
#[allow(unused_imports)]
pub use platform::*;
#[allow(unused_imports)]
pub use update::*;
#[allow(unused_imports)]
pub use video::*;

use crate::net::{base, edge};
use crate::session::{Session, SessionStore};
use serde_json::Value;

pub struct Api {
    pub session: SessionStore,
}

impl Api {
    pub fn new() -> Self {
        Self {
            session: SessionStore::new(),
        }
    }

    /// POST 信封：新播放接口 /api/videos/{id}/episodes/{ep}/playback 需要。
    async fn post(&self, path: &str, body: Option<Value>) -> Result<Value, String> {
        let origin = base();
        let token = self.session.token(&origin).filter(|_| {
            !crate::network_policy::strict_security() || crate::net::trusted_auth_origin(&origin)
        });
        edge(&origin, "POST", path, body, token.as_deref()).await
    }

    async fn get(&self, path: &str) -> Result<Value, String> {
        let origin = base();
        let token = self.session.token(&origin).filter(|_| {
            !crate::network_policy::strict_security() || crate::net::trusted_auth_origin(&origin)
        });
        edge(&origin, "GET", path, None, token.as_deref()).await
    }

    fn account_session(&self, expected_user_id: Option<i64>, expected_origin: Option<&str>) -> Result<Session, String> {
        let origin = base();
        let session = self.session.snapshot(&origin).ok_or_else(|| "请先登录".to_string())?;
        if expected_origin.is_some_and(|value| value != origin)
            || expected_user_id.is_some_and(|value| session.user.get("id").and_then(Value::as_i64) != Some(value)) {
            return Err("账号或线路已变化，请重试".into());
        }
        Ok(session)
    }

    async fn account_request(&self, method: &str, path: &str, body: Option<Value>, expected_user_id: Option<i64>, expected_origin: Option<&str>) -> Result<Value, String> {
        let session = self.account_session(expected_user_id, expected_origin)?;
        let result = edge(&session.origin, method, path, body, Some(&session.token)).await?;
        if base() != session.origin || !self.session.is_current(&session) {
            return Err("账号或线路已变化，请重试".into());
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    #[test]
    fn frontend_cannot_bypass_url_policy_with_opener_commands() {
        let capability: Value =
            serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        for permission in capability["permissions"].as_array().unwrap() {
            let name = permission
                .as_str()
                .or_else(|| permission["identifier"].as_str())
                .unwrap();
            assert!(
                !name.starts_with("opener:"),
                "frontend opener command exposed: {name}"
            );
        }
    }

    #[test]
    fn external_links_are_urls_not_shell_commands() {
        for raw in [
            "https://example.com/|calc.exe",
            "https://example.com/?a=1&b=2",
            "https://example.com/%25PATH%25",
            "https://example.com/%VAR%",
        ] {
            assert!(crate::network_policy::parse_target(raw).is_ok());
        }
        for raw in [
            "file:///etc/passwd",
            "mailto:user@example.com",
            "tel:123",
            "data:text/html,test",
            "javascript:alert(1)",
            "https://example.com/\0cmd",
            "https://user:password@example.com/",
        ] {
            assert!(crate::network_policy::parse_target(raw).is_err());
        }
    }
}
