//! Keep WebKit's local media transport out of the desktop's upstream proxy.
//!
//! API/CDN requests are made by Rust and retain the configured proxy there.
//! The WebView loads app assets and the loopback media server; applying GNOME's
//! proxy a second time can send 127.0.0.1 requests to that proxy instead.

use webkit2gtk::{NetworkProxyMode, WebViewExt, WebsiteDataManagerExt};

pub(crate) fn configure(webview: &tauri::Webview) {
    let enter_window = webview.window();
    let leave_window = enter_window.clone();
    if let Err(error) = webview.with_webview(move |platform| {
        let inner = platform.inner();
        if let Some(manager) = inner.website_data_manager() {
            // Set this on the app's data manager, never on the process environment
            // or system settings. The manager also covers future media requests.
            manager.set_network_proxy_settings(NetworkProxyMode::NoProxy, None);
        } else {
            eprintln!("[hghubx] WebKit website data manager unavailable");
        }
        // Tauri bridges ContainsFullScreenElementChanged on Windows, while Linux
        // WebKitGTK needs enter/leave-fullscreen forwarded to tao's window state.
        inner.connect_enter_fullscreen(move |_| {
            let _ = enter_window.set_fullscreen(true);
            false
        });
        inner.connect_leave_fullscreen(move |_| {
            let _ = leave_window.set_fullscreen(false);
            false
        });
    }) {
        eprintln!("[hghubx] WebKit local media routing setup failed: {error}");
    }
}
