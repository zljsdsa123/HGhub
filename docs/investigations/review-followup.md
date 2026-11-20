# 安全审查后续复核

> 历史快照：本文保留 `security-audit` 分支当时的审查结论、提交和验证记录，不作为当前行为说明。
> 其中 P1-2 的 `Origin: null` 拒绝结论已被后续 Android WebView 兼容处理取代；当前自定义协议
> 允许缺失、空串及字面量 `null` 的 Origin，仍受媒体路由与目标地址策略约束。现状以
> [`lib.rs`](../../src-tauri/src/lib.rs) 和 [平台壳](../subsystems/platform-shells.md) 为准。

P2、P3 子编号按维护者原文的列举顺序补齐。修正均在 `security-audit`，不包含 `routing-rules` 的启动静音或规则变更。

| 编号 | 处理 | Commit | 复核结论 |
| --- | --- | --- | --- |
| P1-1 | 修正 | 54511e0 | 固定使用 tauri-plugin-opener 2.7.2 / open 5.4.5，经现有 Rust HTTP(S)/地址校验后以 with=None 调用默认处理器。Windows 启用 shellexecute-on-windows，完整 URL 交给 ShellExecuteExW，不回退 cmd。关闭自动接管链接，不授予前端 opener:* 权限；最低 Rust 调整为 1.90。 |
| P1-2 | 保持 | — | 当前门禁用 is_some_and，缺失 Origin 已获允许；Origin: null 会被拒绝。结合用户反馈的 macOS 实测，未证实该兼容问题，因此未增加 null 的泛化放行。 |
| P1-3 | 保持 | — | 锁定版本的 tauri-codegen 具有 inject_script_hashes，自动对入口 HTML 的内联脚本生成 CSP SHA-256 hash，并将其并入运行时策略。与用户 macOS 无异常的观察一致，无需 unsafe-inline，也未移除提前应用主题的脚本。 |
| P2-1 | 修正 | f3c8df1 | 注意真实传输层始终是 POST /api/edge/request 信封。仅无 token、无逻辑 body 的 GET 可跟随 301/302/303；逐跳检查 URL、DNS/固定地址及 HTTPS 降级，最多 5 跳。保留信封 POST，不让客户端自动改成 GET。307/308、带凭据或逻辑请求体的请求均拒绝。 |
| P2-2 | 修正 | d3c4094 | 客户端缓存改为按严格模式、主机、端口查询，已验证的 DNS 地址随客户端固定，30 秒 TTL 不因命中延长。到期重新解析并检查全部结果；模式/代理刷新会清空缓存。 |
| P2-3 | 补充文档 | 58ec4b5 | 明确 NAT64/DNS64、IPv6-only 和混合 DNS 答案的限制，以及兼容回退方式。仅配置 HTTP 代理不一定能修复本地 DNS64 解析。 |
| P2-4 | 修正 | efbb664 | 移除 localStorage 安全偏好。Rust security.json 是持久化真源，前端启动默认严格，收到 app_boot 后同步。设置先保存后更新有效状态；后端写入失败会返回错误并保持旧模式。保存中/尚未初始化时禁用设置开关。当前文章随 context 更新并重新清洗。 |
| P2-5 | 修正 | 19eddf2 | Feed 向面板传原始正文；ArticlePanel/文章详情只在正文或安全模式改变时重新清洗。仍保留 sanitizeHtml 函数内部完整的入口清洗、URL 重写和出口清洗。 |
| P3-1 | 修正 | 6dae653 | HLS 属性按引号处理逗号，逐个改写 URI 属性，绝对化和代理改写均覆盖所有字段。 |
| P3-2 | 修正 | e68c9b8 | 保留 DATERANGE 的时间线、SCTE-35 等非 URL 元数据；去掉 URI 字段与 X-ASSET-LIST。CONTENT-STEERING 仍禁用，防止衍生未受控请求。 |
| P3-3 | 修正 | 9d5597b | 入口和出口白名单均保留 ol 的 start，并新增编号保留回归。 |
| P3-4 | 修正 | 410c2ed | 新增 tsconfig.tests.json，以 ES2022 支持回归代码的顶层 await；pnpm build 同时检查 src 与 tests。 |
| P3-5 | 部分修正 | 9622b8c | 补齐前端已知保留 IPv4 网段。审查所说 Rust 漏掉的 2001:2::/48、2001:10::/28 已被 s[1] < 0x0200 覆盖，添加边界回归而不重复修改 Rust 策略。前端仍是粗筛，后端校验是请求权威。 |
| P3-6 | 暂不采用 | — | 这是已说明的安全/体验取舍。两个固定站点也是不同 origin；当前切站清除单份 session，且不会将旧 token 带到新站点。按 origin 保存多份凭据属于新增账号管理能力，可后续单独设计、审查和迁移；本轮不扩大凭据持久化范围。 |
| P3-7 | 修正 | f4ce4c4 | 诊断 DNS 字段只保留去重结果数量与是否包含 FakeIP；解析错误返回固定摘要，避免解析 IP 列表进入日志、剪贴板或对话框。 |
| P3-8 | 修正 | c1734fd | 仅逻辑 GET 且无 body 的请求允许重试；登录、注册和其他变更请求仅尝试一次。原有 status=0 业务错误位于重试块外，并非所有密码错误本来都会重试；网络/HTTP 错误重放风险确实存在。 |

## 验证

- 前端生产构建通过；包含官方 DOMPurify 类型与 tests 类型检查。
- Chromium：Windows/macOS 用户代理下各 31 项正文清洗回归通过；严格模式初始化、保存失败、状态一致性及已打开文章刷新共 8 项通过。
- 插件方案：Windows 目标的 Cargo feature 树确认 `open 5.4.5` 启用了 `shellexecute-on-windows`，未启用 `insecure`；没有进行 Windows 原生运行测试。新增 capability 回归，防止前端通过插件命令绕过 URL 校验。
- `cargo check --locked --offline --lib` 通过；Rust 本地回归 **26 passed / 0 failed**，原有 6 个联网测试 filtered out。覆盖新增重定向边界、30 秒缓存边界、保存失败保持模式、HLS 多 URI/时间线保留、地址筛选、DNS 脱敏和非幂等操作不重试。

本轮未重跑 Windows/macOS/Android 实机；P1-2、P1-3 的 macOS 使用情况来自用户反馈。真实上游联网测试依赖站点与 DNS，本轮按审查者的本地测试范围排除原有 6 项联网测试。

参考：[tauri-plugin-opener 2.7.2](https://docs.rs/tauri-plugin-opener/2.7.2/tauri_plugin_opener/)、[open 5.4.5](https://docs.rs/open/5.4.5/open/)、[Tauri CSP](https://v2.tauri.app/security/csp/)。P1-3 还核对了本机锁定版本 tauri-codegen 2.7.4 的 `src/context.rs::inject_script_hashes`。
