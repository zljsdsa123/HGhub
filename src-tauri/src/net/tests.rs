use super::*;
use serde_json::json;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[test]
fn media_generation_survives_repeated_refreshes_of_same_configuration() {
    let config = crate::proxy::Config::for_test("system", "").unwrap();
    let fingerprint = media_config_fingerprint(DEFAULT_BASE, true, &config, 17);
    let generation = std::sync::atomic::AtomicU64::new(0);
    let mut previous = None;
    update_media_generation(&mut previous, fingerprint, &generation);
    for _ in 0..8 {
        update_media_generation(&mut previous, fingerprint, &generation);
    }
    assert_eq!(generation.load(Ordering::Acquire), 1);
    let changed = media_config_fingerprint(DEFAULT_BASE, true, &config, 18);
    update_media_generation(&mut previous, changed, &generation);
    assert_eq!(generation.load(Ordering::Acquire), 2);
    // Returning to a previous configuration is a new epoch too: an old
    // in-flight response must not repopulate the newly selected scope.
    update_media_generation(&mut previous, fingerprint, &generation);
    assert_eq!(generation.load(Ordering::Acquire), 3);
}

#[test]
fn media_fingerprint_changes_with_active_transport_configuration() {
    let system = crate::proxy::Config::for_test("system", "").unwrap();
    let direct = crate::proxy::Config::for_test("off", "").unwrap();
    let custom = crate::proxy::Config::for_test("custom", "http://127.0.0.1:7897").unwrap();
    let other_custom = crate::proxy::Config::for_test("custom", "http://127.0.0.1:7898").unwrap();
    let initial = media_config_fingerprint(DEFAULT_BASE, true, &system, 17);
    // The origin participates even when media URLs happen to be identical.
    assert_ne!(initial, media_config_fingerprint("https://huangguoai.ai", true, &system, 17));
    assert_ne!(initial, media_config_fingerprint(DEFAULT_BASE, false, &system, 17));
    assert_ne!(initial, media_config_fingerprint(DEFAULT_BASE, true, &system, 18));
    assert_ne!(initial, media_config_fingerprint(DEFAULT_BASE, true, &direct, 17));
    assert_ne!(initial, media_config_fingerprint(DEFAULT_BASE, true, &custom, 17));
    assert_ne!(
        media_config_fingerprint(DEFAULT_BASE, true, &custom, 17),
        media_config_fingerprint(DEFAULT_BASE, true, &other_custom, 17),
    );
}

#[test]
fn media_fingerprint_ignores_inactive_proxy_preferences() {
    let direct = crate::proxy::Config::for_test("off", "").unwrap();
    let dormant_custom = crate::proxy::Config {
        mode: crate::proxy::Mode::Off,
        url: "http://127.0.0.1:7897".into(),
    };
    // Switching an OS proxy or retaining the previous custom address while
    // direct mode is selected does not alter the active transport.
    assert_eq!(
        media_config_fingerprint(DEFAULT_BASE, true, &direct, 17),
        media_config_fingerprint(DEFAULT_BASE, true, &dormant_custom, 18),
    );
    let custom = crate::proxy::Config::for_test("custom", "http://127.0.0.1:7897").unwrap();
    assert_eq!(
        media_config_fingerprint(DEFAULT_BASE, true, &custom, 17),
        media_config_fingerprint(DEFAULT_BASE, true, &custom, 18),
    );
    let system = crate::proxy::Config::for_test("system", "").unwrap();
    let dormant_custom = crate::proxy::Config {
        mode: crate::proxy::Mode::System,
        url: "http://127.0.0.1:7897".into(),
    };
    assert_eq!(
        media_config_fingerprint(DEFAULT_BASE, true, &system, 17),
        media_config_fingerprint(DEFAULT_BASE, true, &dormant_custom, 17),
    );
}

