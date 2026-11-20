//! Upstream lines and mirrors published by the upstream address pages.
//! Publisher scripts are parsed as data; remote JavaScript is never executed.

mod mirror;
mod probe;

#[allow(unused_imports)]
pub use mirror::{fixed, is_fixed, is_trusted_mirror, mirrors, verify_published_origin, FIXED};
#[cfg(test)]
pub(crate) use mirror::PUBLISH_PAGES;
pub(crate) use probe::healthy_video_data;
#[allow(unused_imports)]
pub use probe::{auto_pick, health, probe, try_main, Hit};

#[cfg(test)]
mod tests {
    use super::mirror::{merge_publishers, PublishedPage, FIXED, PUBLISH_PAGES};
    use super::probe::{auto_candidates, healthy_video_data, pick_from_hits, Hit};
    use serde_json::{json, Value};

    fn origins(items: &[Value]) -> Vec<&str> {
        items
            .iter()
            .filter_map(|item| item["url"].as_str())
            .collect()
    }

    fn page(source: &str, hosts: &[&str]) -> Result<PublishedPage, String> {
        Ok(PublishedPage {
            source: source.into(),
            script: format!("{source}publish.js"),
            items: hosts
                .iter()
                .map(|host| json!({"host": host, "url": format!("https://{host}")}))
                .collect(),
        })
    }

    #[test]
    fn publisher_failure_retains_other_success_and_current_is_display_only() {
        let value = merge_publishers(
            [
                Err("timeout".into()),
                page(PUBLISH_PAGES[1], &["a.example"]),
            ],
            "https://restored.example",
        )
        .unwrap();
        assert_eq!(
            origins(value["items"].as_array().unwrap()),
            ["https://a.example"]
        );
        assert_eq!(value["recommended"][0]["url"], "https://restored.example");
        assert_eq!(value["errors"].as_array().unwrap().len(), 1);
        assert!(merge_publishers([Err("first".into()), Err("second".into())], FIXED[0].1).is_err());
    }

    #[test]
    fn publisher_lists_interleave_and_deduplicate() {
        let value = merge_publishers(
            [
                page(PUBLISH_PAGES[0], &["a.example", "c.example"]),
                page(PUBLISH_PAGES[1], &["b.example", "a.example"]),
            ],
            "https://a.example",
        )
        .unwrap();
        assert_eq!(
            origins(value["items"].as_array().unwrap()),
            [
                "https://a.example",
                "https://b.example",
                "https://c.example"
            ]
        );
        assert_eq!(value["recommended"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn health_requires_real_unwrapped_feed_data() {
        let valid = json!({"items": [{"id": 12, "title": "video"}], "pagination": {"page": 1, "pages": 2, "size": 1, "total": 2}});
        assert!(healthy_video_data(&valid));
        assert!(healthy_video_data(
            &json!({"items": [], "pagination": {"page": 1, "pages": 0, "size": 1, "total": 0}})
        ));
        for invalid in [
            Value::Null,
            json!("<html>200 OK</html>"),
            json!({}),
            json!({"status": 0, "msg": "denied"}),
            json!({"status": 1, "data": valid}),
            json!({"items": []}),
            json!({"items": [{}], "pagination": {"page": 1, "pages": 1, "size": 1, "total": 1}}),
        ] {
            assert!(!healthy_video_data(&invalid), "{invalid}");
        }
    }

    fn hit(url: &str, ok: bool, ms: u64) -> Hit {
        Hit {
            tier: "mirror",
            url: url.into(),
            ok,
            reachable: true,
            ms,
            status: Some(200),
            error: None,
        }
    }

    #[test]
    fn all_down_never_returns_a_line_to_switch_to() {
        for hits in [vec![], vec![hit("https://bad.example", false, 1)]] {
            let selected = pick_from_hits(&hits);
            assert_eq!(selected["reason"], "all-down");
            assert_eq!(selected["base"], "");
            assert_eq!(selected["tier"], "none");
        }
        let selected = pick_from_hits(&[
            hit("https://html.example", false, 1),
            hit("https://slow.example", true, 20),
            hit("https://fast.example", true, 8),
        ]);
        assert_eq!(selected["base"], "https://fast.example");
    }

    #[test]
    fn auto_candidates_require_publication_and_exclude_ai_landing_page() {
        let items = [
            // The .ai navigation page must stay out of candidates even if a
            // publish page lists it; it is no longer a fixed line.
            json!({"url": "https://huangguoai.ai"}),
            json!({"url": "https://published.example"}),
            json!({"url": "https://untrusted.example"}),
            json!({"url": "https://published.example"}),
        ];
        let candidates = auto_candidates(&items, "https://restored.example", |origin| {
            origin == "https://published.example"
        });
        assert_eq!(candidates, ["https://published.example"]);
        assert!(auto_candidates(&[], "https://restored.example", |_| true).is_empty());
    }
}
