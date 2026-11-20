# 平台壳

## 责任与边界

平台壳把同一套 React/Rust 业务接到各平台的 WebView、窗口和媒体传输上：iOS 的 WKWebView
安全区与 AVFoundation loopback、macOS 的标题栏与系统代理匹配、Linux 的 WebKitGTK/GStreamer
loopback、Windows 的自定义标题栏与注册表代理判断、Android 的 WebView 自定义协议。它只处理
平台差异，不复制账号、线路或播放状态机。

所有平台差异优先放在 `#[cfg(target_os = ...)]` 模块和 Tauri 平台配置文件里；业务函数不应
在运行时猜测平台，前端只通过 `src/shared/api/api.ts` 的 `platform`/`LOCAL` 常量消费差异。

## 事实来源

- 模块注册与启动：[`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs) 的 `mod` 列表、
  `media_http_origin`、`allowed_dev_host`、`allowed_frontend_origin`、`run()` 的
  `on_page_load`/`setup`、`generate_handler!`。
- iOS 布局与方向：[`src-tauri/src/ios_layout.rs`](../../src-tauri/src/ios_layout.rs) 的 `apply()`、
  `set_text_interaction_on_webview()`、`request_orientation()`；原生媒体服务：
  [`src-tauri/src/ios_media_http.rs`](../../src-tauri/src/ios_media_http.rs) 的 `origin()`、
  `start()`、`Endpoint`、`parse_request()`、`app_origin()`、`MAX_CONNECTIONS`。
- macOS 标题栏：[`src-tauri/src/macos_titlebar.rs`](../../src-tauri/src/macos_titlebar.rs) 的
  `TITLEBAR_HEIGHT`、`measure_buttons()`、`centered_y()`、`create_main_window()`；
  Apple 代理匹配：[`src-tauri/src/apple_proxy.rs`](../../src-tauri/src/apple_proxy.rs) 的
  `routes_target()`。
- Linux 媒体：[`src-tauri/src/linux_http.rs`](../../src-tauri/src/linux_http.rs) 的 `PORT`、
  `ORIGIN`、`start()`、`serve()`、`write_response()`；WebView 代理旁路：
  [`src-tauri/src/linux_webview.rs`](../../src-tauri/src/linux_webview.rs) 的 `configure()`。
- 平台配置：[`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json)、
  [`tauri.ios.conf.json`](../../src-tauri/tauri.ios.conf.json)、
  [`tauri.linux.conf.json`](../../src-tauri/tauri.linux.conf.json)、
  [`tauri.macos.conf.json`](../../src-tauri/tauri.macos.conf.json)；Cargo 的 target 依赖在
  [`src-tauri/Cargo.toml`](../../src-tauri/Cargo.toml)。
- 前端平台判断与本地基址：[`src/shared/api/api.ts`](../../src/shared/api/api.ts) 的 `isIos`、`isAndroid`、
  `isLinux`、`platform`、`LOCAL`；本地媒体地址判定（避免把代理地址再包一层）由
  [`src/features/playback/mediaTransport.ts`](../../src/features/playback/mediaTransport.ts) 的
  `playbackSource()` 承担：按 `${LOCAL}/` 前缀与 `/hls`、`/seg` 路径识别已包装地址；桌面壳：
  [`src/app/shell/DesktopChrome.tsx`](../../src/app/shell/DesktopChrome.tsx) 的
  `DesktopTitleBar`/`win-titlebar`、`DesktopRail`；移动壳见
  [`src/app/App.tsx`](../../src/app/App.tsx) 的 `TabBar`/`MobileShell` 和
  [`src/shared/ui/ios/`](../../src/shared/ui/ios/)。

## 主运行时路径

### iOS

1. `on_page_load(Finished)` 调 `ios_layout::apply()`：关闭 `UIScrollView` 的自动安全区
   inset，清零 content inset/offset，并在 80ms、350ms 再应用一次，避免首帧
   `viewport-fit=cover` 提交前的 47+34pt 空白带。
2. 默认关闭 WKWebView 的文本交互和链接预览，消除长按快进时的系统放大镜/预览；输入框聚焦时
   前端调 `set_text_interaction(true)`，失焦再关闭。这个开关是 UIKit 级别的，不能用 CSS 替代。
