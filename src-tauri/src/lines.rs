//! 线路（数据源）：固定线路 + 地址发布页上的镜像线路。
//!
//! 上游只是域名在变，请求链路与数据模型完全一致，所以「切线路」等价于换 `net::base()`。
//! 镜像地址来自 <https://huangguoai.pages.dev/>：那个页面本身是空壳，真正的清单在
//! `publish.js` 里（`var urls` 域名数组 + `var subdomains` 子域数组，页面自己随机拼）。

use serde_json::{json, Value};
use std::sync::RwLock;
use std::time::{Duration, Instant};

/// 固定线路：写死在客户端里，不依赖任何外部页面。
pub const FIXED: [(&str, &str); 1] = [
    ("固定线路 1", "https://huangguoai.com"),
];

const PUBLISH_PAGE: &str = "https://huangguoai.pages.dev/";
/// 推荐镜像源：这个页面每次打开都会重挑线路，正好当「推荐镜像组」的来源。
const RECOMMEND_PAGE: &str = "https://huangguoai.ai/";
/// 推荐页里会出现、但不是站点本体的域名（地址发布页 / 下载站 / 图床 / 统计 / 跳转）。
const NOT_SITE: [&str; 11] = [
    "pages.dev",
    "huangguoai.ai",
    "huangguoai.com",
    "huangguoju.com",
    "gvsnzgbim.cc",
    "hgai12.com",
    "drleao.cn",
    "googletagmanager.com",
    "cloudfront.net",
    "t.me",
    "x.com",
];
/// 镜像列表上限（子域 × 域名是笛卡尔积，界面只展示这么多）
const MIRROR_MAX: usize = 60;
/// 单条线路探测超时
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// 发布页推荐过的镜像 origin。严格模式下只有这些镜像允许携带凭据。
///
/// 国内只能走镜像，而镜像与主站同一后端；不认它们的话，切过去之后
/// 已登录用户的每个带 token 请求都会被挡成「镜像线路仅供游客浏览」。
/// 只记录**发布页真的给过的**地址，用户手填的域名不会进这张表。
static TRUSTED_MIRRORS: RwLock<Vec<String>> = RwLock::new(Vec::new());
fn remember_origin(origin: String) {
    let mut list = TRUSTED_MIRRORS.write().unwrap_or_else(|e| e.into_inner());
    if list.len() < 64 && !list.iter().any(|x| x == &origin) {
        list.push(origin);
    }
}
fn remember_mirror(host: &str) {
    if let Some(origin) = crate::net::normalize_base(&format!("https://{host}")) {
        remember_origin(origin);
    }
}
/// 记下「选定的线路」本身。上次选过的线路要落盘、重启后还要能带 token，
/// 所以这里也信任它一次。
pub fn remember_line(url: &str) {
    if let Some(origin) = crate::net::normalize_base(url) {
        remember_origin(origin);
    }
}
/// 这个 origin 是不是发布页推荐过的镜像。
pub fn is_trusted_mirror(origin: &str) -> bool {
    TRUSTED_MIRRORS
        .read()
        .map(|l| l.iter().any(|x| x == origin))
        .unwrap_or(false)
}
pub fn fixed() -> Value {
    json!(FIXED
        .iter()
        .map(|(name, url)| json!({ "name": name, "url": url }))
        .collect::<Vec<_>>())
}

