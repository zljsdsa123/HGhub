//! Keep WebKit's local media transport out of the desktop's upstream proxy.
//!
//! API/CDN requests are made by Rust and retain the configured proxy there.
//! The WebView loads app assets and the loopback media server; applying GNOME's
//! proxy a second time can send 127.0.0.1 requests to that proxy instead.

use webkit2gtk::{NetworkProxyMode, WebViewExt, WebsiteDataManagerExt};

pub(crate) fn configure(webview: &tauri::Webview) {
    if let Err(error) = webview.with_webview(|platform| {
        if let Some(manager) = platform.inner().website_data_manager() {
            // Set this on the app's data manager, never on the process environment
            // or system settings. The manager also covers future media requests.
            manager.set_network_proxy_settings(NetworkProxyMode::NoProxy, None);
        } else {
            eprintln!("[hghubx] WebKit website data manager unavailable");
        }
    }) {
        eprintln!("[hghubx] WebKit local media routing setup failed: {error}");
    }
}
