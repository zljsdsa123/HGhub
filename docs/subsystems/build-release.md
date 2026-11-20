# 构建与发布

## 责任与边界

构建子系统负责前端打包、Tauri 桌面/移动构建、CI 门禁、版本字段同步、平台产物命名和 release
workflow。它不负责产品功能；发布是维护者/CI 的动作，agent 不在本地 tag、签名或上传 Release。

平台签名密钥只在 GitHub Actions secrets 中存在：Android keystore、iOS 未签名包说明和 macOS
ad-hoc 签名都不应进入仓库或本机脚本输出。

## 事实来源

- 前端脚本与版本：[`package.json`](../../package.json)、[`vite.config.ts`](../../vite.config.ts)、
  [`tsconfig.json`](../../tsconfig.json)、[`tsconfig.node.json`](../../tsconfig.node.json)、
  [`tsconfig.tests.json`](../../tsconfig.tests.json)。
- Tauri 配置：[`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json) 的
  `beforeBuildCommand`、`bundle`、`bundle.android.versionCode`；
  [`tauri.macos.conf.json`](../../src-tauri/tauri.macos.conf.json)、
  [`tauri.linux.conf.json`](../../src-tauri/tauri.linux.conf.json)、
  [`tauri.ios.conf.json`](../../src-tauri/tauri.ios.conf.json)、
  [`tauri.tv.conf.json`](../../src-tauri/tauri.tv.conf.json)。
- Rust 版本：[`src-tauri/Cargo.toml`](../../src-tauri/Cargo.toml) 的 `[package].version`、
  `custom-protocol` feature；[`src-tauri/Cargo.lock`](../../src-tauri/Cargo.lock) 的 `hghubx` 包。
- CI/CD（全仓唯一工作流）：[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)，
  合并了日常校验（`frontend`、`rust`、`smoke`、`playback` 矩阵）与发版构建（`windows`、
  `android` 标准/TV 矩阵、`macos`、`ios`、`linux`、`release`），每次事件只产生一条运行记录。
- 版本/预算门禁：[`scripts/set-version.mjs`](../../scripts/set-version.mjs)、
  [`scripts/check-version-sync.mjs`](../../scripts/check-version-sync.mjs)、
  [`scripts/check-doc-links.mjs`](../../scripts/check-doc-links.mjs)、
  [`scripts/check-size-budgets.mjs`](../../scripts/check-size-budgets.mjs)、
  [`tools/size-budgets.json`](../../tools/size-budgets.json)。
- iOS/TV 打包：[`scripts/build-ios-unsigned.sh`](../../scripts/build-ios-unsigned.sh)、
  [`scripts/build-android-tv.mjs`](../../scripts/build-android-tv.mjs)、
  [`scripts/patch-android-tv.mjs`](../../scripts/patch-android-tv.mjs)；图标/启动屏：
  `generate-ios-icons.mjs`、`sync-ios-icons.mjs`、`patch-ios-splash.mjs`、
  `sync-android-icons.mjs`、`patch-android-splash.mjs`。
- 本地入口：[`Makefile`](../../Makefile) 的 `check`、`test-rust`、`test-web`、`test-smoke`、
  `docs`、`budget`、`release-check`。

## 主运行时路径

1. 安装依赖用 `pnpm install --frozen-lockfile`（CI 全部如此）。`pnpm build` 执行
   `tsc --noEmit`、`tsc --project tsconfig.node.json`、`tsc --project tsconfig.tests.json`、`vite build`；`vite.config.ts` 从
   `package.json` 注入 `__APP_VERSION__`，避免界面版本写死。
   Vite 构建目标是 `["chrome66","safari14.1"]`（CSS 目标 `chrome66/safari13`，Worker 格式
   `iife` 以兼容无 module worker 的 Chromium 66–79），`cssCodeSplit:false`、`cssMinify:false`；
   `scripts/legacy-css.ts`（enforce:post）在 generateBundle 阶段对汇总后的 CSS 做旧引擎回退
   （dvh、color-mix、cascade layers）、追加 `src/styles/legacy-webview.css` 并用 lightningcss
   压缩。Tailwind 插件以 `optimize:false` 运行，避免其内置优化先吃掉需要降级的语法。TV 构建脚本
   `build-android-tv.mjs` 复用同一 `pnpm build`，自动获得同一条兼容链。
2. Tauri 构建的 `beforeBuildCommand` 在 Vite 构建后跑图标生成/同步和 Android 启动屏补丁
   （iOS 启动屏补丁由 `scripts/build-ios-unsigned.sh` 执行），再打包 `dist`。桌面入口为
   `pnpm tauri build`；开发为 `pnpm tauri dev`。
3. `make check` 等价于 `test-rust` + `test-web` + `docs` + `budget` + `release-check`：
   `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`、
   `cargo test --manifest-path src-tauri/Cargo.toml --lib`、`pnpm build`、
   `node scripts/check-doc-links.mjs`、`node scripts/check-size-budgets.mjs`、
   `node scripts/check-version-sync.mjs`。它**不包含**
   `pnpm test:smoke`；smoke 由 CI 的独立 job 和 `make test-smoke` 执行。
4. CI/CD 日常校验（`pull_request`、推送 `main` 或手动 `mode=ci`）：
   - `frontend`：Node 22、pnpm 10、版本字段检查、文档链接、标准版与 TV 版 `pnpm build`、尺寸预算。
   - `rust`：Linux 系统依赖、`cargo check --all-targets`、`cargo test --lib`。
   - `smoke`：安装 Chromium，运行 `pnpm test:smoke`。
   - `playback`：优先使用运行器的 FFmpeg 和浏览器；需要安装 FFmpeg 时沿用维护者指定的
     `https://mirrors.edge.kernel.org/ubuntu/`，失败不自动换源。单次工作流并行执行 `core` 与 `extended`
     （覆盖 `seek,legacy,lifecycle,gesture,proxy,portrait-fit,ios-native,recovery,review,tv,post-flicker`）；
     `review` 场景运行 `scripts/test-round-review.mjs`（搜索返回键与网络设置检查）；账号同步/批量取消收藏
     回归 `scripts/test-account-sync-empty-state.mjs` 在 smoke 的 `account-sync` 套件中运行，不在 `review` 中重复执行。
     手动 `mode=playback` 可只跑播放诊断或指定 `scenarios` 子集（如 `pnpm test:playback --scenarios review`）。
5. CI/CD 打包与发布（推送 `v*` tag 或手动 `mode=package`）：在分支上手动运行且 `tag` 留空时，
   只构建所选范围（如 `platforms=ios` 仅验证未签名 ipa），不发布 GitHub Release。各平台构建 job 先跑
   `node scripts/set-version.mjs "$V"`：同步 `package.json`、`tauri.conf.json`（含
   `bundle.android.versionCode`）、`Cargo.toml` 和 `Cargo.lock` 的 `hghubx` 版本。
   `versionCode = major*1_000_000 + minor*1_000 + patch`，minor/patch 超过 999 会报错。
6. 平台产物：
   - Windows：NSIS 安装包 + `HGhubX_<version>_x64_portable.zip`。
   - Android 标准版与 TV 版：`android` 矩阵（`standard` / `tv`）执行 `pnpm tauri android build --apk --split-per-abi`
     （正式发布编 `aarch64 armv7 x86_64`，`quick` 编 `aarch64 armv7`，显式 `android-arm64` 仅编 `aarch64`），
     按 ABI 产出并用 secrets 中的 keystore `apksigner` 签名，文件名分别为
     `HGhubX_<version>_<abi>.apk` 与 `HGhubX-TV_<version>_<abi>.apk`；随后 `aapt2 dump badging`
     打印实际 versionCode。
   - macOS：`quick` 只编 arm64；正式发布编 universal，产物 `HGhubX_<version>_universal.dmg`
     （quick 为 `_arm64.dmg`），ad-hoc 签名。
   - iOS：`pnpm tauri ios init --ci`，用 PlistBuddy 补横竖屏和 ATS，再跑
     `scripts/build-ios-unsigned.sh <version>`；Xcode `CODE_SIGNING_ALLOWED=NO`，产出
     `HGhubX_<version>_ios.ipa`。
   - Linux：`pnpm tauri build` 产出 deb，文件名 `HGhubX_<version>_amd64.deb`。
7. `release` job 依赖五个平台构建 job（其中 `android` 矩阵覆盖标准版与 TV 版），在 `!cancelled()` 且
   `windows`、`android`、`macos`、`linux` 全部成功（`ios` 允许成功或失败）时执行；发布条件是 `v*` tag ref，
   或手动 `mode=package` 且 `tag` 非空、`platforms=all`、`quick=false`。它下载已有 artifact，用
   `softprops/action-gh-release` 上传 `artifacts/*`；如果存在 `docs/release-notes/<tag>.md` 就作为正文，
   否则开启 `generate_release_notes` 自动生成说明。
   正文格式以 `docs/release-notes/TEMPLATE.md` 与 AGENTS.md「Release 描述格式」为准：维护者发布前
   按模板写 `docs/release-notes/<tag>.md`；自动生成说明只是缺文件时的兜底。

## 状态转换

- 版本：源版本（tag 或 `tauri.conf.json`）→ `set-version.mjs` 校验 `major.minor.patch` →
  写四份文件 → 平台构建。`check-version-sync.mjs` 由 `ci.yml` 的 `frontend` job 调用；
  它要求四处版本字符串一致，并检查 Android `versionCode` 与公式推导值一致。
- Android versionCode：版本号解析 → `major*1e6 + minor*1e3 + patch` → 写入
  `bundle.android.versionCode` → APK 签名 → `aapt2` 复核。
- iOS：`ios init` 生成工程 → 补 plist → 启动 Tauri options server → Xcode release 构建 →
  `CODE_SIGNING_ALLOWED=NO` → 打包 Payload → `unzip -tq` 校验 → artifact。
- CI：PR 或推送 `main` 触发 `frontend`/`rust`/`smoke`/`playback`，不打包。
  `v*` tag 触发全平台构建；手动打包用 `mode=package` 和 `platforms` 选范围，
  `tag` 留空只上传 Actions 产物，不进入发布任务。
- 发布：满足上述 tag 条件 → 等待平台 job 结束 → release job 下载已有 artifact 并合并 →
  读取版本说明 → 创建/更新 GitHub Release。在分支上手动运行且 `tag` 留空不进入发布 job。

## 约束与失败行为

- 安装播放测试依赖时，只修改临时 CI 运行器的软件源，不影响客户端的线路或本机配置。
  [CI 44402407330](https://github.com/zxsos/HGhubX/actions/runs/44402407330/job/135148647519)
  的扩展用例曾在安装 FFmpeg 前遇到镜像握手失败和连接超时，最终报
  `E: Unable to locate package ffmpeg`（退出 `100`），未执行播放用例。为绕开该故障曾临时添加
  Ubuntu 官方归档源回退；维护者确认保留原镜像后已撤销。之后遇到相同失败，按环境故障记录，
  保持原镜像重跑；替换镜像或添加换源回退前须获明确同意。

- 版本字段必须同步：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、
  `src-tauri/Cargo.lock` 的 `hghubx`。只改一处会造成“关于页/更新检查/安装包”版本错位。
- `custom-protocol` feature 不能删；Tauri 打 iOS/桌面包会传这个 feature，缺失会导致
  `tauri ios build` 直接报错。
- 尺寸预算按关注点只降不升：`check-size-budgets.mjs` 计非空非注释代码行；`--update` 默认拒绝
  提高预算，必须先搬走关注点。纯文件→目录移动若新增模块/`use` 头，必须在配置中保留
  `previous` 和原因，行为代码不能增加。删注释不能过关。
- Android release 缺 `ANDROID_KEY_BASE64` 必须失败，不能产出未签名包冒充 release；签名后
  必须复核 APK 里的 versionCode。
- iOS 是 unsigned ipa，不能宣称可直接安装/上架；真机安装需要用户自己的签名流程。
- CI 失败不能靠删测试/放宽断言修绿；平台专属测试应 `cfg` 或拆 job，联网测试保持 `#[ignore]`
  并显式运行。
- agent 不执行 `git tag`、不创建 GitHub Release、不上传 secrets/产物；发布由维护者或受保护的
  workflow 完成。

## 验证命令

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:smoke
cargo test --manifest-path src-tauri/Cargo.toml --lib
make check
node scripts/check-doc-links.mjs
node scripts/check-version-sync.mjs
```

`make check` 不包含 smoke；需要浏览器用例时单独 `pnpm test:smoke`（含 `account-sync`；账号 fixture
也可单独用 `node scripts/test-account-sync-empty-state.mjs` 运行）。`pnpm test:playback` 需要
FFmpeg/Chromium，iOS 打包校验通过 `ci.yml`（`mode=package, platforms=ios`）在 macOS runner 执行。
报告里必须写清命令、版本/输入、字面结果和退出状态；没有运行的命令不能写成“已通过”。
