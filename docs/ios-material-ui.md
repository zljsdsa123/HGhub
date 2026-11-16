# HGhubX iOS 材质界面

这套界面使用现有 React、Tailwind 和系统字体，通过 CSS 实现接近 iOS 的圆角、半透明材质、边缘高光和浮动导航。没有增加 UI 库、着色器或字体下载；它是跨平台 WebView 实现，不调用 UIKit 的原生 Liquid Glass API。

## 样式与组件

- `src/styles/ios.css`：浅色珍珠底、深色炭灰底及语义色；玻璃材质用于导航、工具栏和弹层，内容保持实色。
- `src/components/ios/controls.tsx`：原生按钮、输入框、表单、分段选择和表面容器。保留标准 HTML 属性、ref 和事件行为。
- `src/components/ios/overlays.tsx`：统一 Sheet、Modal、DockPanel，处理嵌套顺序、焦点循环/恢复、背景 inert 和返回键。
- `src/components/cards.tsx`：统一封面比例、标题、副标题、状态和观看进度。

桌面标题栏保持 44px，与 macOS 原生标题栏约束一致。移动端导航使用安全区间距；触摸控件至少 44px。已保存的主题继续优先，首次启动按系统明暗外观选择。原有本地数据迁移和环境变量兼容保持生效。

## 降级与检查

减少动态效果时关闭过渡；减少透明度、提高对比度或不支持 backdrop-filter 时，核心玻璃面板使用实色背景。没有依赖持续渲染的 canvas 动效。

运行 `pnpm build`、`pnpm test:ios-ui`、`pnpm test:ios-overlays`，并执行现有播放、加载、分页、移动布局、诊断复制和存储迁移回归。浏览器安装使用 `pnpm exec playwright-core install chromium`；可通过 `BROWSER_EXECUTABLE` 指定本机浏览器。报告和截图写入忽略目录 `test-results/`。

浏览器回归使用真实 App 与模拟 Tauri IPC，不能替代原生 iOS WKWebView、Android 系统返回键及 Windows/macOS 窗口的设备验收。发布前需核对这些设备上的视频合成、模糊材质和安全区。

设计参考：[Apple Human Interface Guidelines — Materials](https://developer.apple.com/design/human-interface-guidelines/materials)。

## 交互延迟与弹性动效

移动播放器的首击现在立即切换净屏；230ms 只保留为第二击识别窗口，第二击恢复首击前的界面并切换播放。页面失活、锁定和切集时清理手势计时器。

隐藏标签页使用 display:none 保留组件状态并停止参与布局；去除封面徽章的逐项 backdrop-filter 及弹层背景的重复模糊。底栏选中层通过 transform 移动，避免逐帧更新 left；首页片单 ID 在内容未变化时复用，重复点击当前标签不再创建空导航栈。

按钮按下反馈 55ms；分段选择、标签页和页面进入采用约 320–420ms 的轻微回弹，弹层保留约 150–180ms 的快速退出。减少动态效果设置关闭回弹。开关使用主题蓝轨道、金属高光滑块与勾选状态，保留 role=switch 与44px触摸区域。

`pnpm test:ui-performance` 记录本地 IPC fixture、Chromium 开发构建、4倍 CPU 降速下的点击到两个动画帧时间；此数据用于同环境比较，不代表原生设备 INP。本次单次对比中位数 130.9→119.6ms、P95 167.4→153.2ms；另有真实 Feed 手势回归记录首击22ms，去掉了原先固定230ms的等待。实际设备、数据量和网络不同，仍需设备复核。

动效节奏参考：[yui540 motions](https://yui540.com/motions)，使用本项目自写的 CSS 与交互逻辑。
