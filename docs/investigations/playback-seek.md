# 桌面进度条点击误暂停回归

症状：顺序播放和拖动进度条正常，控制条闲置隐藏后直接点击靠后位置，视频不跳转或变成暂停，按钮显示“播放”。

原因：隐藏状态给整个控制条设置了 `pointer-events: none`。鼠标移动唤醒控制条的 React 更新尚未提交时，紧接的点击可能落到下方视频，触发点击暂停；拖动会给唤醒过程留出更多时间。

修复：闲置隐藏时仅保留进度条的命中区域；非激活播放页禁用进度条。其他隐藏按钮仍不接收点击。

## 本地复测

需要 FFmpeg、Python 3 和项目开发依赖。使用本地生成的 90 秒 HLS，避免依赖上游。

```sh
seek_fixture_dir=$(mktemp -d)
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i testsrc2=size=320x180:rate=15 \
  -f lavfi -i sine=frequency=440:sample_rate=44100 -t 90 \
  -c:v libx264 -preset ultrafast -g 30 -sc_threshold 0 -pix_fmt yuv420p \
  -c:a aac -f hls -hls_time 2 -hls_playlist_type vod \
  -hls_segment_filename "$seek_fixture_dir/seg%03d.ts" "$seek_fixture_dir/list.m3u8"
python3 tests/serve-seek-media.py "$seek_fixture_dir"
```

另一个终端运行 `pnpm dev --host 127.0.0.1`，打开 `http://127.0.0.1:1420/tests/player-seek.html`。测试页使用真实 Feed、VideoSurface、PlayerControls 与 hls.js，仅业务数据和媒体协议传输使用本地替身。页面会自动检查闲置时进度条是否仍是点击命中目标，结果写入 `#results`。

检查以下操作：

- 等待控制条隐藏，直接点击 80%、20%、65% 位置；应跳到目标附近并持续播放。
- 拖动进度条仍可定位并继续播放。
- 暂停后点击定位，应保持暂停；聚焦进度条后方向键仍有效。
- 点击“切换播放页激活状态”，失活后进度条应禁用。

本轮 Chromium 与 Linux WebKitGTK 各通过上述 12 项自动化断言。修改前 Chromium 复现了点击后暂停且未 seek；WebKitGTK 未跳转到目标。修改后均可跳转并持续播放。WebKitGTK 验证不能代替 macOS WKWebView 实机确认。

## 点击与拖动提交

桌面控制条和吃瓜详情独立播放器共用指针处理：按下时捕获指针，移动时仅预览位置与时间，松开后实际定位一次。点击按轨道位置计算时间，避免依赖各平台原生滑块的点击步进；键盘保留原生 range 操作。指针取消、失焦、页面失活或换源会取消预览，不误提交旧位置。原先一次拖动可触发多次定位，现在无头回归会断言移动期间零次定位、松手后一次定位。

完整自动化入口与产物说明见 [播放诊断日志](../operations/playback-diagnostics.md)。