3. `VideoSurface` 在 iOS 上不使用 `hg://`，而是先调 `media_http_origin()`。后端在第一次请求时
   绑定 `127.0.0.1:0`，生成 32 字节随机 capability，返回
   `http://127.0.0.1:<port>/<capability>`；URL 必须带这个前缀，Host 必须精确等于该端口，
   只接受 `GET/HEAD`、`/hls`、`/seg`。最多 24 个连接、16 KiB 头和 64 个 header，读头 5 秒、
   整个请求 90 秒。
4. `app_origin()` 只允许 Tauri 自身 origin，或 debug 下显式 `TAURI_DEV_HOST` 的 1420 端口；
   缺失 `Origin` 仍受 capability + Host 约束，放宽网络策略也不会放宽这个 loopback 边界。

### macOS

1. `tauri.macos.conf.json` 把主窗口设为 `create:false`、`decorations:true`、
   `titleBarStyle:"Overlay"`、`hiddenTitle:true`。`setup` 调 `macos_titlebar::create_main_window()`
   自己创建窗口。
2. `measure_buttons()` 创建一个不显示的探测窗口，读取系统红绿灯的 `height/bottom`；
   `centered_y()` 解出按钮中心与 44pt 标题栏中心对齐的 `trafficLightPosition.y`，测量失败时
   回退配置里的 24。`TITLEBAR_HEIGHT` 必须与 `src/index.css` 的 `.win-titlebar` 高度一致。
3. 系统代理匹配使用 `hyper_util` 的 `Matcher::from_system()`，`apple_proxy::routes_target()`
   保留 macOS 的 per-scheme、`NO_PROXY` 和 SOCKS 规则；iOS 没有系统代理读取，只匹配进程代理
   环境变量，VPN/TUN 由系统接管。

### Linux

1. WebKitGTK 4.1 默认没有 MediaSource，hls.js 用不上；`<video>` 交给 GStreamer，而 GStreamer
   不认 `hg://`。`setup` 调 `linux_http::start()`，在 `127.0.0.1:17650` 起一个只服务
   `/img`、`/hls`、`/seg` 的 HTTP 代理。
2. `linux_http::serve()` 只接受 `GET/HEAD` 且要求唯一合法 `Host` 与至多一个合法 `Origin`，
   单线程处理每个连接，读/写超时 30 秒；只处理单个、无 `If-Range` 的 `Range`，
   HEAD（含错误响应）保留表示长度但不发 body。响应头只保留一份
   `Content-Length`/CORS，并强制 `Connection: close`。
3. `linux_webview::configure()` 在 WebKit 的 `WebsiteDataManager` 上设置 `NoProxy`（API/CDN
   仍由 Rust 按用户代理访问，只防止 127.0.0.1 媒体请求被 GNOME 代理二次转发），并把 WebKitGTK
   的 `enter-fullscreen`/`leave-fullscreen` 信号桥接到 `tauri::Window::set_fullscreen`（对齐
   Windows `ContainsFullScreenElementChanged` 行为）。`media::LOCAL_ORIGIN` 在这里等于
   `http://127.0.0.1:17650`，与前端 `LOCAL` 必须同步修改。
4. Linux bundling 只发布 deb，依赖 GStreamer base/good/bad/ugly/libav/vaapi 和
   `intel-media-va-driver`。

### Windows

1. `tauri.conf.json` 的窗口 `decorations:false`，前端 `DesktopChrome` 用
   `data-tauri-drag-region` 提供标题栏；`ResizeHandles` 只在 Windows/Linux 渲染。
2. 媒体 `LOCAL_ORIGIN` 是 `http://hg.localhost`（Tauri 自定义协议在 Windows WebView2 上的
   形态）。`http://hg.localhost` 和其他 `*.localhost` 在导航守卫里被当作进程内地址，但后端
   仍按严格模式做 SSRF 校验。
3. 系统代理判断读 `HKCU\...\Internet Settings` 的 `ProxyEnable`/`ProxyServer`；真正的代理
   读取交给 reqwest 的 `system-proxy`。`system_proxy_fingerprint()` 把注册表值纳入媒体配置代次，
   代理软件开关后不会复用旧客户端。PAC 不支持。

### Android

