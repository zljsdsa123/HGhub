//! Selective WebView cache maintenance.
//!
//! `clear_all_browsing_data` is intentionally not used: it also removes cookies,
//! local/session storage and other account state. Linux WebKitGTK exposes the
//! cache data classes separately, so the setting can purge HTTP/media cache
//! without touching login or local preferences.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearReport {
    /// Whether a platform WebView HTTP/media cache was selectively cleared.
    pub web_cache: bool,
    pub platform: &'static str,
}

pub async fn clear_web_cache(webview: &tauri::Webview) -> Result<CacheClearReport, String> {
    #[cfg(target_os = "linux")]
    {
        linux::clear(webview).await?;
        return Ok(CacheClearReport {
            web_cache: true,
            platform: "linux",
        });
    }

    #[cfg(not(target_os = "linux"))]
    {
        // Tauri only exposes clear_all_browsing_data on the other platforms,
        // which would also delete cookies and local settings. Keep the bounded
        // in-memory media caches cleared by the caller instead of risking login.
        let _ = webview;
        Ok(CacheClearReport {
            web_cache: false,
            platform: std::env::consts::OS,
        })
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::time::Duration;
    use webkit2gtk::{WebViewExt, WebsiteDataManagerExtManual, WebsiteDataTypes};

    fn safe_cache_types() -> WebsiteDataTypes {
        // Deliberately excludes COOKIES, LOCAL_STORAGE, SESSION_STORAGE,
        // INDEXEDDB_DATABASES, SERVICE_WORKER_REGISTRATIONS and HSTS.
        WebsiteDataTypes::MEMORY_CACHE
            | WebsiteDataTypes::DISK_CACHE
            | WebsiteDataTypes::OFFLINE_APPLICATION_CACHE
    }

    pub(super) async fn clear(webview: &tauri::Webview) -> Result<(), String> {
        let (done, result) = tokio::sync::oneshot::channel();
        webview
            .with_webview(move |platform| {
                let Some(manager) = platform.inner().website_data_manager() else {
                    let _ = done.send(Err("WebKit 数据管理器不可用".to_string()));
                    return;
                };
                manager.clear(
                    safe_cache_types(),
                    webkit2gtk::glib::TimeSpan::from_seconds(0),
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |outcome| {
                        let _ = done.send(outcome.map_err(|error| error.to_string()));
                    },
                );
            })
            .map_err(|error| format!("无法访问 WebView：{error}"))?;

        match tokio::time::timeout(Duration::from_secs(20), result).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(error))) => Err(format!("WebKit 缓存清理失败：{error}")),
            Ok(Err(_)) => Err("WebKit 缓存清理未返回结果".to_string()),
            Err(_) => Err("WebKit 缓存清理超时".to_string()),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::safe_cache_types;
        use webkit2gtk::WebsiteDataTypes;

        #[test]
        fn selective_clear_never_includes_account_or_preference_storage() {
            let types = safe_cache_types();
            assert!(types.contains(WebsiteDataTypes::MEMORY_CACHE));
            assert!(types.contains(WebsiteDataTypes::DISK_CACHE));
            assert!(!types.intersects(
                WebsiteDataTypes::COOKIES
                    | WebsiteDataTypes::LOCAL_STORAGE
                    | WebsiteDataTypes::SESSION_STORAGE
                    | WebsiteDataTypes::INDEXEDDB_DATABASES
                    | WebsiteDataTypes::SERVICE_WORKER_REGISTRATIONS
                    | WebsiteDataTypes::HSTS_CACHE
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CacheClearReport;

    #[test]
    fn report_matches_frontend_camel_case_contract() {
        let value = serde_json::to_value(CacheClearReport {
            web_cache: true,
            platform: "linux",
        })
        .unwrap();
        assert_eq!(value["webCache"], true);
        assert_eq!(value["platform"], "linux");
    }
}
