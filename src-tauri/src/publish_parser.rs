//! Stateless HTML and JS-as-data parser for upstream address publish pages.
//!
//! Publisher scripts are lexed and parsed strictly as literal string arrays;
//! remote JavaScript is never executed.

use dom_query::Document;
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) const MIRROR_MAX: usize = 60;
const PUBLISH_ARRAY_MAX: usize = 256;

#[derive(Debug, PartialEq)]
enum JsToken<'a> {
    Ident(&'a str),
    Quoted(&'a str),
    Symbol(u8),
    Other,
}

/// A conservative lexer: comments, strings, templates and regular expressions
/// cannot introduce declarations. No remote JavaScript is ever evaluated.
fn js_tokens(source: &str) -> Result<Vec<JsToken<'_>>, String> {
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        if byte.is_ascii_whitespace() {
            at += 1;
            continue;
        }
        if bytes[at..].starts_with(b"//") {
            at += 2;
            while at < bytes.len() && bytes[at] != 10 {
                at += 1;
            }
            continue;
        }
        if bytes[at..].starts_with(b"/*") {
            at += 2;
            let Some(end) = source[at..].find("*/") else {
                return Err("发布脚本注释未闭合".into());
            };
            at += end + 2;
            continue;
        }
        if matches!(byte, 39 | 34 | 96) {
            let start = at;
            at += 1;
            while at < bytes.len() && bytes[at] != byte {
                if bytes[at] == 92 {
                    at += 1;
                }
                at += 1;
            }
            if at >= bytes.len() {
                return Err("发布脚本字符串未闭合".into());
            }
            at += 1;
            out.push(if byte == 96 {
                JsToken::Other
            } else {
                JsToken::Quoted(&source[start..at])
            });
            continue;
        }
        // Division is deliberately treated as a regex as well. Publisher data
        // requires no arithmetic; ambiguous input therefore fails closed.
        if byte == b'/' {
            at += 1;
            let mut in_class = false;
            while at < bytes.len() {
                match bytes[at] {
                    92 => {
                        at += 2;
                        continue;
                    }
                    b'[' => in_class = true,
                    b']' => in_class = false,
                    b'/' if !in_class => break,
                    10 | 13 => return Err("发布脚本包含不支持的表达式".into()),
                    _ => {}
                }
                at += 1;
            }
            if at >= bytes.len() {
                return Err("发布脚本表达式未闭合".into());
            }
            at += 1;
            while at < bytes.len() && bytes[at].is_ascii_alphabetic() {
                at += 1;
            }
            out.push(JsToken::Other);
            continue;
        }
        if byte.is_ascii_alphabetic() || matches!(byte, b'_' | b'$') {
            let start = at;
            at += 1;
            while at < bytes.len()
                && (bytes[at].is_ascii_alphanumeric() || matches!(bytes[at], b'_' | b'$'))
            {
                at += 1;
            }
            out.push(JsToken::Ident(&source[start..at]));
        } else {
            out.push(JsToken::Symbol(byte));
            at += 1;
        }
    }
    Ok(out)
}

fn js_string(raw: &str) -> Result<String, String> {
    let mut result = String::new();
    let mut chars = raw[1..raw.len() - 1].chars();
    while let Some(ch) = chars.next() {
        if ch != char::from(92) {
            if ch.is_control() {
                return Err("镜像字符串含控制字符".into());
            }
            result.push(ch);
            continue;
        }
        match chars.next() {
            Some(ch) if matches!(ch as u32, 92 | 39 | 34 | 47) => result.push(ch),
            Some('x') => {
                let code: String = chars.by_ref().take(2).collect();
                let byte = u8::from_str_radix(&code, 16)
                    .ok()
                    .filter(|_| code.len() == 2)
                    .ok_or("镜像字符串转义无效")?;
                result.push(char::from(byte));
            }
            Some('u') => {
                let code: String = chars.by_ref().take(4).collect();
                let number = u32::from_str_radix(&code, 16)
                    .ok()
                    .filter(|_| code.len() == 4)
                    .ok_or("镜像字符串转义无效")?;
                result.push(char::from_u32(number).ok_or("镜像字符串转义无效")?);
            }
            _ => return Err("镜像字符串含不支持的转义".into()),
        }
    }
    Ok(result)
}

