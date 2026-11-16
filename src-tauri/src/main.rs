#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

fn main() {
    // Linux 混合显卡（Intel 显示 + NVIDIA 独显）机器上，WebKitGTK 的 GL 合成在 Intel 核显侧，
    // 而 GStreamer 默认选中 NVDEC 在 NVIDIA 独显侧，产生 cudadownload → videoconvert → glupload
    // 的跨 GPU 逐帧拷贝，导致播放卡顿。此时把解码切到 Intel 侧 VA-API，解码与合成同卡、零拷贝，
    // 且不占用 CPU；纯 Intel / 纯 NVIDIA 机器不受影响。
    #[cfg(target_os = "linux")]
    {
        // 用户已显式设置时不做任何干预，保留覆盖能力
        if std::env::var_os("GST_PLUGIN_FEATURE_RANK").is_none() && intel_display_with_nvidia() {
            std::env::set_var(
                "GST_PLUGIN_FEATURE_RANK",
                "nvh264dec:0,nvh265dec:0,vah264dec:MAX,vah265dec:MAX",
            );
        }
    }

    hghubx_lib::run()
}

/// 检测「Intel 显示 + NVIDIA 独显」共存拓扑。
#[cfg(target_os = "linux")]
fn intel_display_with_nvidia() -> bool {
    use std::path::Path;
    if !Path::new("/sys/module/nvidia").exists() {
        return false;
    }
    std::fs::read_dir("/sys/class/drm")
        .map(|rd| {
            rd.flatten().any(|entry| {
                std::fs::read_to_string(entry.path().join("device/vendor"))
                    .map(|v| v.trim().eq_ignore_ascii_case("0x8086"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}
