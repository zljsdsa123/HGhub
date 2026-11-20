# HGhubX 工程入口

这份文件给修改仓库的工程师和 coding agent 用。它不是产品说明，也不重复 README。
文档基线：2026-11-17，`codex/repo-foundation`（起点 `1d7b825`）。当前目录与依赖边界见
[`docs/architecture.md`](docs/architecture.md)；实际文件以工作区为准，不要凭旧路径猜文件。

## 先读什么

1. [`docs/subsystems/README.md`](docs/subsystems/README.md)：找到你要改的子系统。
2. 对应子系统页：责任边界、事实来源、运行时路径、状态转换、失败行为、验证命令。
3. [`docs/code-standards.md`](docs/code-standards.md)：本仓库的评审规则。
4. [`docs/lessons.md`](docs/lessons.md)：已经造成过回归、以后必须检查的教训。

只改一个面板、一个缓存或一条播放路径时，仍然先读它所在子系统的整页。不要从
组件文件名推断契约；以页面列出的 Rust 命令、前端 key 和状态检查为准。

## 命令

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:smoke
cargo test --manifest-path src-tauri/Cargo.toml --lib
make check
```

- `pnpm build` 分别按 `tsconfig.json`、`tsconfig.node.json` 和 `tsconfig.tests.json` 执行三次 TypeScript 检查，再执行 Vite 构建。
- `pnpm test:smoke` 运行不需要 ffmpeg、真实 Tauri 宿主或上游网络的稳定浏览器用例。
- `make check` 当前执行 `test-rust`、`test-web`、`docs`、`budget`、`release-check`；**不包含** `test:smoke`。
- `make release-check` 检查版本字段和 Android `versionCode`；发版由 CI 执行，不在本地发布。
- 完整播放回归用 `pnpm test:playback`；它需要 FFmpeg 和 Chromium，属于手动诊断而非 PR smoke。

CI 是验证记录。命令写了不等于已经运行；报告里必须写清命令、输入、字面结果和退出状态。
维护者指定的构建、测试依赖镜像不得擅自替换，也不得新增自动换源回退。镜像请求失败时，
记录失败步骤、原始错误、退出状态与 Actions 链接；可在同一镜像重跑，换源前须获维护者明确同意。

## 一屏架构

### 前端

- `src/editionEntry.ts`、`src/legacyRuntime.ts`、`src/main.tsx`：加载旧版 WebView 垫片，按构建变体挂载标准版或 `src/tv/`（Android TV 版），并在使用协议确认后装配应用 Provider 和自动选线。
- `src/app/`：`App.tsx` 负责页面栈、桌面/移动布局和全局交互；`shell/` 放窗口控件，
  `startup/` 放启动门。
- `src/features/`：按 `account/category/discover/feed/playback/posts/search/settings` 归组页面、
  专属组件与 hooks。Feed 的详情/评论/选集面板、设置页的线路/代理控件都随功能放置。
- `src/tv/`：独立 Android TV 版页面、焦点导航、本地片库与播放界面。
- `src/shared/`：`api`（IPC 与响应类型）、`model`（应用/账号/内容偏好状态）、`network`（自动选线）、
  `storage`（存储键与协议版本）、`diagnostics`、`lib`、`ui`（跨功能控件）。
- `src/shared/model/store.tsx` 仍聚合导航、账号与播放偏好；这次目录迁移没有拆 Provider。
  `shared/ui` 可消费 `shared/model`，不是独立的无状态控件库。
- 依赖以 `app → features/shared`、`features → shared` 为主；现有 `feed/posts → playback`、
  列表页 → `search/InplaceSearch` 是明确的功能复用。`shared` 不反向依赖 `app/features`。
- 页面懒加载直接指向功能内的页面文件；不要新增汇总全部页面的 barrel。`src/index.css` 与
  `src/styles/` 保持固定位置，避免目录整理改变样式加载次序。

### Rust

- `src-tauri/src/api/`：Tauri command 与上游 endpoint，按 account/feed/video/interact/update/platform/lines 分文件；GitHub Release 更新检查与版本对比在 `updater.rs`。
- `src-tauri/src/net/`：`line`（线路状态）、`proxy_env`、`client`（客户端缓存/DNS/GET）、
  `redact`、`edge`（信封/重试/字节下载）；网络诊断与草稿代理探测在 `net_diag.rs`；共享 statics 和测试在 `mod.rs`/`tests.rs`。
- `src-tauri/src/media/`：图片、HLS、分片、Range、响应整形和本地媒体协议入口。
- `src-tauri/src/lines/`：`mirror`、`probe` 负责固定/发布镜像/自定义线路、探测与自动选线；无状态发布页与 JS-as-data 解析在 `publish_parser.rs`。
- `src-tauri/src/ios_layout.rs`、`ios_media_http.rs`、`linux_http.rs`、`linux_webview.rs`、
  `macos_titlebar.rs`：按 `cfg` 编译的平台壳；Windows/Android 的壳逻辑部分在 `lib.rs` 与前端。
- `src-tauri/src/session.rs`、`cache.rs`、`env.rs`、`playback_log.rs`、`network_policy.rs`：
  当前的 state/安全基础设施；逻辑上归 `state`，物理上尚未收进目录。
- `src-tauri/src/lib.rs`：只做插件、状态、窗口、协议和 `generate_handler!` wiring。

依赖方向：`api` 可依赖 `net/lines`，`media/platform` 可依赖 `net`；`net/media/lines` 不依赖
`api`，也不依赖 Tauri command 名。平台差异放在 `cfg` 模块，不要扩散到业务函数。

## 不可协商的不变量

1. **未知不是空。** `favoritesKnown=false` 表示收藏状态未知；读取失败不得显示“还没有收藏”。
2. **作用域和代次进 key。** 详情、播放、动作和标签门至少包含 `accountScope`、`lineEpoch`；
   播放器还要有 `permissionKey`/`playKey`。旧账号、旧线路或旧标签代次的结果必须丢弃。
3. **凭据绑定 origin 和会话代次。** `SessionStore` 只把 token 交给同一 `origin` 和同一 revision；
   切线路、退出或重新登录后，旧异步任务不能写回新会话。
4. **播放恢复有上限。** 每个连续故障期最多 4 次 HLS 恢复；只处理 fatal network/media；
   `MANIFEST_LOAD_ERROR`/`MANIFEST_LOAD_TIMEOUT` 用 `loadSource`，其他用 `startLoad(time)`；
   页面被覆盖时不发恢复请求；保留播放时间、倍速和显式暂停意图。
5. **媒体只走本地路由。** 前端只把 `/img`、`/hls`、`/seg` 交给本地协议；iOS AVFoundation
   只使用 `media_http_origin()` 启动的 capability loopback；Linux GStreamer 只使用
   `127.0.0.1:17650`。不得把这些路由扩成通用开放代理或任意路径转发。
6. **安全模式默认开启。** 外部 URL 要经过 scheme/主机/IP 检查、DNS 固定和逐跳重定向检查；
   禁止 HTTPS 降级和普通内网/回环目标（FakeIP 例外）；不得为新功能放宽 CSP、Origin 白名单或
   `trusted_auth_origin`。
7. **存储先写新键，再清旧键。** 运行期只写 `hghubx_*`；`hghub_*`、`hg.autoLine` 只在旧值已成功
   写入新键后删除。写入失败保留旧数据；清缓存不得删除登录、收藏、观看记录或偏好。
8. **Tauri 接口是契约。** command 名、参数名和 JSON 形状不能随纯移动改变；Serde 的
   `camelCase` 字段与前端类型必须同步。移动 handler 后先改 `lib.rs` 的 `generate_handler!`。
9. **一次只做一个目标。** 纯移动和行为修复分开；修复必须有在旧代码上失败的回归；测试不访问
   上游网络，fixture 要接近真实响应；尺寸预算只能在搬走关注点后下调。
10. **日志不含秘密。** 不记录 token、Cookie、代理认证、播放直链、查询参数或密钥内容；
    错误链由 `err_text`/`redact_error_proxy_auth` 脱敏，诊断只输出协议/主机/端口和固定资源编号。
11. **新增测试必须先经维护者同意。** 任何新增测试文件、场景或用例，先向维护者说明
    它验证什么、为什么现有测试覆盖不了，得到明确同意后才能加入。既有测试的断言适配
    （契约变化导致的 fixture/断言更新）不算新增，但不得借适配削弱覆盖。测试体系保持
    最精简：一个契约一个回归，不重复建同义用例。

## 变更协议

1. 在对应子系统页确认责任边界和事实来源；不确定的写成“待核实”，不要写进不变量。
2. 先决定这是纯移动还是行为变更。纯移动只改路径/import/注册，Tauri 名称和 JSON 不变。
3. 行为变更先加能在旧代码上失败的测试，再做最小修复；同时更新 owning subsystem 页。
4. 回归补一行 `docs/lessons.md`，并指向实际测试或代码路径；不要编造 issue/PR 编号。
5. 运行与改动风险匹配的命令，记录字面输出和退出状态；不把“看过代码”写成“测试通过”。
6. 一个 PR 只解决一个目标。发版、签名和 Release 由维护者/CI 执行，agent 不自行 tag 或发布。

## 提交格式

单行英文 Conventional Commits 主题，不写 body。规则自包含：模板内联在本节，不引用历史提交
作为格式来源（历史可能被改写或删除）。

- 形状 `type(scope): subject`；跨类型/子系统用逗号并列：`fix(playback,startup):`、`ci,test,docs:`。
- type 取 `feat` / `fix` / `test` / `docs` / `refactor` / `ci` / `chore`；scope 用子系统或功能名
  （`session`、`account`、`feed`、`playback`、`tv`、`ui`、`lines`、`startup` 等），纯文档/CI 可省 scope。
- subject 用小写英文祈使句，一句话说清改了什么，句尾不加句号；关联 issue/PR 直接写编号（`#155`）。
- 合并提交保留结构前缀：`Merge PR #N into <branch>: <英文 subject>`；其余一律单行主题。
- 回归的维护者批准、红→绿证据与验证命令写进 PR 描述，不写进 commit body。
- 回归与对应修复成对或相邻提交，保证 CI 可按提交二分；提交信息不得声称未运行过的验证。