1. 自定义协议在 Android WebView 中表现为 `http://hg.localhost`，导航守卫显式放行
   `*.localhost`；这只是在拦截自定义协议时可能产生的进程内地址，不是外网导航。
2. 严格模式下，部分 Android WebView 对 `hg://` 拦截请求不给 `Origin`（或空串/`"null"`）。
   `lib.rs` 的 `origin_ok` 允许这三种情况进入 `media::handle`，但 handler 只接受
   `/img`、`/hls`、`/seg` 且后端仍做目标地址策略校验；缺 Origin 不等于开放代理。
3. 移动布局在 `App.tsx` 用 `plat-android`、安全区变量和 `MobileShell`；`ContentPreferences`、
   `ios/` 控件在 Android 复用触屏样式。Android 系统 Wi-Fi 代理不被 reqwest 采用，只有
   VPN/TUN 或显式 `HGHUBX_PROXY`。
4. `bundle.android.minSdkVersion=24`，`versionCode` 由 `scripts/set-version.mjs` 写入；签名只在
   release workflow 中用 secrets 完成。
5. 返回键是多监听广播：`App.tsx` 与启动动画（`LaunchAnimation`）都会注册 `app|back-button`。
   已同意协议的老用户在动画期间就挂载 App（冷启动优化），此时返回只归动画（跳过动画）：
   `StartupGate` 在覆盖层分支持有 `holdBackForStartup()`，`runBack()` 见门直接消费不导航，
   覆盖层卸载时释放（引用计数 + 幂等释放，StrictMode 安全）。动画结束后只剩 App 监听，
   顺序恢复为 面板/弹层 → 全屏 → 登录框 → 页面栈 → 回首页 → 退出。未同意首启不持门。
   TV 版走 `registerBack`（remote.ts 的 scope 分发），不经 `runBack()`，门对 TV 无影响。
6. 老 WebView（Chromium 66 车机/电视、旧 iOS WKWebView）启动支持分三层：
   `index.html` 内嵌 ES5 启动看门狗（模块图之外的 error/unhandledrejection 监听 +
   15s 超时，失败渲染可复制诊断的 `#hg-startup-error` 面板）；`src/legacyRuntime.ts`
   补 `globalThis`/`Object.fromEntries`/`Promise.allSettled`/`flat(Map)`/`queueMicrotask`/
   `matchMedia.addEventListener`/`ResizeObserver` 等运行时 API，并探测 flex-gap 写
   `data-legacy-flex-gap`；构建层 `vite.config.ts` 以 `chrome66/safari14.1` 为语法目标，
   `scripts/legacy-css.ts` 在 CSS 汇总后做 dvh/color-mix 回退、postcss-preset-env 降级与
   lightningcss 压缩，并追加 `src/styles/legacy-webview.css` 的几何回退。标准入口
   `src/main.tsx` 与 TV 入口 `src/tv/bootstrap.tsx` 都在首个成功 commit 调
   `markStartupReady()` 解除看门狗；协议未签署不算启动失败。
7. 冷启动无闪烁链路：原生窗口/系统启动屏（`tauri.conf.json`、`patch-android-splash.mjs`、
   `patch-ios-splash.mjs`）、`index.html` 的 `html[data-hg-launching]` 背景锁与 `.hg-launch`
   统一固定为 `#071218`，阻止外链 CSS 在 React 挂载前把 `body` 刷成亮色 `#eeece7` 或暗灰底。
   `StartupGate` 首帧独占提交合成线程动画，下一帧再并发挂载已分离 `Feed`/`hls.js` 的业务壳，
   待入场时间满足且底层界面提交（`contentReady` 或超时兜底）后再释放 `data-hg-launching`、同步
   `meta[name="theme-color"]` 并淡出覆盖层。
8. 标准版登录弹层单独避让软键盘。`scripts/patch-android-splash.mjs` 生成的 `MainActivity`
   用原生窗口的输入法边距和 WebView 实际位置计算底部遮挡量；窗口已缩小的部分不重复预留，
   键盘收起后清除 `--native-ime-overlap`。`LoginModal` 启用该边距，弹层在键盘上方滚动，
   可在键盘保持展开时将密码框和提交按钮滚到可见位置；弹层缩小时将被裁切的已聚焦输入框带回屏内。
   其他弹层、TV 版和 iOS 不使用这条路径。