/// Only literal top-level var/let/const arrays are accepted. Malformed
/// subdomains must not fall back to trusting the bare domains.
pub(crate) fn js_array(source: &str, name: &str) -> Result<Option<Vec<String>>, String> {
    let tokens = js_tokens(source)?;
    let mut depth = 0usize;
    let mut result = None;
    for (at, token) in tokens.iter().enumerate() {
        let declaration = matches!(token, JsToken::Ident("var" | "let" | "const"));
        if depth == 0 && declaration && tokens.get(at + 1) == Some(&JsToken::Ident(name)) {
            if result.is_some() {
                return Err(format!("发布脚本重复声明 {name}"));
            }
            if tokens.get(at + 2) != Some(&JsToken::Symbol(b'='))
                || tokens.get(at + 3) != Some(&JsToken::Symbol(b'['))
            {
                return Err(format!("发布脚本的 {name} 必须是字符串数组"));
            }
            let mut cursor = at + 4;
            let mut values = Vec::new();
            while tokens.get(cursor) != Some(&JsToken::Symbol(b']')) {
                let Some(JsToken::Quoted(raw)) = tokens.get(cursor) else {
                    return Err(format!("发布脚本的 {name} 含非字符串值"));
                };
                if values.len() >= PUBLISH_ARRAY_MAX {
                    return Err(format!("{name} exceeds the publisher array size limit"));
                }
                values.push(js_string(raw)?);
                cursor += 1;
                match tokens.get(cursor) {
                    Some(JsToken::Symbol(b',')) => cursor += 1,
                    Some(JsToken::Symbol(b']')) => {}
                    _ => return Err(format!("发布脚本的 {name} 数组格式无效")),
                }
            }
            if !matches!(tokens.get(cursor + 1), None | Some(JsToken::Symbol(b';'))) {
                return Err(format!("发布脚本的 {name} 不能使用动态表达式"));
            }
            result = Some(values);
        }
        match token {
            JsToken::Symbol(b'{' | b'(' | b'[') => depth += 1,
            JsToken::Symbol(b'}' | b')' | b']') => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(result)
}

pub(crate) fn parse_mirrors(js: &str) -> Result<Vec<Value>, String> {
    let domains = js_array(js, "urls")?.unwrap_or_default();
    let subs = js_array(js, "subdomains")?.unwrap_or_default();
    if domains.is_empty() {
        return Err("发布脚本中没有找到镜像域名".into());
    }
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    'domains: for domain in domains {
        let domain = domain.trim().trim_end_matches('/').to_ascii_lowercase();
        if !valid_dns_name(&domain) {
            continue;
        }
        let hosts: Vec<_> = if subs.is_empty() {
            vec![domain]
        } else {
            subs.iter()
                .filter_map(|sub| {
                    let sub = sub.trim().to_ascii_lowercase();
                    valid_dns_label(&sub).then(|| format!("{sub}.{domain}"))
                })
                .collect()
        };
        for host in hosts {
            if !valid_dns_name(&host) || !seen.insert(host.clone()) {
                continue;
            }
            let Some(origin) = crate::net::normalize_base(&format!("https://{host}")) else {
                continue;
            };
            items.push(json!({ "url": origin, "host": host }));
            if items.len() >= MIRROR_MAX {
                break 'domains;
            }
        }
    }
    if items.is_empty() {
        Err("发布脚本中没有合法镜像地址".into())
    } else {
        Ok(items)
    }
}

fn valid_dns_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
}

fn valid_dns_name(value: &str) -> bool {
    value.len() <= 253
        && value.contains('.')
        && value.split('.').all(valid_dns_label)
        && !["localhost", "local", "internal", "home.arpa", "huangguoai.ai"]
            .iter()
            .any(|suffix| value == *suffix || value.ends_with(&format!(".{suffix}")))
        && url::Url::parse(&format!("https://{value}"))
            .ok()
            .is_some_and(|parsed| matches!(parsed.host(), Some(url::Host::Domain(_))))
}

pub(crate) fn script_src(page: &str, html: &str) -> Result<String, String> {
    let document = Document::from(html);
    for script in document.select("script[src]").iter() {
        if let Some(src) = script.attr("src") {
            if let Ok(url) = absolute(page, &src) {
                return Ok(url);
            }
        }
    }
    Err("地址发布页没有同源 publish.js 脚本".into())
}

