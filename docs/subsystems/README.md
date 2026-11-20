# 子系统参考

这些页面描述**当前代码的实际行为**，不是提案、路线图或历史调查。开始改动前，先读
你触碰的子系统页，再沿着“事实来源”去核对代码。历史排查记录在
[`docs/investigations/`](../investigations/)，操作与复核记录在
[`docs/operations/`](../operations/)。

先按功能找文件时，读 [目录与依赖关系](../architecture.md)。前端已按 `app/features/shared`
归组；本页按运行时职责索引，同一职责可能跨前端功能目录和 Rust 模块。

| 子系统 | 当前页面 | 主要边界 |
| --- | --- | --- |
| 播放 | [playback.md](playback.md) | Feed/详情播放器、HLS 恢复、seek、进度、iOS 原生媒体、Linux GStreamer |
| Feed 与详情 | [feed-and-detail.md](feed-and-detail.md) | 请求/缓存键、标签门、详情/评论/选集、预取、动作作用域 |
| 上游线路 | [upstream-lines.md](upstream-lines.md) | 固定线路、发布镜像、自定义线路、JS-as-data、探测与持久化 |
| 网络、代理与媒体 | [network-proxy-media.md](network-proxy-media.md) | edge 信封、客户端缓存、系统代理、DNS、重定向、媒体代理 |
| 平台壳 | [platform-shells.md](platform-shells.md) | iOS、macOS、Linux、Windows、Android 的 `cfg` 与本地传输 |
| 存储与偏好 | [storage-and-preferences.md](storage-and-preferences.md) | `hghubx_*`、旧键迁移、账号/会话作用域、清缓存 |
| 构建与发布 | [build-release.md](build-release.md) | pnpm/Tauri 构建、CI、版本同步、iOS/Android 产物 |

## 更新规则

只写当前行为；提案写进 issue/PR，不混进这里。

当行为、接口、状态转换、兼容性或失败行为改变时，**同一个 PR** 必须更新 owning page。
纯内部重构只要不改变上述契约，就不需要改 prose；但仍应更新失效的文件链接和验证命令。

目录迁移时同步更新本页、架构页与相关子系统页的路径；描述以实际文件为准，不把目标目录写成
已经完成的结构，也不把路径迁移写成状态或业务逻辑重构。