/// 拉地址发布页 → 解析 publish.js → 拼出镜像地址。只在用户点开「线路」时调用。
pub async fn mirrors() -> Result<Value, String> {
    let html = get_text_within(PUBLISH_PAGE, PAGE_TIMEOUT).await?;
    let js_rel = script_src(&html).unwrap_or_else(|| "publish.js".to_string());
    let js_url = absolute(PUBLISH_PAGE, &js_rel);
    let js = get_text_within(&js_url, PAGE_TIMEOUT).await?;

    let domains = js_array(&js, "var urls");
    let subs = js_array(&js, "var subdomains");
    if domains.is_empty() {
        return Err("地址发布页格式有变化：没找到镜像域名".to_string());
    }

    let mut items: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    'outer: for domain in domains {
        let domain = domain.trim_end_matches('/').to_string();
        if domain.is_empty() {
            continue;
        }
        let hosts: Vec<String> = if subs.is_empty() {
            vec![domain.clone()]
        } else {
            subs.iter().map(|s| format!("{s}.{domain}")).collect()
        };
        for host in hosts {
            if !seen.insert(host.clone()) {
                continue;
            }
            items.push(json!({ "url": format!("https://{host}"), "host": host }));
            remember_mirror(&host);
            if items.len() >= MIRROR_MAX {
                break 'outer;
            }
        }
    }
    if items.is_empty() {
        return Err("地址发布页里没有可用的镜像地址".to_string());
    }

    let mut recommended = match tokio::time::timeout(RECOMMEND_TIMEOUT, recommend()).await {
        Ok(list) => list,
        Err(_) => Vec::new(),
    };
    // 发布页每次给的子域都不一样（服务端随机拼），自动选线选中的那条
    // 往往不在这一批里。把当前线路补到最前面，用户一眼能看到「我正走这条」。
    let current = crate::net::base();
    if let Some(host) = url::Url::parse(&current)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
    {
        if !recommended
            .iter()
            .any(|v| v.get("url").and_then(Value::as_str) == Some(current.as_str()))
        {
            recommended.insert(0, json!({ "url": current, "host": host }));
        }
    }
    Ok(json!({
        "source": PUBLISH_PAGE,
        "script": js_url,
        "items": items,
        "recommended_source": RECOMMEND_PAGE,
        "recommended": recommended,
    }))
}

/// 推荐镜像组：抓推荐源页面，取页面上挂出的站点域名。
/// 只由 `mirrors()` 调用；条目结构与 `items` 完全一致，顺序保持页面自己的排列。
async fn recommend() -> Vec<Value> {
    let Ok(html) = get_text(RECOMMEND_PAGE).await else {
        return Vec::new();
    };

    let mut items: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for host in href_hosts(&html) {
        if NOT_SITE.iter().any(|bad| host.ends_with(*bad)) {
            continue;
        }
        if !seen.insert(host.clone()) {
            continue;
        }
        items.push(json!({ "url": format!("https://{host}"), "host": host }));
        remember_mirror(&host);
        if items.len() >= MIRROR_MAX {
            break;
        }
    }
    items
}

/// 从 HTML 里取出 `href="https://<host>/…"` 的 host（去重交给调用方）。
fn href_hosts(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find("href=\"https://") {
        let after = &rest[i + 14..];
        let end = after.find('"').unwrap_or(after.len());
        let host = after[..end]
            .split('/')
            .next()
            .unwrap_or_default()
            .split('?')
            .next()
            .unwrap_or_default();
        if !host.is_empty() {
            out.push(host.to_string());
        }
        rest = &after[end..];
    }
    out
}

/// 可达性探测（并发 6 条一组）。只报结果，不做自动切换。
pub async fn probe(urls: Vec<String>) -> Value {
    let mut out: Vec<Value> = Vec::new();
    for chunk in urls.chunks(6) {
        let mut handles = Vec::new();
        for u in chunk {
            let u = u.clone();
            handles.push(tokio::spawn(async move { probe_one(u).await }));
        }
        for h in handles {
            if let Ok(v) = h.await {
                out.push(v);
            }
        }
    }
    json!(out)
}

async fn probe_one(url: String) -> Value {
    let target = format!("{}/", url.trim_end_matches('/'));
    let started = Instant::now();
    let res = crate::net::get(
        &target,
        PROBE_TIMEOUT,
        Some("text/html,application/xhtml+xml"),
        None,
    )
    .await;
    let ms = started.elapsed().as_millis() as u64;
    match res {
        Ok(r) => {
            let status = r.status().as_u16();
            json!({ "url": url, "ok": status < 400, "status": status, "ms": ms })
        }
        Err(e) => json!({ "url": url, "ok": false, "ms": ms, "error": e }),
    }
}

