# 封面与播放列表缓存对比

对比基准：Minireel/HGhubX `8665ffcaa553bc6eb1b52629fd91b35cc6e02678`。检查对象为 2026-11-08 当前工作区代码，包括尚未提交的修改。基准提交已在本地仓库中，使用 `git show`/`git diff` 比对，未访问上游接口。首次核查发现子播放列表缓存指令被收紧；后续按保持上游行为的要求，已将该成功响应恢复为 1 小时缓存。

## 内置内存缓存

| 项目 | 基准提交 | 当前代码 | 结论 |
| --- | --- | --- | --- |
| 封面 `IMG_CACHE_MAX` | 240 条 | 240 条 | 未缩小、未关闭 |
| 主播放列表 `PL_CACHE_MAX` | 60 条 | 60 条 | 未缩小、未关闭 |
| 缓存键 | 完整 URL | 完整 URL | 相同，签名/查询参数改变会产生不同条目 |
| 命中行为 | 下载前查内存，命中直接返回 | 相同 | 保留 |
| 写入行为 | 下载处理后写入 | 相同 | 保留；播放列表新增格式校验，错误页不入缓存 |
| 淘汰行为 | 达到上限后移除 HashMap 中一个条目 | 相同 | 未改成更小容量或更短 TTL |
| 清空入口 | `cache_clear` → `media::clear_caches()` | 相同 | 没有新增自动清空调用 |

`cache_put`、`load_image`、`clear_caches` 函数去除空白后与基准一致。`load_playlist` 仍在请求网络之前读取 `PL_CACHE`，成功改写后仍调用 `cache_put(..., PL_CACHE_MAX)`。两项缓存均为进程内存，重启后丢失，与基准一致；容量单位是条目数，不是 MiB。

网络层新增的 30 秒 `CLIENT_TTL` 用于 HTTP 客户端/DNS 检查结果复用，不是封面或播放列表内容缓存的有效期。

## HTTP 缓存指令

| 资源路径及实际内容 | 基准提交 `Cache-Control` | 当前代码 | 结论 |
| --- | --- | --- | --- |
| `/img` 封面成功响应 | `public, max-age=86400` | 相同 | 未改变 |
| `/hls` 主播放列表成功响应 | `no-store` | 相同 | 原本就如此，不影响 Rust 的 60 条内存缓存 |
| `/seg` 视频分片/密钥 | `public, max-age=3600` | 相同 | 未改变 |
| `/seg` 内的子播放列表 | 按普通分片处理，`public, max-age=3600` | 识别后改写内部 URI，`public, max-age=3600` | 缓存指令已恢复一致，保留 URI 改写 |

最后一项在当前 `media::segment_response` 中按响应类型或 `#EXTM3U` 内容识别。子播放列表走 `fetch_bytes` 后直接生成响应，不使用 `PL_CACHE`；基准提交的这条 `/seg` 路径也不使用 `PL_CACHE`。此前该成功响应曾使用 `no-store`，但主播放列表的 60 条内存缓存始终没有因此关闭。

子播放列表的变化伴随嵌套播放列表 URI 改写，确保内层媒体地址继续经过本地代理。URI 改写和 HTTP 缓存时效相互独立，没有现有功能要求将成功响应设为 `no-store`，所以已恢复上游的 `public, max-age=3600`。解码失败及错误响应仍使用 `no-store`，原有 URI 改写、内容类型识别和安全检查保留。实际 WebView 是否复用自定义协议响应，仍需结合内核行为和实机请求记录判断。

## 检查位置

- `src-tauri/src/media.rs`：容量常量、读写/淘汰逻辑、`load_image`、`load_playlist`、`segment_response`、`handle`。
- `src-tauri/src/api.rs`：`cache_clear` 命令；前后都只有这一处生产代码调用 `clear_caches`。
- `src/api.ts`、设置页：本地媒体协议映射及用户主动清理缓存入口。