pub(crate) fn absolute(base: &str, relative: &str) -> Result<String, String> {
    if relative.chars().any(char::is_control) {
        return Err("发布脚本地址含控制字符".into());
    }
    let base = url::Url::parse(base).map_err(|_| "发布页地址无效")?;
    let target = base.join(relative.trim()).map_err(|_| "发布脚本地址无效")?;
    if base.scheme() != "https"
        || target.scheme() != "https"
        || target.origin() != base.origin()
        || !target.username().is_empty()
        || target.password().is_some()
        || target.fragment().is_some()
        || target.path().rsplit('/').next() != Some("publish.js")
    {
        return Err("只接受发布页同源的 HTTPS publish.js".into());
    }
    Ok(target.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origins(items: &[Value]) -> Vec<&str> {
        items
            .iter()
            .filter_map(|item| item["url"].as_str())
            .collect()
    }

    #[test]
    fn literal_arrays_support_comments_quotes_and_trailing_commas() {
        let js = r#"/* before */ var urls = ['EXAMPLE.COM/', "two.example",];
          const subdomains = [ 'one', // line comment
          'two', ]; var untouched = 'https://example.com/';"#;
        let items = parse_mirrors(js).unwrap();
        assert_eq!(
            origins(&items),
            [
                "https://one.example.com",
                "https://two.example.com",
                "https://one.two.example",
                "https://two.two.example"
            ]
        );
        assert_eq!(
            js_array("let urls = ['https://host/'];", "urls")
                .unwrap()
                .unwrap(),
            ["https://host/"]
        );
    }

    #[test]
    fn fake_declarations_in_comments_strings_templates_and_regex_are_ignored() {
        for js in [
            r#"// var urls=['bad.example'];"#,
            r#"/* var urls=['bad.example']; */"#,
            r#"const text = "var urls=['bad.example'];";"#,
            r#"const text = `var urls=['bad.example'];`;"#,
            r#"const regex = /var urls=['bad.example'];/;"#,
            r#"var urlsExtra=['bad.example'];"#,
            r#"function notRun() { var urls=['bad.example']; }"#,
        ] {
            assert!(parse_mirrors(js).is_err(), "{js}");
        }
    }

    #[test]
    fn dynamic_or_malformed_arrays_fail_closed_including_subdomains() {
        for js in [
            r#"var urls=['one.example', getHost()];"#,
            r#"var urls=['one.example' + '.evil'];"#,
            r#"var urls=['one.example'].concat(other);"#,
            r#"var urls=['one.example']; var urls=['two.example'];"#,
            r#"var urls=['one.example']; var subdomains=getSubs();"#,
            r#"var urls=['one.example']; var subdomains=['one', 2];"#,
            r#"var urls=['one.example']; /* unfinished"#,
        ] {
            assert!(parse_mirrors(js).is_err(), "{js}");
        }
    }

    #[test]
    fn hostnames_are_canonical_bounded_and_not_paths_or_literal_ips() {
        let items = parse_mirrors(r#"var urls=['Example.COM', 'example.com/', '127.0.0.1', 'localhost', 'x.local', 'x.internal', 'x.home.arpa', 'https://evil.example', 'evil.example/path', 'a.example:443', '-a.example', 'valid.example'];"#).unwrap();
        assert_eq!(
            origins(&items),
            ["https://example.com", "https://valid.example"]
        );
        let js = format!(
            "var urls=[{}];",
            (0..100)
                .map(|n| format!("'host{n}.example'"))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert_eq!(parse_mirrors(&js).unwrap().len(), MIRROR_MAX);
    }

    #[test]
    fn publish_script_is_same_origin_and_exact_filename() {
        let page = crate::lines::PUBLISH_PAGES[0];
        for html in [
            "<script src='publish.js?v=2'></script>",
            "<script src=publish.js></script>",
            r#"<script src='/analytics.js'></script><script src="/publish.js"></script>"#,
        ] {
            let script = script_src(page, html).unwrap();
            assert!(script.starts_with("https://huangguoai.pages.dev/publish.js"));
        }
        for target in [
            "http://huangguoai.pages.dev/publish.js",
            "https://other.example/publish.js",
            "//other.example/publish.js",
            "javascript:publish.js",
            "https://user@huangguoai.pages.dev/publish.js",
            "/publish.js#fragment",
            "/publish.js/extra",
            "/publish.js.evil",
        ] {
            assert!(absolute(page, target).is_err(), "{target}");
        }
        assert!(script_src(page, "<script src='analytics.js'></script>").is_err());
    }
}
