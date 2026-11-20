# 目录与依赖关系

本文描述当前代码放在哪里、由谁引用。运行时契约见 [子系统参考](subsystems/README.md)，
修改规则见 [工程入口](../AGENTS.md)。目录归组不代表业务状态机已经拆分。

## 前端目录

```text
src/
├── editionEntry.ts           启动入口，加载旧 WebView 垫片并按构建变体装配应用
├── edition.ts                标准版 / Android TV 变体标识
├── legacyRuntime.ts          旧版 Chromium / Safari 运行时 API 兼容垫片
├── main.tsx                  标准版 React 挂载与启动初始化
├── app/
│   ├── AcceptedApp.tsx      协议确认后的应用装配（AppProvider + 自动选线 + App）
│   ├── App.tsx              页面栈、布局、全局返回与键盘处理
│   ├── shell/               桌面标题栏、侧栏、窗口缩放热区
│   └── startup/             启动动画与使用协议门
├── features/
│   ├── account/             登录、个人中心、用户页与关注列表
│   ├── category/            分类与频道页
│   ├── discover/            专题与标签页
│   ├── feed/                首页、列表播放、详情面板、标签门、触屏长按
│   ├── playback/            播放器、控制条、seek、恢复与媒体传输
│   ├── posts/               图文列表、正文页与热度数据处理
│   ├── search/              搜索、排行榜、标签与列表内搜索
│   └── settings/            设置页、线路、代理与内容偏好编辑
├── tv/                      独立 Android TV 版页面、遥控器焦点与本地索引
├── shared/
│   ├── api/                 Tauri IPC、响应类型、平台与媒体地址封装
│   ├── model/               应用状态、账号同步、内容偏好
│   ├── network/             自动选线与网络结果观察
│   ├── storage/             存储键迁移、使用协议版本与接受记录
│   ├── diagnostics/         播放、布局和网络诊断
│   ├── lib/                 HTML 处理、剪贴板、返回处理、工具函数
│   └── ui/                  跨功能控件、卡片、图标与 iOS 风格基础控件
├── index.css                全局样式入口
└── styles/                  共用及功能样式
```

页面与专属组件在同一功能目录，例如设置页与线路选择器放在 `features/settings/`，
Feed 与评论、选集、详情面板放在 `features/feed/`。跨功能使用的卡片、标签屏蔽菜单和
使用协议内容放在 `shared/ui/`。`index.css`、`styles/` 保留固定位置和已有导入次序，
本次没有按功能拆分样式或调整界面。

## 依赖与复用

- `main.tsx` 装配启动门、Provider 与 App；`app` 消费 `features` 和 `shared`。
- `features` 消费 `shared`。现有功能复用保留：Feed 和图文正文使用 `playback`；
  分类、发现、图文、用户列表使用 `search/InplaceSearch`。这些调用不经过应用壳。
- `shared` 不依赖 `app` 或 `features`。`shared/ui` 中的 Toast、筛选与偏好控件可以消费
  `shared/model`；这里是应用内共享组件，并非对外独立组件库。
- 懒加载直接指向功能内的页面文件，例如 `app/App.tsx` 动态导入
  `features/settings/Settings`。保留 `feed`、`playback` 的现有局部入口，不新增汇总
  全部页面的 `features/index.ts`，避免把按需加载页面引入启动依赖。
- 功能内新增专属组件就近放置；确有多个功能消费时再放入 `shared`。不要只因文件较小
  就搬进工具目录，也不要为单个文件建立多层目录。

## 共享状态的当前边界

[`shared/model/store.tsx`](../src/shared/model/store.tsx) 仍是一个应用 Provider，聚合导航、
主题、账号与播放偏好；Toast 列表通过独立的 `useToasts()`（`useSyncExternalStore`）订阅，避免提示弹层触发全树重渲染。

`store` 调用同目录的 `accountData` 处理账号数据缓存与同步。`accountData` 对 `store`
中的 `WatchProgress` 仅有类型引用，须保留 `import type`；`contentPreferences` 仍是独立的
external store，由多个页面共享，而非设置页私有状态。

`shared/api/api.ts` 使用 `shared/diagnostics/playbackDiagnostics.ts` 记录请求失败，诊断模块
再调用剪贴板工具。自动选线通过 `setNetObserver` 注册观察回调，API 不反向导入自动选线。
因此诊断留在共享目录，不通过播放器入口导入。

## Rust 与验证文件

`src-tauri/src/api/`、`net/`、`media/`、`lines/` 分别承载命令、网络、媒体协议与线路解析。
平台壳、会话、缓存和安全策略仍保留在 `src-tauri/src/` 顶层；没有创建 `platform/` 或
`state/` 目录。完整调用路径见各子系统页。

浏览器 fixture 仍放在 `tests/`，执行脚本放在 `scripts/`；文件移动时同步修改它们对真实
页面和组件的导入。GitHub Actions 的编译与测试结果记录验证状态，目录整理本身不代表
已通过编译或运行回归。