#[test]
fn transport_errors_redact_proxy_auth_without_hiding_failure_category() {
    let raw = "error sending request for url (https://example.com/) ← proxy http://demo:secret@[::1]:7897 refused; socks5h://name:token@proxy.example:1080/path";
    let safe = redact_error_proxy_auth(raw);
    assert!(!safe.contains("demo") && !safe.contains("secret") && !safe.contains("name:token"));
    assert!(safe.contains("https://example.com/") && safe.contains("[::1]:7897 refused"));
    assert!(safe.contains("socks5h://[redacted]@proxy.example:1080/path"));
    assert_eq!(redact_error_proxy_auth("tls handshake eof"), "tls handshake eof");
}

#[test]
fn proxy_cache_identity_changes_with_mode_and_address_without_exposing_secrets() {
    let target = url::Url::parse("https://example.com/").unwrap();
    let custom = crate::proxy::Config::for_test("custom", "http://name:{{PASSWORD_pp0rajep}}@127.0.0.1:7897").unwrap();
    let route = ProxyRoute::for_config(&custom, &target);
    let first = client_key(true, "example.com", 443, false, &route);
    assert!(!first.contains("{{PASSWORD_pp0rajep}}"));
    assert_eq!(route.label(), "http://127.0.0.1:7897");
    for config in [crate::proxy::Config::for_test("off", "").unwrap(), crate::proxy::Config::for_test("custom", "http://127.0.0.1:7898").unwrap()] {
        let changed = ProxyRoute::for_config(&config, &target);
        assert_ne!(first, client_key(true, "example.com", 443, false, &changed));
    }
    assert!(!ProxyRoute::for_config(&crate::proxy::Config::for_test("off", "").unwrap(), &target).active);
}

#[tokio::test]
#[ignore = "联网测试：需要 HGHUBX_TEST_MEDIA_URL 为当前有效的媒体地址"]
async fn media_recovers_from_failed_system_dns() {
    let raw = crate::env::var("TEST_MEDIA_URL").expect("HGHUBX_TEST_MEDIA_URL");
    let target = url::Url::parse(&raw).unwrap();
    let host = target.host_str().unwrap();
    let port = target.port_or_known_default().unwrap();
    let failed_client = reqwest::Client::builder()
        .no_proxy()
        .resolve_to_addrs(host, &["127.0.0.1:9".parse().unwrap()])
        .connect_timeout(Duration::from_millis(100))
        .build()
        .unwrap();
    refresh_client();
    CLIENTS.lock().unwrap().insert(
        client_key(crate::network_policy::strict_security(), host, port, false, &ProxyRoute::for_config(&crate::proxy::snapshot(), &target)),
        (Instant::now() + CLIENT_TTL, Arc::new(failed_client)),
    );
    let (_, bytes) = fetch_bytes(&raw).await.expect("备用 DNS 应恢复真实媒体下载");
    assert!(!bytes.is_empty());
    assert!(MEDIA_DNS_ROUTES.lock().unwrap().prefers_public(host, Instant::now()));
    let (_, again) = fetch_bytes(&raw).await.expect("后续请求应复用恢复的路径");
    if bytes.starts_with(b"#EXTM3U") {
        assert!(again.starts_with(b"#EXTM3U"));
    } else {
        assert_eq!(bytes, again);
    }
    if let Some(path) = crate::env::var("TEST_MEDIA_OUTPUT") {
        std::fs::write(path, bytes).unwrap();
    }
}