内联示例（模板，非历史引用）：

```text
feat(playback): highlight the bottom scrub rail during horizontal drag
fix(session,startup): keep the launch overlay until agreement back handling settles (#155)
docs: sync subsystem contracts for the staged release
chore(release): prepare 2.3.0
Merge PR #152 into staging: bottom scrub rail highlight and TV launch PIN
```

## PR 描述格式

中文两段式，骨架内联如下（不引用既有 PR 作为格式来源）：

```markdown
Closes #N            <- 仅关联 issue 时保留

## 变更概览
1. **行为标题**
   - 用户可见的前后变化；涉及文件用反引号路径；docs 同步在本条内说明。
2. **行为标题**
   - ...

## 验证记录
- `命令` -> 字面结果（exit `0`）。
- 先红后绿的回归用表格：| 用例 | 旧代码失败现象 | 修复后 |。
```

- 按行为而非文件罗列；一个 PR 只解决一个目标。
- 不写未运行过的验证；新增常驻测试须先经维护者同意（不变量 11），未获批时写明实测方式与
  「常驻回归待核实」。

## Release 描述格式

中文发布说明，标题 `HGhubX vX.Y.Z`；骨架内联如下：

```markdown
# HGhubX vX.Y.Z

一句话概括本版主题；覆盖范围（桌面/移动/TV 或本轮修复面）。

## 新增与优化
1. **行为标题（#N）**：用户可见效果与入口路径。

## 修复
1. **行为标题（#N）**：症状 -> 修复后行为。

## 安装与兼容提示
- 各平台产物与安装方式；升级/覆盖安装的数据保留行为；已知限制。

## 致谢
- 贡献者/反馈者（可省）。

## 验证
- 各平台 CI job 结果与 run id；实机/浏览器回归结论。
```

- 条目按行为编号加粗；issue 编号可引（issue 不随提交删除），不引 commit sha 作为说明来源。
- 无内容的段整段省略，不留空标题；不写未运行过的验证。
- 发布由维护者/CI 执行；agent 只起草正文，不 tag、不 publish。
- 模板文件为 `docs/release-notes/TEMPLATE.md`；正式正文写 `docs/release-notes/<tag>.md`，release job 读它作正文。

## 其他文字（docs / lessons / UI 文案 / issue）

- 简体中文；全角标点 `，。；：（）`；UI 标签与按钮名用「」；代码、命令、路径、存储键用反引号。
- 日期 `YYYY-MM-DD`；不编造 issue/PR/commit 编号；不确定写「待核实」。
- `docs/lessons.md` 行格式：`| 日期 | 主题 | 症状 | 根因 | 规则 | 回归测试或来源 |`，
  来源指向真实测试或代码路径。
- 英文只出现在：commit subject、代码标识符、命令与字面输出、CI job 名。
- 风格规则一律内联模板自包含；历史提交/PR/Release 可能被改写或删除，不得作为格式定义的唯一来源。
