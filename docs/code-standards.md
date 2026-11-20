# 代码标准

这些规则来自本仓库已经发生过的回归和现有边界，不是通用风格建议。评审时先看改动是否违反
下面的规则，再看实现细节。无法确认的历史写成“待核实”，不要补造 issue/PR 编号。

## 1. 一次变更只服务一个目标

一个 PR 只做一件事：修一个 bug、搬一个关注点、加一个接口，或改一个文档契约。不要顺手格式化、
重命名、升级依赖或修无关测试。

例：`3d075a2` 把播放恢复、媒体缓存代次和收藏状态放在同一个修复轮次，是因为它们共享一次
发布回归；日常改动不应模仿这种打包。纯移动（如 `src/features/playback/`、`src-tauri/src/api/`）
必须和行为修复分开，否则 review 无法区分“路径变了”和“行为变了”。

检查：`git diff --stat` 是否只出现目标文件；PR 描述能否用一句话说清目的。

## 2. 纯移动保持契约不变

移动文件/函数时，Tauri command 名、参数名、Serde JSON 形状、前端调用名、HTTP 路由和 m3u8
改写规则都不变。Rust handler 移动后先改 `src-tauri/src/lib.rs` 的 `generate_handler!`，再编译。

例：`src-tauri/src/api/mod.rs` 用 `pub use account::*` 等 re-export 保住命令注册；`api/mod.rs`
顶部明确写“Tauri command names stay unchanged”。`src-tauri/src/media/mod.rs` 的 `LOCAL_ORIGIN`
和 `src/shared/api/api.ts` 的 `LOCAL` 是跨语言契约，移动时只能改 import，不能改值。

检查：移动前后跑同一组命令/fixture；`git diff -w` 只应看到路径和 `use`。

## 3. 未知不是空

读取、解析、同步失败意味着“未知”，不能写成空数组、空对象、`false` 或“没有”。未知状态要有
独立字段和 UI，不能靠 `length === 0` 推断。

例：`src/shared/model/accountData.ts` 的 `favoritesKnown` 只有在 `api_me` 返回
`interactions.favorite_video_ids` 数组时才置 true；失败或缺字段保持 false。
`src/features/account/Profile.tsx` 用 `favoriteStateUnknown` 显示“收藏状态未知”，绝不显示“还没有收藏”。
回归是 `scripts/test-account-sync-empty-state.mjs` 的五个场景。

检查：新增状态时问“失败和成功空结果是否可区分”；测试必须覆盖失败、缺字段、同步中和真正空。

## 4. 作用域和代次进入 key

任何异步读取、缓存、动作和标签判断的 key 至少包含 `accountScope` 和 `lineEpoch`；播放器还要有
`playKey`/`permissionKey`，账号请求还要带 `expectedUserId`/`expectedOrigin`。返回时重新比较，
旧作用域的成功响应也必须丢弃。

例：`src/features/feed/useFeedDetails.ts` 的 single-flight key 是
`` `${accountScope}:${lineEpoch}:${id}` ``；`Feed.tsx` 的 `actionContext` 比较
`accountScope/lineEpoch/id/ep/kind`；`src-tauri/src/api/mod.rs` 的 `account_request()` 在请求后
再检查 `base()` 和 `SessionStore::is_current()`。`dc74ff0` 修的就是 `lineEpoch` 已存在却没被
请求 key 使用，导致切线路后失败数据不重拉。

检查：新增缓存先写 key 组成；模拟“请求进行中切换账号/线路”，旧结果不能落地。

## 5. 读取失败保留旧数据

读取失败不能清空已有对象、偏好、历史或旧键。写入失败要保留可继续使用的旧值，并把错误暴露给
用户或日志；不能先删除再尝试写。

例：`src/shared/storage/storage.ts` 的 `readStorage()` 只有新键写入并回读一致后才删除旧键；写/删失败时旧键
仍在，下次启动继续读。`src/shared/model/contentPreferences.ts` 写入失败仍更新内存快照并设置
`storageError`；`src/shared/model/accountData.ts` 的 `syncAccount()` 失败不会把 `favs` 清空。

检查：用配额不足、`SecurityError`、损坏 JSON 三种 fixture 复现；刷新后旧数据仍在。

## 6. 行为修复必须先有一个会失败的测试

先写能在旧代码上失败的回归，再做最小修复。测试要断言用户可见行为或契约，不是实现细节；
如果旧代码也能过，这个测试没有证明力。

例：`73c6610` 修“seek 后无条件续播”，回归在 `tests/player-seek.tsx` 断言原本暂停时 seek 后仍
暂停；`scripts/test-account-sync-empty-state.mjs` 先验证同步中/失败不能显示“还没有收藏”。
提交/PR 描述写清“没有这个改动时哪条断言失败、失败信息是什么”。

检查：在临时 stash/旧 commit 上跑新测试应失败；恢复修复后应通过。不要把“跑过测试”当成
“测试会在旧代码上失败”。

## 7. 测试不访问上游网络，fixture 要接近真实形状

浏览器测试在各自脚本中阻断外部请求；Rust 联网测试标
`#[ignore]`，通过显式环境变量运行。fixture 要保留真实信封/字段/错误形状，不能只造一个
`{items: []}` 让测试过。

