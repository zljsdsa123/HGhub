import { isLinux } from "./api";

export function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case 2:
      return "网络错误，视频加载失败，请检查网络后重试";
    case 3:
      return "视频解码失败，请重试";
    case 4:
      return isLinux
        ? "当前系统缺少 H.264/AAC 解码器，请安装 gstreamer1.0-libav 和 gstreamer1.0-plugins-bad 后重试"
        : "当前视频格式不受支持";
    default:
      return "视频加载失败，请重试";
  }
}
