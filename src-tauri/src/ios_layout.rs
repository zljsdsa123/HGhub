//! iOS WKWebView safe-area & viewport normalization.
use std::ffi::c_void;

use objc2::{msg_send, rc::Retained};
use objc2_ui_kit::{UIScrollView, UIScrollViewContentInsetAdjustmentBehavior, UIView};
use objc2_web_kit::WKWebViewConfiguration;
use tauri::Manager;

/// iOS 14.5+：WKWebView 长按会弹出系统文本选择放大镜（loupe）。
/// 纯 CSS `-webkit-user-select:none` 挡不住它；唯一可靠开关是
/// `WKPreferences.isTextInteractionEnabled = false`。代价是它会连 `<input>/<textarea>`
/// 一起禁用，因此默认关闭，前端在输入框获得焦点时再调用 `set_text_interaction` 重新打开。
pub(crate) fn set_text_interaction_on_webview(webview: &tauri::Webview, enabled: bool) {
    let _ = webview.with_webview(move |platform| {
        set_text_interaction(platform.inner(), enabled);
    });
}

fn set_text_interaction(inner: *mut c_void, enabled: bool) {
    unsafe {
        // objc2_web_kit 的 `WKWebView` 类型只在 macOS 导出；iOS 上 WKWebView 是 UIView 子类，
        // 这里把指针当 UIView 用，直接发 `configuration` selector，配置/偏好再走 iOS 可用的类型。
        let Some(view) = inner.cast::<UIView>().as_ref() else {
            return;
        };
        // 链接长按预览与文本选择放大镜同源触发，一并关掉，避免长按快进误弹预览。
        let config: Retained<WKWebViewConfiguration> = msg_send![view, configuration];
        let prefs = config.preferences();
        prefs.setTextInteractionEnabled(enabled);
        let _: () = msg_send![view, setAllowsLinkPreview: false];
    }
}

pub(crate) fn apply(webview: &tauri::Webview, nudge_frame: bool) {
    let Ok(dir) = webview.app_handle().path().app_data_dir() else {
        return;
    };
    let error_dir = dir.clone();
    // Tauri dispatches this closure on the main thread while retaining the WKWebView.
    if let Err(error) = webview.with_webview(move |platform| unsafe {
        // WKWebView subclasses UIView; use UIKit's typed geometry methods rather than
        // hand-declaring CGRect/UIEdgeInsets Objective-C return ABIs.
        let Some(view) = platform.inner().cast::<UIView>().as_ref() else {
            let _ = crate::logging::append_debug(&dir, "[ios-layout] webview unavailable");
            return;
        };
        let scroll: Retained<UIScrollView> = msg_send![view, scrollView];
        let parent = view.superview();
        let window = view.window();

        // 1. Disable UIKit automatic safe-area contentInset adjustment on WKWebView's scrollView.
        // Without this, UIKit applies top+bottom safeAreaInsets (47+34 = 81pt) before
        // `viewport-fit=cover` is committed, shrinking the initial layout viewport height to
        // 844 - 81 = 763pt and leaving an 81pt unpainted band at the bottom until rotation.
        let mut behavior = scroll.contentInsetAdjustmentBehavior();
        if behavior != UIScrollViewContentInsetAdjustmentBehavior::Never {
            behavior = UIScrollViewContentInsetAdjustmentBehavior::Never;
            scroll.setContentInsetAdjustmentBehavior(behavior);
        }
        scroll.setAutomaticallyAdjustsScrollIndicatorInsets(false);

        let mut zero_insets = scroll.contentInset();
        zero_insets.top = 0.0;
        zero_insets.left = 0.0;
        zero_insets.bottom = 0.0;
        zero_insets.right = 0.0;
        let cur_insets = scroll.contentInset();
        if cur_insets.top != 0.0
            || cur_insets.left != 0.0
            || cur_insets.bottom != 0.0
            || cur_insets.right != 0.0
        {
            scroll.setContentInset(zero_insets);
            scroll.setScrollIndicatorInsets(zero_insets);
        }

        let mut zero_offset = scroll.contentOffset();
        zero_offset.x = 0.0;
        zero_offset.y = 0.0;
        let cur_offset = scroll.contentOffset();
        if cur_offset.x != 0.0 || cur_offset.y != 0.0 {
            scroll.setContentOffset(zero_offset);
        }

        // 2. Sync container and WKWebView frames to UIWindow.bounds(), and nudge WKWebView's frame
        // on page-load completion so WebKit's `_frameOrBoundsChanged` recomputes unobscured layout
        // viewport dimensions under `viewport-fit=cover` without needing a physical rotation.
        if let Some(win) = window.as_ref() {
            let target_frame = win.bounds();
            if target_frame.size.width > 0.0 && target_frame.size.height > 1.0 {
                if let Some(sup) = parent.as_ref() {
                    let sf = sup.frame();
                    if sf.origin.x != target_frame.origin.x
                        || sf.origin.y != target_frame.origin.y
                        || sf.size.width != target_frame.size.width
                        || sf.size.height != target_frame.size.height
                    {
                        sup.setFrame(target_frame);
                    }
                }
                let vf = view.frame();
                let mismatch = vf.origin.x != target_frame.origin.x
                    || vf.origin.y != target_frame.origin.y
                    || vf.size.width != target_frame.size.width
                    || vf.size.height != target_frame.size.height;
                if nudge_frame || mismatch {
                    let mut nudged = target_frame;
                    nudged.size.height = target_frame.size.height - 1.0;
                    view.setFrame(nudged);
                    view.layoutIfNeeded();
                    view.setFrame(target_frame);
                }
                scroll.adjustedContentInsetDidChange();
                view.setNeedsLayout();
                view.layoutIfNeeded();
            }
        }

        let message = format!(
            "[ios-layout] webview.frame={:?} webview.bounds={:?} webview.safe={:?} \
             parent.frame_bounds_safe={:?} window.bounds_safe={:?} \
             scroll.frame={:?} scroll.bounds={:?} scroll.contentInset={:?} \
             scroll.adjustedContentInset={:?} scroll.adjustmentBehavior={} scroll.contentOffset={:?}",
            view.frame(),
            view.bounds(),
            view.safeAreaInsets(),
            parent.as_ref().map(|v| (v.frame(), v.bounds(), v.safeAreaInsets())),
            window.as_ref().map(|v| (v.bounds(), v.safeAreaInsets())),
            scroll.frame(),
            scroll.bounds(),
            scroll.contentInset(),
            scroll.adjustedContentInset(),
            scroll.contentInsetAdjustmentBehavior().0,
            scroll.contentOffset(),
        );
        let _ = crate::logging::append_debug(&dir, &message);
    }) {
        let _ = crate::logging::append_debug(&error_dir, &format!("[ios-layout] capture failed: {error}"));
    }
}
