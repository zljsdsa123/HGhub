use crate::network_policy;
use serde_json::Value;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

pub(crate) const HOST: &str = "dns.alidns.com";
pub(crate) const BOOTSTRAP: [SocketAddr; 2] = [
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(223, 5, 5, 5)), 443),
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(223, 6, 6, 6)), 443),
];
const MAX_RESPONSE_BYTES: usize = 16 * 1024;

#[derive(Default)]
pub(crate) struct Routes(HashMap<String, Instant>);

impl Routes {
    pub(crate) fn prefers_public(&self, host: &str, now: Instant) -> bool {
        self.0.get(host).is_some_and(|expires| now < *expires)
    }

    pub(crate) fn remember(&mut self, host: &str, now: Instant) {
        self.0.retain(|_, expires| now < *expires);
        if self.0.len() >= 64 {
            self.0.clear();
        }
        self.0
            .insert(host.to_string(), now + Duration::from_secs(30));
    }

    pub(crate) fn forget(&mut self, host: &str) {
        self.0.remove(host);
    }
}

pub(crate) fn eligible(target: &url::Url, error: &str) -> bool {
    target.scheme() == "https"
        && matches!(target.host(), Some(url::Host::Domain(_)))
        && matches!(
            crate::playback_log::error_kind(error),
            "dns_error" | "timeout" | "transport_error"
        )
}

pub(crate) struct Resolution {
    pub(crate) addresses: Vec<SocketAddr>,
    pub(crate) ttl: Duration,
}

fn answers(value: &Value, port: u16) -> Result<Resolution, String> {
    if value["Status"].as_u64() != Some(0) {
        return Err("备用 DNS 解析失败".into());
    }
    let records = value["Answer"].as_array().ok_or("备用 DNS 没有可用地址")?;
    let mut addresses = Vec::new();
    let mut ttl = 30;
    for record in records {
        ttl = ttl.min(record["TTL"].as_u64().unwrap_or(0));
        if record["type"].as_u64() != Some(1) {
            continue;
        }
        let ip: Ipv4Addr = record["data"]
            .as_str()
            .ok_or("备用 DNS 地址无效")?
            .parse()
            .map_err(|_| "备用 DNS 地址无效")?;
        let [first, second, _, _] = ip.octets();
        if !network_policy::allowed_ip(ip.into())
            || (first == 198 && (second == 18 || second == 19))
        {
            return Err("备用 DNS 返回内网或保留地址".into());
        }
        addresses.push(SocketAddr::new(ip.into(), port));
    }
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() || addresses.len() > 32 {
        return Err("备用 DNS 没有可用地址".into());
    }
    Ok(Resolution {
        addresses,
        ttl: Duration::from_secs(ttl),
    })
}

pub(crate) async fn resolve(
    http: &reqwest::Client,
    host: &str,
    port: u16,
) -> Result<Resolution, String> {
    let mut response = http
        .get(format!("https://{HOST}/resolve"))
        .query(&[("name", host), ("type", "A")])
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .map_err(|_| "备用 DNS 请求失败")?
        .error_for_status()
        .map_err(|_| "备用 DNS 服务不可用")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "备用 DNS 响应失败")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("备用 DNS 响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "备用 DNS 响应无效")?;
    answers(&value, port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn public_answers_keep_the_target_port_and_shortest_dns_ttl() {
        let result = answers(
            &json!({"Status":0,"Answer":[
                {"type":5,"data":"edge.example.","TTL":5},
                {"type":1,"data":"1.1.1.1","TTL":60},
                {"type":1,"data":"1.1.1.1","TTL":60}
            ]}),
            8443,
        )
        .unwrap();
        assert_eq!(result.addresses, vec!["1.1.1.1:8443".parse().unwrap()]);
        assert_eq!(result.ttl, Duration::from_secs(5));
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "198.18.0.1",
            "198.19.0.1",
            "not-an-ip",
        ] {
            assert!(
                answers(
                    &json!({"Status":0,"Answer":[
                        {"type":1,"data":"1.1.1.1","TTL":60},
                        {"type":1,"data":ip,"TTL":60}
                    ]}),
                    443
                )
                .is_err(),
                "{ip}"
            );
        }
        for response in [json!({"Status":3}), json!({"Status":0,"Answer":[]})] {
            assert!(answers(&response, 443).is_err());
        }
    }

    #[test]
    fn recovery_only_applies_to_https_domains_and_connection_failures() {
        let url = url::Url::parse("https://media.example/list.m3u8?auth_key=secret").unwrap();
        for error in [
            "DNS 解析失败",
            "请求超时",
            "client error (Connect) ← operation timed out",
            "tls handshake eof",
        ] {
            assert!(eligible(&url, error));
        }
        for error in [
            "HTTP 403 Forbidden",
            "HTTP 404 Not Found",
            "HTTP 503 Service Unavailable",
            "禁止访问内网",
            "禁止 HTTPS 降级重定向",
        ] {
            assert!(!eligible(&url, error), "{error}");
        }
        for raw in [
            "http://media.example/video",
            "https://127.0.0.1/video",
            "https://[::1]/video",
        ] {
            assert!(!eligible(&url::Url::parse(raw).unwrap(), "请求超时"));
        }
    }

    #[test]
    fn recovered_hosts_expire_and_do_not_change_other_hosts() {
        let now = Instant::now();
        let mut routes = Routes::default();
        assert!(!routes.prefers_public("media.example", now));
        routes.remember("media.example", now);
        assert!(routes.prefers_public("media.example", now + Duration::from_secs(29)));
        assert!(!routes.prefers_public("other.example", now));
        assert!(!routes.prefers_public("media.example", now + Duration::from_secs(30)));
    }
}
