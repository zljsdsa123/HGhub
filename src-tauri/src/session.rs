//! 会话持久化：token + 用户资料存到应用数据目录。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Credential trust for session rebase: fixed line or a mirror confirmed by a
/// trusted publish page in this process. Custom lines are deliberately NOT
/// trusted here — an explicitly saved custom origin may carry its own login,
/// but a token must never follow a switch to or from it.
pub fn rebase_trust(origin: &str) -> bool {
    crate::lines::is_fixed(origin) || crate::lines::is_trusted_mirror(origin)
}

/// Boot-time session visibility: a session already bound to the current line
/// stays visible even when this process could not refresh publisher trust
/// (flaky publish pages at boot). Sending credentials to an unverified mirror
/// remains fail-closed in `net::edge`; only the local login state is kept.
pub fn boot_credentials_visible(strict: bool, trusted: bool, bound_to_current: bool) -> bool {
    !strict || trusted || bound_to_current
}

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
    fn silent_login_preserves_existing_session_on_user_mismatch() {
        let store = SessionStore::new();
        let origin = "https://fixture.invalid";
        store.set(origin, "original-token".into(), json!({ "id": 9 }));
        let original = store.snapshot(origin).unwrap();

        let result = store.commit_login(
            original.revision, origin, Some(9), "replacement-token".into(), json!({ "id": 10 }),
        );
        assert_eq!(result.unwrap_err(), "当前线路返回的账号与本地登录不一致，请手动重新登录");
        assert!(store.is_current(&original), "a mismatched identity must not replace or advance the existing session");
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

    // Trusted rebase tests parameterize the trust predicate (like the real
    // callers inject `lines::is_fixed || lines::is_trusted_mirror`), so they do
    // not depend on which fixed lines exist or on the process-global mirror set.
    fn trusted_pair(origin: &str) -> bool {
        matches!(origin, "https://huangguoai.com" | "https://mirror-a.example")
    }

    #[test]
    fn trusted_rebase_moves_session_and_bumps_revision() {
        let store = SessionStore::new();
        let old_origin = "https://huangguoai.com";
        let new_origin = "https://mirror-a.example";
        store.set(old_origin, "secret-token".into(), json!({"id": 1}));
        let before = store.snapshot(old_origin).unwrap();
        assert!(store.rebase_if_trusted(new_origin, trusted_pair));
        assert_eq!(store.token(new_origin).as_deref(), Some("secret-token"));
        assert_eq!(store.user(new_origin)["id"], 1);
        // The old origin no longer resolves credentials.
        assert_eq!(store.token(old_origin), None);
        assert!(store.user(old_origin).is_null());
        // Same set_if_revision semantics: pre-switch snapshots are stale.
        assert_eq!(store.revision(), before.revision.wrapping_add(1));
        assert!(!store.is_current(&before));
        assert!(!store.update_user_if_current(&before, json!({"id": 1, "nickname": "late"})));
        assert!(!store.clear_if_current(&before));
        assert_eq!(store.stored_origin().as_deref(), Some(new_origin));
    }

    #[test]
    fn trusted_rebase_persists_the_new_origin() {
        let dir = std::env::temp_dir().join(format!(
            "hghubx-session-rebase-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SessionStore::new();
        store.bind(dir.clone());
        store.set("https://huangguoai.com", "secret-token".into(), json!({"id": 1}));
        assert!(store.rebase_if_trusted("https://mirror-a.example", trusted_pair));
        let on_disk: Session =
            serde_json::from_str(&std::fs::read_to_string(dir.join("session.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk.origin, "https://mirror-a.example");
        assert_eq!(on_disk.token, "secret-token");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rebase_refuses_untrusted_endpoints_in_both_directions() {
        for (old_origin, new_origin) in [
            // Trusted -> custom/untrusted must not hand the token over.
            ("https://huangguoai.com", "https://custom.example"),
            // Custom/untrusted -> trusted must not smuggle credentials in either.
            ("https://custom.example", "https://huangguoai.com"),
            // Unknown mirror -> trusted mirror.
            ("https://unpublished.example", "https://mirror-a.example"),
        ] {
            let store = SessionStore::new();
            store.set(old_origin, "secret-token".into(), json!({"id": 1}));
            let before = store.snapshot(old_origin).unwrap();
            assert!(!store.rebase_if_trusted(new_origin, trusted_pair), "{old_origin} -> {new_origin}");
            // Session untouched: same origin, token, identity epoch.
            assert_eq!(store.token(old_origin).as_deref(), Some("secret-token"));
            assert_eq!(store.token(new_origin), None);
            assert!(store.is_current(&before));
            assert_eq!(store.revision(), before.revision);
        }
    }

    #[test]
    fn rebase_on_empty_session_is_a_noop() {
        let store = SessionStore::new();
        assert_eq!(store.stored_origin(), None);
        let revision = store.revision();
        assert!(!store.rebase_if_trusted("https://mirror-a.example", trusted_pair));
        assert_eq!(store.revision(), revision);
        // Legacy sessions without origin stay unassigned and cannot be rebased.
        *store.current.lock().unwrap() =
            serde_json::from_str(r#"{"token":"legacy","user":{"id":1}}"#).unwrap();
        assert_eq!(store.stored_origin(), None);
        assert!(!store.rebase_if_trusted("https://huangguoai.com", trusted_pair));
        assert_eq!(store.token("https://huangguoai.com"), None);
    }

    #[test]
    fn rebase_to_the_same_origin_keeps_the_revision() {
        let store = SessionStore::new();
        let origin = "https://huangguoai.com";
        store.set(origin, "secret-token".into(), json!({"id": 1}));
        let before = store.snapshot(origin).unwrap();
        assert!(store.rebase_if_trusted(origin, trusted_pair));
        assert!(store.is_current(&before));
        assert_eq!(store.revision(), before.revision);
    }

    #[test]
    fn rebase_or_clear_keeps_trusted_and_drops_untrusted() {
        let store = SessionStore::new();
        store.set("https://huangguoai.com", "secret-token".into(), json!({"id": 1}));
        store.rebase_or_clear("https://mirror-a.example", trusted_pair);
        assert_eq!(store.token("https://mirror-a.example").as_deref(), Some("secret-token"));
        // Untrusted target: the session is dropped, never handed over.
        store.rebase_or_clear("https://custom.example", trusted_pair);
        assert_eq!(store.token("https://mirror-a.example"), None);
        assert_eq!(store.token("https://custom.example"), None);
        assert!(store.stored_origin().is_none());
    }

    #[tokio::test]
    async fn boot_reconcile_verifies_stored_mirror_even_when_current_line_is_fixed() {
        let store = SessionStore::new();
        store.set("https://mirror-a.example", "secret-token".into(), json!({"id": 1}));
        let published = std::sync::Mutex::new(Vec::<String>::new());
        store
            .reconcile_with(
                "https://huangguoai.com",
                || "https://huangguoai.com".to_string(),
                |origin| {
                    origin == "https://huangguoai.com"
                        || published.lock().unwrap().iter().any(|item| item == origin)
                },
                |origin| {
                    if origin != "https://huangguoai.com" {
                        published.lock().unwrap().push("https://mirror-a.example".into());
                    }
                    std::future::ready(())
                },
            )
            .await;
        assert_eq!(
            store.token("https://huangguoai.com").as_deref(),
            Some("secret-token")
        );
    }

    #[test]
    fn boot_keeps_a_session_bound_to_the_current_line_when_publisher_refresh_fails() {
        // 2.2.0 反馈：启动时发布页验证失败不得把绑在当前线路的会话报成登出；
        // edge 的「未验证镜像不发 token」仍然 fail closed。
        assert!(boot_credentials_visible(true, false, true));
        assert!(!boot_credentials_visible(true, false, false));
        assert!(boot_credentials_visible(true, true, false));
        assert!(boot_credentials_visible(false, false, false));
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

    /// Origin of the stored session (if any), regardless of the current line.
    /// Boot uses this to decide whether a trusted rebase is worth attempting;
    /// it never exposes the token itself.
    pub fn stored_origin(&self) -> Option<String> {
        let cur = self.current.lock().unwrap();
        (!cur.token.is_empty() && !cur.origin.is_empty()).then(|| cur.origin.clone())
    }

    /// Trusted-line switch: the upstream lines share one account system, so a
    /// login may follow a switch when BOTH the old and the new origin are
    /// credential-trusted (fixed line, or a mirror confirmed by a trusted
    /// publish page in this process). The trust predicate is injected by the
    /// caller so this module stays independent of `crate::lines`.
    ///
    /// Returns true when the session is usable on `new_origin` afterwards
    /// (rebased, or already bound there); false means "not moved" and manual
    /// callers must fall back to `clear()`. A successful rebase bumps the
    /// revision with `set_if_revision` semantics so old in-flight work cannot
    /// write back, and persists the new origin.
    pub fn rebase_if_trusted(&self, new_origin: &str, trusted: impl Fn(&str) -> bool) -> bool {
        {
            let mut cur = self.current.lock().unwrap();
            if cur.token.is_empty() || cur.origin.is_empty() {
                return false;
            }
            if !trusted(&cur.origin) || !trusted(new_origin) {
                return false;
            }
            if cur.origin == new_origin {
                return true;
            }
            cur.origin = new_origin.to_string();
            cur.revision = cur.revision.wrapping_add(1);
        }
        self.persist();
        true
    }

    /// Line-switch policy in one place: keep the login only when the trusted
    /// rebase succeeds, otherwise drop it (custom/untrusted endpoints never
    /// receive the old token). Callers pass the credential-trust predicate.
    pub fn rebase_or_clear(&self, new_origin: &str, trusted: impl Fn(&str) -> bool) {
        if !self.rebase_if_trusted(new_origin, trusted) {
            self.clear();
        }
    }

    /// Boot-time reconciliation under strict security: a session persisted on
    /// a previous line may follow a trusted switch recorded in line.json before
    /// this process started. Verify the CURRENT origin first (publisher refresh
    /// fills the trusted-mirror set), then rebase only when both ends are
    /// credential-trusted; otherwise the session stays on its old origin and
    /// boot reports logged-out for the current line (fail closed). A session
    /// already bound to an unverified current origin only gets the original
    /// publisher refresh, never a move.
    pub async fn reconcile_on_boot(&self, origin: &str) {
        self.reconcile_with(
            origin,
            crate::net::base,
            rebase_trust,
            |target| async move {
                let _ = crate::lines::verify_published_origin(&target).await;
            },
        )
        .await;
    }

    async fn reconcile_with<Cur, Trust, Verify, Fut>(
        &self,
        origin: &str,
        current_base: Cur,
        trusted: Trust,
        mut verify: Verify,
    ) where
        Cur: Fn() -> String,
        Trust: Fn(&str) -> bool,
        Verify: FnMut(String) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let rev = self.revision();
        let stored = self.stored_origin();
        if self.token(origin).is_none() {
            if let Some(old) = stored.as_deref().filter(|old| *old != origin) {
                verify(old.to_owned()).await;
                verify(origin.to_owned()).await;
                if current_base() == origin && self.revision() == rev {
                    let _ = self.rebase_if_trusted(origin, trusted);
                }
            }
        } else if !crate::net::trusted_auth_origin(origin) {
            verify(origin.to_owned()).await;
        }
    }

    pub fn revision(&self) -> u64 {
        self.current.lock().unwrap().revision
    }

    /// Commit a normalized login response. Manual login may replace the user;
    /// recovery of an existing session may only replace that user's token.
    pub fn commit_login(
        &self,
        revision: u64,
        origin: &str,
        expected_user_id: Option<i64>,
        token: String,
        user: serde_json::Value,
    ) -> Result<(), String> {
        if expected_user_id.is_some_and(|id| user.get("id").and_then(serde_json::Value::as_i64) != Some(id)) {
            return Err("当前线路返回的账号与本地登录不一致，请手动重新登录".into());
        }
        if !self.set_if_revision(revision, origin, token, user) {
            return Err("登录期间账号状态已变化，请重试".into());
        }
        Ok(())
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

    #[cfg(test)]
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
                let temp = path.with_extension("json.tmp");
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create(true).truncate(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                if let Ok(mut file) = options.open(&temp) {
                    use std::io::Write;
                    if file.write_all(text.as_bytes()).is_ok() && file.sync_all().is_ok() {
                        let _ = std::fs::rename(&temp, path);
                    }
                }
            }
        }
    }
}
