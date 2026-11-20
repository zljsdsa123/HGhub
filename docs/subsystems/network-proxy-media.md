# 网络、代理与媒体

## 责任与边界

网络层把业务调用收敛到上游的 `POST /api/edge/request` 信封，并负责 HTTP 客户端缓存、系统/自定义
代理、DNS 解析与地址固定、逐跳重定向、超时与有限重试、诊断和脱敏。媒体层复用同一套网络策略，
把封面、HLS 清单、密钥和分片经本地路由交给 WebView/原生播放器。

不在这里负责：线路候选与持久化（见 [upstream-lines.md](upstream-lines.md)）、播放器的 HLS 恢复
状态机（见 [playback.md](playback.md)）、平台监听器的生命周期（见
[platform-shells.md](platform-shells.md)）。

## 事实来源

- edge 与重试：[`src-tauri/src/net/edge.rs`](../../src-tauri/src/net/edge.rs) 的 `edge()`、
  `edge_operation()`、`edge_redirect_target()`、`with_retry()`、`retryable_error()`、
  `fetch_bytes()`。
- 客户端与 DNS 固定：[`src-tauri/src/net/client.rs`](../../src-tauri/src/net/client.rs) 的
  `build_client()`、`ProxyRoute`、`client_key()`、`client_for_dns()`、
  `CLIENTS`、`CLIENT_TTL`、`refresh_client()`、`RequestScope`、`request_scope()`、
  `refresh_media_scope()`、`system_proxy_fingerprint()`、`get()`、`get_with_dns()`。
- 代理配置：[`src-tauri/src/proxy.rs`](../../src-tauri/src/proxy.rs) 的 `Mode`、`Config`、
  `bind()`、`set()`、`normalize_proxy()`、`write_atomic()`；系统探测在
  [`src-tauri/src/net/proxy_env.rs`](../../src-tauri/src/net/proxy_env.rs) 的
  `proxy_override()`、`system_explicit_proxy()`、`gnome_proxy()`、`windows_proxy_enabled()`、
  `macos_proxy_enabled()`。
- 公网 DNS 回退：[`src-tauri/src/media_dns.rs`](../../src-tauri/src/media_dns.rs) 的 `HOST`、
  `BOOTSTRAP`、`resolve()`、`answers()`、`eligible()`、`Routes`。
- 地址策略：[`src-tauri/src/network_policy.rs`](../../src-tauri/src/network_policy.rs) 的
  `strict_security()`、`parse_target()`、`parse_target_with_mode()`、`allowed_ip()`、
  `resolve_target()`、`redirect_target()`。
- 媒体入口与整形：[`src-tauri/src/media/mod.rs`](../../src-tauri/src/media/mod.rs) 的
  `LOCAL_ORIGIN`、`handle()`、`clear_caches()`；
  [`hls.rs`](../../src-tauri/src/media/hls.rs) 的 `load_playlist()`、`rewrite_playlist()`；
  [`image.rs`](../../src-tauri/src/media/image.rs) 的 `load_image()`；
  [`segment.rs`](../../src-tauri/src/media/segment.rs) 的 `load_segment()`；
  [`response.rs`](../../src-tauri/src/media/response.rs) 的 `respond()`、`apply_byte_range()`、
  `segment_response()`。
- 诊断与脱敏：[`src-tauri/src/net_diag.rs`](../../src-tauri/src/net_diag.rs) 的
  `diagnose()`、`proxy_state()`、`test_proxy()`；
  [`src-tauri/src/net/redact.rs`](../../src-tauri/src/net/redact.rs) 的
  `redact_proxy()`、`is_proxy_error()`、`heal_client()`、`err_text()`、
  `redact_error_proxy_auth()`。

## 主运行时路径

1. `Api::get/post/authed` 调 `edge(origin, method, path, body, token)`。逻辑 method/path/body 被
   序列化后 Base64 放进信封，实际 HTTP 始终是 `POST {origin}/api/edge/request`；响应要求
   `status == 1`，否则取 `msg` 作为错误。`401`/`403` 统一折叠成 `401`，避免把权限错误误判为
   可重试网络错误。
2. `with_retry()` 只对逻辑 GET、无 body 的请求重试，最多 3 次；408/425/429/5xx、超时/连接类
   错误可重试，401、404、403、地址策略拒绝和重定向错误一次即终止。重试前 `heal_client()` 会在
   3 秒节流内重建客户端，解决代理软件开关后的 tunnel error。
3. `client_for_dns()` 先做 `parse_target()`，再按严格模式、主机、端口、公网 DNS 标志和
   `ProxyRoute` 生成缓存键。直连时解析全部地址并 `check_addresses()`，把结果通过
   `resolve_to_addrs()` 固定进客户端；有代理时把域名交给代理解析。缓存 30 秒，命中不延长
   TTL，最多 64 项，配置/代理/安全模式变化会推进 generation 并清空。
