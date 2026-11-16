use dom_query::{Document, Selection};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_ITEMS: usize = 20;
const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

static CACHE_BUST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize, PartialEq, Eq)]
struct HotVideo {
    video_id: i64,
    title: String,
    plays: String,
}

fn normalized_text(selection: Selection<'_>) -> String {
    normalized_string(&selection.text())
}

fn normalized_string(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn video_id_from_href(href: &str) -> Option<i64> {
    let id = href.strip_prefix("/video/")?.strip_suffix('/')?;
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let id = id.parse::<i64>().ok()?;
    (id > 0 && id <= JS_MAX_SAFE_INTEGER).then_some(id)
}

fn parse_items(html: &str) -> Result<Vec<HotVideo>, String> {
    let document = Document::from(html);
    let sections = document.select("section.hg-search-hot");
    if sections.is_empty() {
        return Err("官网搜索页没有找到热搜榜区域".into());
    }

    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for section in sections.iter() {
        for anchor in Selection::from(section).select("a.hg-search-hot__item").iter() {
            let Some(video_id) = anchor
                .attr("href")
                .and_then(|href| video_id_from_href(&href))
            else {
                continue;
            };
            if seen.contains(&video_id) {
                continue;
            }

            let anchor = Selection::from(anchor);
            let title = normalized_text(anchor.select(".hg-search-hot__name"));
            let title = if title.is_empty() {
                anchor
                    .attr("data-search-hot")
                    .map(|title| normalized_string(&title))
                    .unwrap_or_default()
            } else {
                title
            };
            let plays = normalized_text(anchor.select(".hg-search-hot__plays"));
            if title.is_empty() || plays.is_empty() {
                continue;
            }

            seen.insert(video_id);
            items.push(HotVideo {
                video_id,
                title,
                plays,
            });
            if items.len() == MAX_ITEMS {
                return Ok(items);
            }
        }
    }

    if items.is_empty() {
        Err("官网热搜榜没有可用条目".into())
    } else {
        Ok(items)
    }
}

fn cache_bust_value() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = CACHE_BUST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{timestamp}-{sequence}")
}

async fn fetch_html() -> Result<String, String> {
    let base = crate::net::base();
    tokio::time::timeout(REQUEST_TIMEOUT, async {
        let referer = format!("{base}/");
        let url = format!(
            "{}/search/?_hghubx_hot={}",
            base,
            cache_bust_value()
        );
        let mut response = crate::net::get(
            &url,
            REQUEST_TIMEOUT,
            Some("text/html,application/xhtml+xml"),
            Some(&referer),
        )
        .await?;

        if !response.status().is_success() {
            return Err(format!("官网搜索页请求失败（HTTP {}）", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_HTML_BYTES as u64)
        {
            return Err("官网搜索页超过 2 MiB 限制".into());
        }

        let mut html = Vec::with_capacity(response.content_length().unwrap_or(0) as usize);
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            if html.len().saturating_add(chunk.len()) > MAX_HTML_BYTES {
                return Err("官网搜索页超过 2 MiB 限制".into());
            }
            html.extend_from_slice(&chunk);
        }
        String::from_utf8(html).map_err(|_| "官网搜索页不是有效的 UTF-8 HTML".into())
    })
    .await
    .map_err(|_| "获取官网热搜超时（12 秒）".to_string())?
}

pub async fn fetch() -> Result<Value, String> {
    let html = fetch_html()
        .await
        .map_err(|error| format!("获取官网热搜失败：{error}"))?;
    let items =
        parse_items(&html).map_err(|error| format!("获取官网热搜失败：{error}"))?;
    Ok(json!({ "items": items }))
}

#[cfg(test)]
mod tests {
    use super::{parse_items, video_id_from_href, JS_MAX_SAFE_INTEGER};

    #[test]
    fn parses_hot_section_in_dom_order_and_decodes_entities() {
        let html = r#"
            <section class="hg-search-hot">
              <a class="hg-search-hot__item" href="/video/3483/" data-search-hot="fallback">
                <span class="hg-search-hot__name">琼明&nbsp;神女录 &amp; 特别篇</span>
                <span class="hg-search-hot__plays"><img alt="play">1185.1w播放量</span>
              </a>
              <a class="hg-search-hot__item" href="/video/11571/">
                <span class="hg-search-hot__name">第二部</span>
                <span class="hg-search-hot__plays">267.3w播放量</span>
              </a>
            </section>
        "#;

        let items = parse_items(html).unwrap();
        assert_eq!(items[0].video_id, 3483);
        assert_eq!(items[0].title, "琼明 神女录 & 特别篇");
        assert_eq!(items[0].plays, "1185.1w播放量");
        assert_eq!(items[1].video_id, 11571);
    }

    #[test]
    fn falls_back_to_data_title_and_deduplicates_by_video_id() {
        let html = r#"
            <section class="hg-search-hot">
              <a class="hg-search-hot__item" href="/video/7/" data-search-hot="首条 &amp; 实体">
                <span class="hg-search-hot__plays">1.2亿播放量</span>
              </a>
              <a class="hg-search-hot__item" href="/video/7/" data-search-hot="重复条目">
                <span class="hg-search-hot__plays">999播放量</span>
              </a>
            </section>
        "#;

        let items = parse_items(html).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "首条 & 实体");
        assert_eq!(items[0].plays, "1.2亿播放量");
    }

    #[test]
    fn rejects_external_malformed_and_unsafe_ids() {
        assert_eq!(video_id_from_href("https://huangguoai.com/video/1/"), None);
        assert_eq!(video_id_from_href("//huangguoai.com/video/1/"), None);
        assert_eq!(video_id_from_href("/video/0/"), None);
        assert_eq!(video_id_from_href("/video/1/extra/"), None);
        assert_eq!(video_id_from_href("/video/9007199254740992/"), None);
        assert_eq!(video_id_from_href("/video/9007199254740991/"), Some(JS_MAX_SAFE_INTEGER));
    }

    #[test]
    fn ignores_links_outside_hot_section_and_reports_missing_or_empty_sections() {
        let outside = r#"<a class="hg-search-hot__item" href="/video/1/">
            <span class="hg-search-hot__name">外部</span><span class="hg-search-hot__plays">2w</span>
        </a>"#;
        assert_eq!(parse_items(outside).unwrap_err(), "官网搜索页没有找到热搜榜区域");

        let invalid = r#"<section class="hg-search-hot">
            <a class="hg-search-hot__item" href="https://evil.example/video/1/" data-search-hot="外域">
              <span class="hg-search-hot__plays">2w</span>
            </a>
        </section>"#;
        assert_eq!(parse_items(invalid).unwrap_err(), "官网热搜榜没有可用条目");
        assert_eq!(
            parse_items("<section class=\"hg-search-hot\"></section>").unwrap_err(),
            "官网热搜榜没有可用条目"
        );
    }
}