例：`src-tauri/src/net/tests.rs` 的代理探测测试构造真实的
`{"status":1,"data":{"items":[...],"pagination":{...}}}`，并验证 POST 信封、无 Authorization；
`media/mod.rs` 的 `live_play_chain` 标 `#[ignore]`，因为依赖上游实时地址；
`scripts/test-smoke.mjs` 只跑不需要 ffmpeg/真实 Tauri/上游的七个套件：`api-loading`、
`storage-migration`、`line-selection`、`diagnostic-copy`、`ui-feedback`、`home-controls`、`account-sync`（最后运行）。

检查：测试进程是否能离线通过；fixture 是否包含 `status` 包装、分页、可选字段缺失和错误页。

## 8. 尺寸预算只能降，不能靠删注释过关

热点文件的预算是“关注点已经搬走”的结果，不是风格指标。`tools/size-budgets.json` 的目标只能
在拆分 PR 中下调；`scripts/check-size-budgets.mjs` 计非空非注释代码行，`--update` 默认拒绝提高。
唯一的例外是纯文件→目录移动：允许记录一次实测目录基线，但必须保留 `previous` 并证明增量只来自
模块声明/`use` 头；行为代码或关注点不得增加。

例：`src/features/feed/Feed.tsx`、`src-tauri/src/net`、`src-tauri/src/api`、
`src-tauri/src/media`、`src-tauri/src/lines` 各有预算。搬出 `useFeedDetails`/`media::hls`
后同步下调；如果超了，先搬关注点，不要删注释或压成一行。

检查：`node scripts/check-size-budgets.mjs`；移动文档后运行
`node scripts/check-doc-links.mjs`；预算变更只应出现在拆分 PR，行为代码只能下降。

## 9. Tauri command 和 JSON 是跨语言契约

命令名、参数名、`Option`/`null`、Serde `rename_all` 后的 camelCase 字段和前端 `invoke` 类型
必须同步。新增/移动 command 要同时改 `generate_handler!`、`src/shared/api/api.ts` 的封装和类型；不要只改
Rust 或只改前端。

例：`src-tauri/src/cache.rs` 的 `CacheClearReport` 用
`#[serde(rename_all = "camelCase")]`，测试断言 `webCache` 而不是 `web_cache`；
`src/shared/api/api.ts` 的 `clearCache` 返回 `{webCache, platform}`。`src-tauri/src/api/mod.rs` 的
re-export 让命令名在目录化后保持不变。

检查：`pnpm build` 的测试 tsconfig 能否发现前端类型漂移；Rust 序列化测试是否断言实际 JSON 键。

## 10. 安全默认不能为新功能放宽

严格模式默认开启；新增 URL、重定向、代理、媒体路由或本地监听器时，必须沿用
`network_policy` 的 scheme/主机/IP 检查、逐跳重定向和地址固定。不得为了“能播”放宽 CSP、
`allowed_frontend_origin`、`trusted_auth_origin` 或把 loopback 扩成通用代理。

例：`src-tauri/src/lib.rs` 的 `hg` 协议只服务 `/img`、`/hls`、`/seg`，缺 Origin 的 Android
请求仍要过 `media::handle` 的目标校验；`src-tauri/src/media/response.rs` 禁止把 m3u8 当
Range 截断；`src-tauri/tauri.conf.json` 的 CSP 只允许本地 scheme 和 IPC。`src-tauri/src/api/mod.rs`
的测试还断言 capability 不暴露 `opener:*` 权限。

检查：新增 origin/路由是否有负向测试；CSP diff 是否只增加了必要的本地媒体源。

## 11. 存储迁移先写新键，再清旧键

旧键只在升级时读取；运行期只写新键。写入并回读成功后才能删除旧键；失败保留旧数据。一次性
迁移要用独立标记，不能覆盖用户后来显式选择的设置。

例：`src/shared/storage/storage.ts` 的 `readStorage()` 和 `LEGACY_KEYS`；`src/shared/model/store.tsx` 的 `swipeEp` 迁移用
`STORAGE_KEYS.swipeEp` 标记，只在未迁移时把旧默认 `false` 改成 `true`。回归是
`scripts/test-storage-migration.mjs` 的写/删失败和旧数据场景。

检查：配额不足、旧键存在、新旧键冲突、迁移后重启四种情况都要有断言。

## 12. 契约变了，同一 PR 更新文档

行为、接口、状态转换、兼容性或失败行为改变时，更新 `docs/subsystems/` 的 owning page；纯内部
重构不改契约则只修失效链接/命令。真实回归在 `docs/lessons.md` 加一行，并指向实际测试或代码
路径。

例：改 HLS 恢复上限要更新 `playback.md`；改 `favoritesKnown` 语义要更新
`storage-and-preferences.md` 和 `feed-and-detail.md`；改 CI/版本字段要更新 `build-release.md`。
文档只写当前行为，提案留在 issue/PR，不混进子系统页。

检查：PR 是否包含 owning page 的 diff；`grep` 是否还有指向已移动文件的旧链接；新命令是否
写进验证段。