/* ───────────────────────── 自动选线 ───────────────────────── */

/// 自动选线的主站候选。
///
/// 国内基本连不上 `.com`，不通时用推荐页上挂的镜像（见 [`auto_pick`]）。
/// `.ai` 不再是候选：它只是落地页，`/api` 全 404，切过去用户看到的是
/// 「首页能开、内容全空」，比明确报错更难排查。
pub const AUTO_LINES: [(&str, &str); 1] = [("main", crate::net::DEFAULT_BASE)];
/// 判活就打这一个请求，成本等于 ping：能返回 200 就是这条线路能用。
const AUTO_PROBE_PATH: &str = "/api/videos?page=1&size=1";
/// 探测超时：只在启动/换网时用，等太久不如直接用另一条。
const AUTO_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// 抓「推荐页」的上限：连推荐页都打不开时，选线要能快速给结论，不能拖十几秒。
const RECOMMEND_TIMEOUT: Duration = Duration::from_secs(6);
/// 抓地址发布页 / publish.js 的上限：用户点开「线路」面板时就在这等。
const PAGE_TIMEOUT: Duration = Duration::from_secs(8);
/// 镜像最多探这么多条，够挑出快的了
const AUTO_MIRROR_MAX: usize = 10;

/// 一条候选线路的探测结果。
#[derive(Clone)]
pub struct Hit {
    pub tier: &'static str,
    pub url: String,
    pub ok: bool,
    pub reachable: bool,
    pub ms: u64,
    pub status: Option<u16>,
}

impl Hit {
    fn json(&self) -> Value {
        json!({
            "tier": self.tier,
            "url": self.url,
            "ok": self.ok,
            "reachable": self.reachable,
            "ms": self.ms,
            "status": self.status,
        })
    }
}

async fn probe_hit(tier: &'static str, url: &str) -> Hit {
    let target = format!("{}{}", url.trim_end_matches('/'), AUTO_PROBE_PATH);
    let started = Instant::now();
    let res = crate::net::get(&target, AUTO_PROBE_TIMEOUT, Some("application/json"), None).await;
    let ms = started.elapsed().as_millis() as u64;
    match res {
        Ok(r) => {
            let status = r.status().as_u16();
            Hit {
                tier,
                url: url.to_string(),
                // 只看接口：首页 200 不代表能用（.ai 就是 200 + /api 全 404）
                ok: status == 200,
                reachable: status < 500,
                ms,
                status: Some(status),
            }
        }
        Err(_) => Hit {
            tier,
            url: url.to_string(),
            ok: false,
            reachable: false,
            ms,
            status: None,
        },
    }
}