#[tokio::test]
async fn terminal_errors_do_not_retry_but_transient_failures_can_recover() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    for error in [
        "HTTP 404 Not Found: <html>nginx</html>",
        "HTTP 403 Forbidden",
        "401",
        "禁止访问内网",
        "重定向次数超过限制",
    ] {
        let calls = AtomicUsize::new(0);
        assert!(with_retry(true, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err::<(), _>(error.to_string())
        })
        .await
        .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1, "{error}");
    }
    for error in ["HTTP 503 Service Unavailable", "请求超时"] {
        let calls = AtomicUsize::new(0);
        let value = with_retry(true, || {
            let attempt = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                if attempt == 0 {
                    Err(error.to_string())
                } else {
                    Ok(42)
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(value, 42);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}

#[test]
fn api_operation_labels_exclude_user_input() {
    for (path, expected) in [
        ("/api/videos?page=1&size=10", "feed"),
        ("/api/videos/category/private?x=secret", "category"),
        ("/api/videos/42/play?ep=1", "play"),
        ("/api/search?q=private-search", "search"),
        ("/api/account/loginByPassword", "account"),
        ("/unknown/private", "other"),
    ] {
        assert_eq!(edge_operation(path), expected);
    }
}

#[tokio::test]
async fn non_idempotent_operations_are_attempted_once() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    for (retry, expected) in [(false, 1), (true, 3)] {
        let calls = AtomicUsize::new(0);
        let result = with_retry(retry, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err::<(), _>("rejected".to_string())
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), expected);
    }
}

#[test]
fn pinned_clients_expire_without_extending_the_dns_ttl() {
    let now = Instant::now();
    let client = Arc::new(reqwest::Client::new());
    let mut cache = ClientCache::new();
    cache.insert(
        "true:example.com:443".into(),
        (now + CLIENT_TTL, client.clone()),
    );
    assert!(Arc::ptr_eq(
        &cached_client(
            &cache,
            "true:example.com:443",
            now + Duration::from_secs(29)
        )
        .unwrap(),
        &client
    ));
    assert!(cached_client(&cache, "true:example.com:443", now + CLIENT_TTL).is_none());
    assert!(cached_client(&cache, "false:example.com:443", now).is_none());
    assert!(cached_client(&cache, "true:example.com:8443", now).is_none());
}

#[test]
fn edge_redirects_only_replay_anonymous_reads() {
    let current = url::Url::parse("https://huangguoai.ai/api/edge/request").unwrap();
    assert_eq!(
        edge_redirect_target(
            &current,
            301,
            "https://huangguoai.com/api/edge/request",
            true
        )
        .unwrap()
        .host_str(),
        Some("huangguoai.com")
    );
    assert!(edge_redirect_target(&current, 302, "/next", true).is_ok());
    for status in [301, 302, 303, 307, 308] {
        assert!(edge_redirect_target(&current, status, "/next", false).is_err());
    }
    for status in [307, 308] {
        assert!(edge_redirect_target(&current, status, "/next", true).is_err());
    }
    assert!(edge_redirect_target(&current, 301, "http://example.com/", true).is_err());
    assert!(edge_redirect_target(&current, 301, "https://127.0.0.1/", true).is_err());
}

#[test]
fn proxy_credentials_and_query_are_redacted() {
    assert_eq!(
        redact_proxy("http://alice:p%40ss@127.0.0.1:7897/path?token=secret#hidden"),
        "http://127.0.0.1:7897"
    );
    assert_eq!(
        redact_proxy("socks5://alice:secret@[::1]:1080"),
        "socks5://[::1]:1080"
    );
    for raw in ["alice:secret@127.0.0.1:7897", "not a url secret", ""] {
        assert_eq!(redact_proxy(raw), "[已配置，原始值已隐藏]");
    }
}

#[test]
fn base_requires_https_origin_and_auth_trust_is_static() {
    assert_eq!(
        normalize_base("https://HUANGGUOAI.COM:443/"),
        Some(DEFAULT_BASE.into())
    );
    for raw in [
        "http://huangguoai.com",
        "https://user:pass@huangguoai.com",
        "https://huangguoai.com/path",
        "https://huangguoai.com/?secret=1",
        "https://huangguoai.com/#fragment",
        "https://192.168.1.1",
    ] {
        assert_eq!(normalize_base(raw), None, "{raw}");
    }
    assert!(trusted_auth_origin(DEFAULT_BASE));
    // huangguoai.ai is a navigation landing page (API returns nginx 404);
    // it is not an API line and must not carry credential trust.
    assert!(!trusted_auth_origin("https://huangguoai.ai"));
    assert!(!trusted_auth_origin("https://mirror.example"));
    assert!(!trusted_auth_origin("https://huangguoai.com.evil.example"));
}

#[test]
fn saved_line_is_restored_without_granting_credential_trust() {
    assert_eq!(
        persisted_base(r#"{"base":"https://legacy-mirror.invalid/"}"#),
        Some("https://legacy-mirror.invalid".into())
    );
    assert!(!trusted_auth_origin("https://legacy-mirror.invalid"));
    assert_eq!(persisted_base(r#"{"base":"https://huangguoai.com/"}"#), Some(DEFAULT_BASE.into()));
    for raw in [
        "invalid",
        r#"{"base":123}"#,
        r#"{"base":"http://example.com"}"#,
        r#"{"base":"https://localhost"}"#,
        r#"{"base":"https://192.168.1.1"}"#,
        r#"{"base":"https://example.com/path"}"#,
    ] {
        assert_eq!(persisted_base(raw), None, "{raw}");
    }
}

#[test]
fn custom_line_consent_only_survives_explicit_v2_configuration() {
    for raw in [
        r#"{"base":"https://mirror.fixture.invalid","custom":true}"#,
        r#"{"v":1,"base":"https://mirror.fixture.invalid","custom":true}"#,
        r#"{"v":2,"base":"https://mirror.fixture.invalid"}"#,
        r#"{"v":2,"base":"https://mirror.fixture.invalid","custom":false}"#,
    ] {
        let config = persisted_line(raw).unwrap();
        assert_eq!(config.base, "https://mirror.fixture.invalid");
        assert!(!config.custom);
    }
    assert!(persisted_line(r#"{"v":2,"base":"https://mirror.fixture.invalid/","custom":true}"#).unwrap().custom);
    assert!(!persisted_line(r#"{"v":2,"base":"https://huangguoai.com","custom":true}"#).unwrap().custom);
}

#[test]
fn custom_line_round_trip_and_failed_save_preserve_previous_selection() {
    let dir = std::env::temp_dir().join(format!("hghubx-line-save-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("line.json");
    let next = LineConfig { base: "https://mirror.fixture.invalid".into(), custom: true };
    let mut current = LineConfig::default();
    save_line(&mut current, next.clone(), Some(&path)).unwrap();
    assert_eq!(persisted_line(&std::fs::read_to_string(&path).unwrap()), Some(next.clone()));
    let failed_path = dir.join("missing").join("line.json");
    assert!(save_line(&mut current, LineConfig::default(), Some(&failed_path)).is_err());
    assert_eq!(current, next);
    assert_eq!(persisted_line(&std::fs::read_to_string(&path).unwrap()), Some(next));
    save_line(&mut current, LineConfig::default(), Some(&path)).unwrap();
    assert_eq!(persisted_line(&std::fs::read_to_string(&path).unwrap()), Some(LineConfig::default()));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn untrusted_origins_reject_credentials_before_network() {
    for (path, body, token) in [
        (
            "/api/account/loginByPassword",
            Some(json!({"password":"secret"})),
            None,
        ),
        (
            "/api/account/registerByPassword",
            Some(json!({"password":"secret"})),
            None,
        ),
        ("/api/videos", None, Some("secret-token")),
    ] {
        let err = edge("https://mirror.invalid", "POST", path, body, token)
            .await
            .unwrap_err();
        assert!(err.contains("镜像线路仅供游客浏览"));
    }
}

#[tokio::test]
async fn private_get_is_rejected_before_network() {
    let err = get(
        "http://127.0.0.1:1/private",
        Duration::from_secs(1),
        None,
        None,
    )
    .await
    .unwrap_err();
    assert!(err.contains("禁止访问"));
}