### 共享页面壳几何

`src/styles/ios.css` 的 `.ios-page` 标题栏内容与滚动体共用一条宽度规则：窄屏全宽，
宽屏以 `clamp(720px, 62vw, 960px)` 限宽居中；不支持 `clamp()` 时用 `960px` 作上限。
子页的 `.ios-subpage-header` 外层底色与分隔线铺满页面面板。导航、榜单切换、分类筛选及页内搜索框
仍与正文列对齐；普通标题和滚动体维持原来的限宽与安全区内边距。
移动壳合并 Android 原生 inset 与 iOS WebView 的 CSS 安全区；标题、内容和浮动底栏按左、右
分别留出内边距，底栏在原生手势区之上，同级滚动页继续留出最后一项的可见距离。
挂到移动壳外的模态框与半屏面板直接读取同一套原生变量和 `env()`，低高度横屏缩小外边距，
内容过长时在安全区内滚动。老 WebView 用原生变量回退，无需新增布局依赖。

`scripts/test-ui-feedback.mjs` 的同一组几何断言覆盖 320/390px 竖屏、667px 横屏
（模拟左右非对称安全区）、768/1024px 平板及 1280px 桌面视口。Chromium 模拟不等同于原生设备验收。

## 状态转换

- iOS 页面加载：`Started` → 应用布局；`Finished` → 再应用布局并关闭文本交互 → 80ms/350ms
  补应用。输入框 focus/blur → `set_text_interaction` 开关。
- iOS 媒体：首次播放 → `origin()` 启动 listener；已有且任务未结束 → 复用；listener 结束 →
  下一次 `origin()` 替换成新端口。服务端不跨进程持久化 capability。
- Linux 媒体：进程启动 → 绑定 17650；绑定失败只写 stderr，播放失败；WebView 就绪 →
  `NoProxy`；媒体请求 → `media::handle` → 响应。
- 窗口：macOS 在 `setup` 创建；Windows/Linux 使用配置窗口 + 前端拖拽；移动端由 Tauri
  mobile entry point 创建。
- 代理：系统代理指纹变化 → `refresh_media_scope()` 推进代次；下一次媒体请求重新建客户端。

## 约束与失败行为

- `media::LOCAL_ORIGIN`、`src/shared/api/api.ts` 的 `LOCAL`、Linux `PORT`、iOS loopback 端口必须成对
  修改；任何一处不一致都会表现为封面/清单加载失败，而不是编译错误。
- 自定义协议/CSP 只能在平台配置中按需扩到本地媒体地址；不得加入任意 `http:`/`https:` 或
  放宽 `script-src`、`connect-src`、`frame-src`。iOS 配置只额外允许 `http://127.0.0.1:*` 作为
  `media-src`。
- 平台监听器只绑定回环地址，必须有连接/头/时间上限；不能把监听端口或 capability 当作
  用户认证，真正的登录仍是 `SessionStore`。
- Linux 端口绑定失败不能静默退回到 `hg://` 假装成功；GStreamer 播不了，必须在 UI 暴露播放
  错误。macOS 红绿灯测量失败必须回退配置值，不阻塞窗口创建。
- `if-range` 或重复 `Range` 一律退回完整响应，不能把不完整分片当成 206 返回。
- 平台专属代码用 `cfg` 隔离；不要在非目标平台编译 UIKit/AppKit/WebKitGTK 类型。

## 验证命令

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm build
node scripts/test-ios-native-media.mjs
```

单元测试覆盖 macOS 红绿灯居中、Apple 代理匹配、Linux 响应头/HEAD、iOS 请求校验和媒体
Range。浏览器脚本只能验证前端传输契约与布局，不替代 iOS WKWebView、Android WebView、
Linux GStreamer 或 Windows WebView2 的实机矩阵；真机结果应单独记录为“已验证/待核实”。
Android 登录键盘需安装标准版 APK，用原生软键盘复测 `320 × 568 dp` 和 `360 × 840 dp`：
进入「我的 → 登录」，保持键盘展开，上划到密码框与「登录」按钮，确认按钮仍可操作；收起键盘后
弹层恢复普通高度。浏览器几何测试不替代此验收。