/// 自动选线：ping 一次主站，不通就用推荐页上挂的镜像。
///
/// ping = 一次 `GET /api/videos?page=1&size=1`，成本跟 ICMP 差不多。
/// 只看首页不够：`.ai` 首页 200，但它只是落地页，`/api` 全 404。
///
/// 主站和镜像全都不通时返回 `reason = "all-down"` 且 `base` 为空 —— **不切线路**。
/// 以前这里会盲切到 `.ai`（`ms = 0`），用户看到的是「首页能开、内容全空」，
/// 比直接提示「线路全部不可用」更难排查。
pub async fn auto_pick() -> Value {
    let (main_tier, main_url) = AUTO_LINES[0];

    let main_hit = probe_hit(main_tier, main_url).await;
    if main_hit.ok {
        return json!({
            "base": main_url,
            "tier": main_tier,
            "ms": main_hit.ms,
            "reason": "main-ok",
            "candidates": [main_hit.json()],
        });
    }

    // 主站不通（国内）：用它推荐页上挂的镜像。推荐页自己也可能是超时的，
    // 给个上限，别让一次选线拖十几秒还没结论。
    let mirrors = match tokio::time::timeout(RECOMMEND_TIMEOUT, recommend()).await {
        Ok(list) => list,
        Err(_) => Vec::new(),
    };
    let mut urls: Vec<String> = mirrors
        .iter()
        .filter_map(|v| v.get("url").and_then(Value::as_str).map(str::to_string))
        .take(AUTO_MIRROR_MAX)
        .collect();
    urls.dedup();
    let mut handles = Vec::new();
    for u in urls {
        handles.push(tokio::spawn(async move { probe_hit("mirror", &u).await }));
    }
    let mut hits = vec![main_hit.clone()];
    for h in handles {
        if let Ok(hit) = h.await {
            hits.push(hit);
        }
    }
    hits.sort_by_key(|h| (!h.ok, h.ms));
    let candidates: Vec<Value> = hits.iter().map(Hit::json).collect();
    if let Some(h) = hits.first().filter(|h| h.ok) {
        return json!({
            "base": h.url,
            "tier": h.tier,
            "ms": h.ms,
            "reason": "mirror-fallback",
            "candidates": candidates,
        });
    }
    // 全都不通：保持当前线路不动，把「全都不可用」这个结论交给前端提示。
    json!({
        "base": "",
        "tier": "",
        "ms": 0,
        "reason": "all-down",
        "candidates": candidates,
    })
}
/// 只在「当前走的不是主站」时用：探一次主站，通了就切回，不通保持原状。
///
/// 比 [`auto_pick`] 便宜得多——不抓发布页、不并发探镜像，就一个请求。
/// 解决的是「挂着代理却一直待在镜像上」：镜像自己也是通的，体检看不出任何问题，
/// 只有主动敲一下主站，才知道现在能不能回去。
pub async fn try_main() -> Value {
    let (tier, url) = AUTO_LINES[0];
    let hit = probe_hit(tier, url).await;
    json!({
        "ok": hit.ok,
        "base": hit.url,
        "tier": tier,
        "ms": hit.ms,
        "status": hit.status,
    })
}
/// 判活「当前线路」：和 [`auto_pick`] 用同一个请求（`/api/videos?page=1&size=1`）。
///
/// 只看首页不行——`.ai` 首页 200、`/api` 全 404，首页判活会把体检结论骗成「通」，
/// 于是坏线路一直不被换掉。这里探的是真接口，通就是真能出内容。
pub async fn health() -> Value {
    let current = crate::net::base();
    let hit = probe_hit("current", &current).await;
    json!({
        "base": current,
        "ok": hit.ok,
        "ms": hit.ms,
        "status": hit.status,
    })
}
async fn get_text(url: &str) -> Result<String, String> {
    let resp = crate::net::get(url, Duration::from_secs(12), None, None).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.text().await.map_err(|e| crate::net::err_text(&e))
}

/// 带超时的 [`get_text`]：12 秒对外面页面太宽容了——用户点开「线路」面板时
/// 就在这一步等着，页面挂掉会让人以为整个应用卡死。
async fn get_text_within(url: &str, limit: Duration) -> Result<String, String> {
    match tokio::time::timeout(limit, get_text(url)).await {
        Ok(r) => r,
        Err(_) => Err("请求超时".to_string()),
    }
}

/// 从 HTML 里挑出脚本地址（发布页只有一个 `publish.js?<版本>`）。
fn script_src(html: &str) -> Option<String> {
    let mut rest = html;
    while let Some(i) = rest.find("src=\"") {
        let after = &rest[i + 5..];
        let end = after.find('"')?;
        let candidate = &after[..end];
        if candidate.contains(".js") {
            return Some(candidate.to_string());
        }
        rest = &after[end..];
    }
    None
}

fn absolute(base: &str, rel: &str) -> String {
    if rel.starts_with("http://") || rel.starts_with("https://") {
        return rel.to_string();
    }
    let origin = url::Url::parse(base)
        .ok()
        .map(|u| format!("{}://{}", u.scheme(), u.host_str().unwrap_or_default()));
    match origin {
        Some(o) if rel.starts_with('/') => format!("{o}{rel}"),
        Some(o) => format!("{o}/{rel}"),
        None => rel.to_string(),
    }
}