4. `get_with_dns()` 关闭自动重定向，最多跟 5 跳。每一跳都重新 `parse_target()`、重新选客户端和
   固定 DNS，`redirect_target()` 拒绝跨协议降级、认证信息和非法目标。`edge()` 更严格：只有
   无 token、无 body 的游客 GET 才允许 301/302/303 迁移到新 origin；307/308、带凭据或带逻辑
   body 的重定向直接拒绝。
5. 媒体下载统一走 `fetch_bytes()`：`get_with_dns()` 取字节，失败时按
   `media_dns::eligible()` 判断是否切换公网 DNS。只对 HTTPS 域名、DNS/timeout/transport
   类错误回退；403/404/503 或地址策略拒绝不回退。成功的公网 DNS 路由按 host 记住 30 秒。
6. `media::handle()` 接受 `/img?u=`、`/hls?u=`、`/seg?u=`。`/img` 下载 AES-128-CBC 封面并
   校验图片魔数；`/hls` 拉清单并把 variant、key、init、part、media 等 URI 改写到本地
   `LOCAL_ORIGIN`，移除可派生的 URI 字段；`/seg` 下载分片或 Key，若返回 `#EXTM3U` 则继续改写，
   保证嵌套清单不泄漏原始地址。
7. `apply_byte_range()` 只处理单段 `bytes=`，支持 `start-end`、`start-`、`-suffix`；无效/多段
   范围退回完整 200，越界返回 416。m3u8 永远完整返回，避免原生播放器的 0-1 字节探测把
   `#EXTM3U` 截掉。Linux 的 loopback HTTP 还支持 HEAD，并只发送一份 `Content-Length`/CORS 头。
8. `diagnose()` 用与真实请求相同的路径做 DNS → TCP → HTTP 探测，读取 Windows 注册表、
   macOS `scutil`、Linux `gsettings` 和进程环境变量，输出 `verdict/summary/advice`。代理地址只保留
   协议/主机/端口，`NO_PROXY` 只报“已配置”，错误链中的 userinfo 替换成 `[redacted]@`。

## 状态转换

- 客户端缓存：未命中 → 解析并检查地址 → 构建 client → 写入 `(expires, client)`；
  命中且未过期 → 复用；过期/配置变化 → 重新解析，不复用旧连接绕过新检查。
- 媒体作用域：线路、严格模式、有效代理模式/地址或系统代理指纹变化 → `MEDIA_CONFIG_GENERATION`
  增加；只有 active 配置参与指纹，保存一个未启用的自定义地址不使媒体缓存失效。
- 公网 DNS：首次失败且 eligible → 翻转 `public_dns` 重试；成功 → `Routes.remember(host)`；
  后续失败或过期 → 回到系统解析路径。
- 代理：`system` 每次建客户端时重新读系统设置；`custom` 用用户保存的地址；`off` 强制
  `no_proxy()`。保存代理会推进线路选择代次，旧探测不能在新代理保存后切换线路。
- 响应：成功且 `status=1` → 返回 `data`；空 body → `Null`；业务失败 → `msg`；HTTP 401/403 →
  `"401"`；网络错误 → 保留 source chain 的脱敏文本。

## 约束与失败行为

- 严格模式默认开启。禁止 HTTPS 降级、普通内网/回环/链路本地/保留地址和危险的 IPv6 转换；
  198.18.0.0/15 的 FakeIP 是明确例外，不能当普通私网拒绝。
- 不使用自动重定向。每一跳都要重新检查 scheme、主机/IP、DNS 和固定地址；发布页/脚本额外
  要求同源，代理路径也必须保留逐跳检查，不能把安全判断交给代理。
- 只有 `reqwest` 的 `system-proxy` feature 能读取 Windows/macOS 固定系统代理；PAC 不支持。
  Android 的系统 Wi-Fi 代理不生效，只有 VPN/TUN 或显式 `HGHUBX_PROXY`。
- 媒体路由是有限入口，不是开放代理：只允许 `/img`、`/hls`、`/seg`，只接受 `u=` 目标，
  不接受任意 path/host。不得把 iOS capability 端口或 Linux 17650 扩成通用转发。
- 播放列表和分片缓存有上限；缓存键包含请求作用域（严格模式 + 媒体配置代次），旧配置的
  在途响应不能写进新作用域。
- 失败读取不伪装成空数据：错误响应、HTML 落地页、缺少 `items/pagination` 都返回错误；
  媒体层返回 502/400，不返回 200 空 body。
- 日志不写 token、Cookie、代理认证、播放直链或查询参数；只记录固定操作名、主机/端口、
  资源编号、状态、耗时和脱敏错误类别。

## 验证命令

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
node scripts/test-network-settings.mjs
node scripts/test-diagnostic-copy.mjs
node scripts/test-ios-native-media.mjs
```

`src-tauri/src/net/`、`media_dns.rs`、`media/*`、`network_policy.rs` 的单元测试覆盖信封形状、重试终止、
代理缓存键、DNS 回退、Range、嵌套清单和脱敏。联网测试标记为 `#[ignore]`，需要显式环境变量；
浏览器脚本使用本地 fixture，不证明真实 CDN 或系统代理环境。
