//! HGhubX 环境变量：新名称优先，旧前缀仅作为升级兼容入口。

pub fn var(suffix: &str) -> Option<String> {
    read_with(suffix, |key| std::env::var(key).ok())
}

fn read_with(suffix: &str, mut read: impl FnMut(&str) -> Option<String>) -> Option<String> {
    read(&format!("HGHUBX_{suffix}")).or_else(|| read(&format!("HGHUB_{suffix}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_names_take_precedence_and_legacy_names_remain_supported() {
        for suffix in [
            "PROXY",
            "STRICT",
            "TEST_COVER_URL",
            "TEST_MEDIA_URL",
            "TEST_MEDIA_OUTPUT",
        ] {
            let current = format!("HGHUBX_{suffix}");
            let legacy = format!("HGHUB_{suffix}");
            let resolve = |new: Option<&str>, old: Option<&str>| {
                read_with(suffix, |key| {
                    if key == current {
                        new.map(str::to_owned)
                    } else if key == legacy {
                        old.map(str::to_owned)
                    } else {
                        panic!("unexpected environment variable: {key}")
                    }
                })
            };
            assert_eq!(resolve(None, None), None);
            assert_eq!(resolve(None, Some("old")), Some("old".to_owned()));
            assert_eq!(resolve(Some("new"), None), Some("new".to_owned()));
            assert_eq!(resolve(Some("new"), Some("old")), Some("new".to_owned()));
            // 显式设置的新变量（包括空值）不能被旧配置覆盖。
            assert_eq!(resolve(Some(""), Some("old")), Some(String::new()));
        }
    }
}