/// 取 JS 里 `var <name> = [ ... ]` 的字符串数组（去掉行尾 `//` 注释，但保留字符串里的 `//`）。
fn js_array(src: &str, decl: &str) -> Vec<String> {
    let Some(at) = src.find(decl) else {
        return Vec::new();
    };
    let rest = &src[at..];
    let Some(open) = rest.find('[') else {
        return Vec::new();
    };
    let Some(close) = rest[open..].find(']') else {
        return Vec::new();
    };
    strip_line_comments(&rest[open + 1..open + close])
        .split(',')
        .map(|raw| {
            raw.trim()
                .trim_matches(|c: char| c == '\'' || c == '"')
                .trim()
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// 去掉 `//` 行尾注释（引号内的 `//` 是 URL，不能动）。
fn strip_line_comments(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut quote: Option<char> = None;
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some(q) => {
                out.push(c);
                if c == q {
                    quote = None;
                }
            }
            None => {
                if c == '\'' || c == '"' {
                    quote = Some(c);
                    out.push(c);
                } else if c == '/' && chars.peek() == Some(&'/') {
                    for n in chars.by_ref() {
                        if n == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                } else {
                    out.push(c);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
var subdomains = [
    'thu',  // 清华
    'pku',  // 北大
];
var urls=[
	'xxbgwypx.cc/',
];
var otherUrls = [
	'https://huangguoai.pages.dev',
];
var foreverUrls = [
	  'https://huangguoai.com',
	JumpPage,
	'https://huangguoai.ai',
];
"#;

    #[test]
    fn parses_publish_js_arrays() {
        assert_eq!(js_array(SAMPLE, "var urls"), vec!["xxbgwypx.cc/"]);
        assert_eq!(js_array(SAMPLE, "var subdomains"), vec!["thu", "pku"]);
        assert_eq!(
            js_array(SAMPLE, "var foreverUrls"),
            vec![
                "https://huangguoai.com",
                "JumpPage",
                "https://huangguoai.ai"
            ]
        );
    }

    #[test]
    fn resolves_relative_script() {
        assert_eq!(
            absolute("https://huangguoai.pages.dev/", "publish.js?20261103-2"),
            "https://huangguoai.pages.dev/publish.js?20261103-2"
        );
        assert_eq!(
            absolute("https://huangguoai.pages.dev/", "/a/b.js"),
            "https://huangguoai.pages.dev/a/b.js"
        );
    }

    #[test]
    fn picks_script_src() {
        let html = r#"<link rel="stylesheet" href="publish.css?1" /><script type="text/javascript" src="publish.js?20261103-2"></script>"#;
        assert_eq!(script_src(html).as_deref(), Some("publish.js?20261103-2"));
    }

    #[test]
    fn extracts_href_hosts() {
        let html = r#"<a href="https://gnpra.adihsppe.cc/ai-huanlian/">a</a><a href="https://huangguoai.com/terms/?x=1">b</a><a href="https://t.me/huangguofans">c</a>"#;
        assert_eq!(
            href_hosts(html),
            vec!["gnpra.adihsppe.cc", "huangguoai.com", "t.me"]
        );
    }

    /// 手动跑：`cargo test --lib -- --ignored lines::tests::mirrors_live -- --nocapture`
    #[tokio::test]
    #[ignore = "联网测试：请求上游镜像列表，手动用 --ignored 运行"]
    async fn mirrors_live() {
        match mirrors().await {
            Ok(v) => println!("{}", serde_json::to_string_pretty(&v).expect("json")),
            Err(e) => panic!("mirrors failed: {e}"),
        }
    }

    /// 手动跑：`cargo test --lib -- --ignored lines::tests::probe_live -- --nocapture`
    #[tokio::test]
    #[ignore = "联网测试：探测上游线路连通性，手动用 --ignored 运行"]
    async fn probe_live() {
        let urls = vec![
            "https://huangguoai.com".to_string(),
            "https://huangguoai.ai".to_string(),
            "https://thu.xxbgwypx.cc".to_string(),
        ];
        println!(
            "{}",
            serde_json::to_string_pretty(&probe(urls).await).expect("json")
        );
    }
}
