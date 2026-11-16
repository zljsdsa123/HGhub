//! 与 reqwest 的系统代理匹配规则保持一致；iOS 仅匹配进程代理环境变量，VPN/TUN 由系统接管。
use hyper_util::client::proxy::matcher::Matcher;

pub(crate) fn routes_target(matcher: &Matcher, target: &str) -> bool {
    target
        .parse::<tauri::http::Uri>()
        .ok()
        .is_some_and(|uri| matcher.intercept(&uri).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_proxy_requires_a_route_for_the_target_scheme() {
        let http_only = Matcher::builder().http("127.0.0.1:7890").build();
        assert!(routes_target(&http_only, "http://example.com/video"));
        assert!(!routes_target(&http_only, "https://example.com/video"));
        let https_only = Matcher::builder().https("127.0.0.1:7890").build();
        assert!(!routes_target(&https_only, "http://example.com/video"));
        assert!(routes_target(&https_only, "https://example.com/video"));
    }

    #[test]
    fn apple_proxy_honors_no_proxy_rules() {
        let matcher = Matcher::builder()
            .https("127.0.0.1:7890")
            .no("direct.example,192.168.0.0/16")
            .build();
        for target in [
            "https://direct.example/",
            "https://cdn.direct.example/video",
            "https://192.168.1.2/",
        ] {
            assert!(!routes_target(&matcher, target), "{target}");
        }
        assert!(routes_target(&matcher, "https://example.com/"));
    }

    #[test]
    fn apple_proxy_rejects_missing_or_invalid_routes() {
        for matcher in [
            Matcher::builder().build(),
            Matcher::builder().https("").build(),
            Matcher::builder().https("not a proxy").build(),
            Matcher::builder().https("ftp://127.0.0.1:7890").build(),
        ] {
            assert!(!routes_target(&matcher, "https://example.com/video"));
        }
    }

    #[test]
    fn apple_proxy_allows_an_explicit_socks_route() {
        let matcher = Matcher::builder().all("socks5h://127.0.0.1:1080").build();
        assert!(routes_target(&matcher, "https://example.com/video"));
        assert!(routes_target(&matcher, "http://example.com/video"));
    }

    #[test]
    fn apple_proxy_accepts_a_proxy_host_without_a_port() {
        let matcher = Matcher::builder().https("proxy.example").build();
        assert!(routes_target(&matcher, "https://example.com/video"));
    }

    #[test]
    fn apple_proxy_rejects_invalid_targets() {
        let matcher = Matcher::builder().all("127.0.0.1:7890").build();
        for target in ["", "invalid target", "example.com", "hg://localhost/video"] {
            assert!(!routes_target(&matcher, target), "{target}");
        }
    }
}
