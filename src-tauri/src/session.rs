//! 会话持久化：token + 用户资料存到应用数据目录。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Session {
    // 旧版本没有 origin：不能推断其 token 属于哪个镜像，升级后必须重新登录。
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub user: serde_json::Value,
    /// Process-local identity epoch, so even logout/login with a reused token invalidates old work.
    #[serde(skip)]
    pub revision: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn credentials_are_bound_to_origin() {
        let store = SessionStore::new();
        store.set(
            "https://huangguoai.com",
            "secret-token".into(),
            json!({"id": 1}),
        );
        assert_eq!(
            store.token("https://huangguoai.com").as_deref(),
            Some("secret-token")
        );
        assert_eq!(store.token("https://huangguoai.ai"), None);
        assert_eq!(store.token("https://evil.example"), None);
        assert!(store.user("https://evil.example").is_null());
        store.clear();
        assert_eq!(store.token("https://huangguoai.com"), None);
    }

    #[test]
    fn legacy_sessions_are_not_assigned_to_current_line() {
        let store = SessionStore::new();
        *store.current.lock().unwrap() =
            serde_json::from_str(r#"{"token":"legacy","user":{"id":1}}"#).unwrap();
        assert_eq!(store.token("https://huangguoai.com"), None);
        assert!(store.user("https://huangguoai.com").is_null());
    }

    #[test]
    fn late_profile_and_logout_cannot_replace_a_new_session() {
        let store = SessionStore::new();
        let origin = "https://example.com";
        store.set(origin, "first".into(), json!({"id": 1}));
        let first = store.snapshot(origin).unwrap();
        store.set(origin, "second".into(), json!({"id": 2}));
        assert!(!store.update_user_if_current(&first, json!({"id": 1, "nickname": "late"})));
        assert!(!store.clear_if_current(&first));
        assert_eq!(store.user(origin)["id"], 2);
        let second = store.snapshot(origin).unwrap();
        assert!(!store.update_user_if_current(&second, json!({"id": 1})));
        assert!(store.update_user_if_current(&second, json!({"id": 2, "nickname": "fresh"})));
    }

    #[test]
    fn relogin_with_same_token_still_invalidates_old_requests() {
        let store = SessionStore::new();
        let origin = "https://example.com";
        store.set(origin, "same".into(), json!({"id": 1}));
        let old = store.snapshot(origin).unwrap();
        store.clear();
        store.set(origin, "same".into(), json!({"id": 1}));
        assert!(!store.is_current(&old));
        assert!(!store.clear_if_current(&old));
        assert!(serde_json::to_value(store.snapshot(origin).unwrap()).unwrap().get("revision").is_none());
    }

    #[test]
    fn late_login_cannot_replace_a_newer_account() {
        let store = SessionStore::new();
        let origin = "https://example.com";
        let revision = store.revision();
        assert!(store.set_if_revision(revision, origin, "new".into(), json!({"id": 2})));
        assert!(!store.set_if_revision(revision, origin, "late".into(), json!({"id": 1})));
        assert_eq!(store.user(origin)["id"], 2);
    }
}

pub struct SessionStore {
    pub file: Mutex<Option<PathBuf>>,
    pub current: Mutex<Session>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            file: Mutex::new(None),
            current: Mutex::new(Session::default()),
        }
    }

    pub fn bind(&self, dir: PathBuf) {
        let mut path = dir;
        path.push("session.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(sess) = serde_json::from_str::<Session>(&text) {
                *self.current.lock().unwrap() = sess;
            }
        }
        *self.file.lock().unwrap() = Some(path);
    }

    pub fn token(&self, origin: &str) -> Option<String> {
        let cur = self.current.lock().unwrap();
        (cur.origin == origin && !cur.token.is_empty()).then(|| cur.token.clone())
    }

    pub fn user(&self, origin: &str) -> serde_json::Value {
        let cur = self.current.lock().unwrap();
        if cur.origin == origin && !cur.token.is_empty() {
            cur.user.clone()
        } else {
            serde_json::Value::Null
        }
    }

    pub fn snapshot(&self, origin: &str) -> Option<Session> {
        let cur = self.current.lock().unwrap();
        (cur.origin == origin && !cur.token.is_empty()).then(|| cur.clone())
    }

    pub fn revision(&self) -> u64 {
        self.current.lock().unwrap().revision
    }

    pub fn set_if_revision(&self, expected_revision: u64, origin: &str, token: String, user: serde_json::Value) -> bool {
        {
            let mut cur = self.current.lock().unwrap();
            if cur.revision != expected_revision { return false; }
            cur.origin = origin.to_string();
            cur.token = token;
            cur.user = user;
            cur.revision = cur.revision.wrapping_add(1);
        }
        self.persist();
        true
    }

    fn same_identity(current: &Session, expected: &Session) -> bool {
        current.revision == expected.revision
            && current.origin == expected.origin
            && current.token == expected.token
            && current.user.get("id") == expected.user.get("id")
    }

    pub fn is_current(&self, expected: &Session) -> bool {
        Self::same_identity(&self.current.lock().unwrap(), expected)
    }

    pub fn update_user_if_current(&self, expected: &Session, user: serde_json::Value) -> bool {
        {
            let mut cur = self.current.lock().unwrap();
            if !Self::same_identity(&cur, expected) || user.get("id") != expected.user.get("id") {
                return false;
            }
            cur.user = user;
        }
        self.persist();
        true
    }

    pub fn clear_if_current(&self, expected: &Session) -> bool {
        {
            let mut cur = self.current.lock().unwrap();
            if !Self::same_identity(&cur, expected) { return false; }
            cur.token.clear();
            cur.origin.clear();
            cur.user = serde_json::Value::Null;
            cur.revision = cur.revision.wrapping_add(1);
        }
        self.persist();
        true
    }

    pub fn set(&self, origin: &str, token: String, user: serde_json::Value) {
        {
            let mut cur = self.current.lock().unwrap();
            cur.origin = origin.to_string();
            cur.token = token;
            cur.user = user;
            cur.revision = cur.revision.wrapping_add(1);
        }
        self.persist();
    }

    pub fn clear(&self) {
        {
            let mut cur = self.current.lock().unwrap();
            cur.token.clear();
            cur.origin.clear();
            cur.user = serde_json::Value::Null;
            cur.revision = cur.revision.wrapping_add(1);
        }
        self.persist();
    }

    fn persist(&self) {
        // Keep state locked through the write so a slower earlier writer cannot persist over a new login.
        let snapshot = self.current.lock().unwrap();
        if let Some(path) = self.file.lock().unwrap().as_ref() {
            if let Ok(text) = serde_json::to_string_pretty(&*snapshot) {
                let _ = std::fs::write(path, text);
            }
        }
    }
}
