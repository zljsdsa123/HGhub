# 存储与偏好

## 责任与边界

存储子系统负责浏览器 `localStorage` 的键、旧键迁移、账号数据的本地副本、会话作用域、内容偏好和
清缓存语义；Rust 侧负责应用数据目录里的 `session.json`、`line.json`、`proxy.json`、
`security.json` 和诊断日志开关。它不负责远端账号数据的业务合并规则（见
[feed-and-detail.md](feed-and-detail.md)），也不负责媒体内存缓存的实现（见
[network-proxy-media.md](network-proxy-media.md)）。

运行期只写 `hghubx_*`。旧键只用于升级迁移，且必须先确认新值已成功写入，才能删除旧值。

## 事实来源

- 键与迁移：[`src/shared/storage/storage.ts`](../../src/shared/storage/storage.ts) 的 `STORAGE_KEYS`（`app`、`swipeEp`、
  `theme`、`autoLine`）、`LEGACY_KEYS`、`StorageKey`、`readStorage()`。
- 内容偏好：[`src/shared/model/contentPreferences.ts`](../../src/shared/model/contentPreferences.ts) 的
  `CONTENT_PREFERENCES_KEY`、`MAX_BLOCKED_TAGS`、`MAX_TAG_LENGTH`、`normalizeTag()`、
  `normalizePreferences()`、`readPreferences()`、`tagIndex()`、`blockReason()`、`update()`、
  `useContentPreferences()`。
- 本地账号：[`src/shared/model/accountData.ts`](../../src/shared/model/accountData.ts) 的 `ACCOUNT_KEY`、`CREDENTIAL_KEY`、
  `SyncState`、`favoritesKnown`、`favEpCounts`、`sanitize()`、`persist()`、`setUser()`、`syncAccount()`、`clearHistory()`、
  `removeHistory()`、`addHistory()`、`generation()`、`accountScope`、`saveCredential()`/`readCredential()`/`clearCredential()`；
  「我的」批量取消收藏协调与动作修订见 [`src/features/account/Profile.tsx`](../../src/features/account/Profile.tsx)；
  收藏观看进度与新集更新计算见
  [`src/shared/model/favoriteProgress.ts`](../../src/shared/model/favoriteProgress.ts)。
- 应用偏好：[`src/shared/model/store.tsx`](../../src/shared/model/store.tsx) 的 `Persist`、`DEFAULTS`、
  `normalizeHistory()`、`loadPersist()`、`readThemePreference()`、`LS`、
  `STORAGE_KEYS.theme`/`autoLine`。
- 会话：[`src-tauri/src/session.rs`](../../src-tauri/src/session.rs) 的 `Session`、
  `SessionStore`、`bind()`、`token()`、`snapshot()`、`stored_origin()`、`rebase_if_trusted()`、
  `rebase_or_clear()`、`reconcile_on_boot()`、
  `set_if_revision()`、`is_current()`、`update_user_if_current()`、`clear_if_current()`、`persist()`。
- 清缓存：[`src-tauri/src/api/platform.rs`](../../src-tauri/src/api/platform.rs) 的
  `cache_clear`；[`src-tauri/src/cache.rs`](../../src-tauri/src/cache.rs) 的
  `CacheClearReport`、`clear_web_cache()`、`safe_cache_types()`。
- 账号同步与批量收藏回归：[`scripts/test-account-sync-empty-state.mjs`](../../scripts/test-account-sync-empty-state.mjs)，
  由 `scripts/test-smoke.mjs` 的最后一项 `account-sync` 调用；界面未知态见
  [`src/features/account/Profile.tsx`](../../src/features/account/Profile.tsx) 的 `favoriteStateUnknown`。
- 迁移回归：[`scripts/test-storage-migration.mjs`](../../scripts/test-storage-migration.mjs)、
  [`tests/storage-migration.tsx`](../../tests/storage-migration.tsx)。

## 主运行时路径

| 运行期键 | 旧键 | 内容 |
| --- | --- | --- |
| `hghubx_app_v1` | `hghub_app_v1` | 游客偏好、收藏、关注、观看记录、收藏已知集数基线（`favEpCounts`）、搜索历史、音量、`muteOnStartup`、`swipeEp`、`preferHevc`、`fsIdleSecs` |
| `hghubx_swipe_ep_v2` | `hghub_swipe_ep_v2` | 上下划切集的一次性迁移标记 |
| `hghubx_theme` | `hghub_theme` | `light`/`dark`/`system` |
| `hghubx_auto_line` | `hg.autoLine` | 自动选线开关 |
| `hghubx_usage_agreement` | — | 使用协议版本与签署时间 |
| `hghubx_mobile_hold_guide_v1` | — | 移动端首次长按倍速教程已读标记 |
| `hghubx_tv_display_v1` | `hghubx.tv.display.v1` | TV 端缩放、过扫描与减少动效设置 |
| `hghubx_tv_playback_v1` | `hghubx-tv-playback-v1` | TV 端连播、倍速与编码偏好 |
| `hghubx_tv_pin_v1` | — | TV 端 4 位启动解锁 PIN 码开关与盐值摘要（不存明文密码） |
| `CONTENT_PREFERENCES_KEY` | — | 屏蔽标签、暂停过滤、隐藏无标签内容 |
| `ACCOUNT_KEY` | — | 按 `[origin, user.id]` 分桶的账号本地副本 |
| `CREDENTIAL_KEY`（`hghubx_credential_v1`） | — | 登录/注册成功时保存的 `{username, password, userId, origin}`，仅用于同账号 401 后的静默重登；无归属的旧值不用于重登 |

应用数据目录还保存 `session.json`（会话）、`line.json`（v2 线路）、`proxy.json`（代理）、
`security.json`（严格模式）和可选的 `playback-diagnostics.json`（诊断开关）；它们由 Rust
对应的 `bind()`/`set()` 管理，不经过 `localStorage`。

1. `readStorage(key)` 先读新键。新键存在时尝试删除对应旧键；删除失败只留到下次启动重试，不影响
   读取。新键不存在时读旧键，成功 `setItem` 并回读一致后才 `removeItem`；配额不足或禁止写入时
   保留旧键并返回旧值。任何异常返回 `null`，让调用方使用默认值。
2. `loadPersist()` 从 `STORAGE_KEYS.app` 读取应用状态（收藏、观看记录、搜索历史、音量、静音、
   `swipeEp`、`preferHevc`），用 `DEFAULTS` 合并并 `normalizeHistory()` 升级旧的 `number[]`
   观看记录。`swipeEp` 有一个一次性迁移：旧配置的 `false` 是旧默认，不视为用户显式关闭；
   迁移标记写入 `STORAGE_KEYS.swipeEp` 后才不再改用户后来选择的 `false`。
3. 主题偏好单独存 `STORAGE_KEYS.theme`（`light`/`dark`/`system`）。启动时先应用已保存主题，
   再根据 `prefers-color-scheme` 解析 `system`；解析结果不覆盖偏好本身。写主题失败只忽略，
   不阻塞界面。
4. 内容偏好存在 `CONTENT_PREFERENCES_KEY`，结构是
   `{blockedTags, paused, hideUntagged}`。`normalizeTag()` 只做 trim、压缩空白和小写化，
   不做模糊匹配；最多 200 个标签、单个 64 字符。读取失败/JSON 损坏 → 全空偏好；写入失败 →
   本次内存偏好仍生效，同时把 `storageError` 暴露给 `PreferenceStorageNotice`，重启可能回退。
5. 账号数据按 `[origin, user.id]` 分桶保存在 `ACCOUNT_KEY`，值带 `version:1`。`accountScope`
   是 `${key}:${generation}`，`generation` 在登录/退出/切换账号时递增；所有详情、标签门、
   播放和动作 key 都使用它。`favoritesKnown` 独立于 `favs`：只有远端返回了
   `favorite_video_ids` 数组才置 true；缺字段或读取失败保持 false，UI 显示“收藏状态未知”，
   不能显示“还没有收藏”。
6. 游客数据由 `store.tsx` 的 `saveGuest` 写入 `STORAGE_KEYS.app`；登录用户的数据写
   `ACCOUNT_KEY`。登录/退出时 `setUser()` 清空 pending、上传计时器和同步状态，但不清空本地
   收藏/历史对象；账号同步的合并、dirty history、`clearHistory()` 和 `removeHistory()` 的远端删除见
   `accountData.ts`。登录/注册成功另写 `CREDENTIAL_KEY`；显式退出、静默重登被上游拒绝
   （密码错误）或重登返回不同账号时清除它。
7. `SessionStore` 把 `{origin, token, user, revision}` 写入应用数据目录的 `session.json`。
   旧版本没有 `origin`，反序列化后 `token()`/`snapshot()` 不会把它分配给当前线路，升级后必须
   重新登录。`revision` 是进程内代次，不落盘；同 token 重新登录也会推进 revision。
8. `cache_clear` 先清 `media::clear_caches()`（封面、播放列表、Key、分片内存缓存），再由
   `clear_web_cache()` 清平台 WebView 缓存。Linux 只清 `MEMORY_CACHE`、`DISK_CACHE`、
   `OFFLINE_APPLICATION_CACHE`，明确排除 cookies、localStorage、sessionStorage、IndexedDB、
   service worker 和 HSTS；其他平台没有选择性 API，只清应用内内存缓存，`webCache=false`。

## 状态转换

- 旧键 → 新键：读取旧值 → 写新键 → 回读一致 → 删除旧键；写/回读失败 → 保留旧键，继续返回旧值。
- 偏好：读取 → normalize → 内存快照 + revision；编辑 → 写 localStorage → 成功则更新快照；
  失败则仍更新快照并设置 `storageError`；storage 事件只接受本键或 `key=null`。
- 账号：boot/restoreSession → `setUser()` → generation++ → 读取该 `[origin,id]` 的本地桶 →
  后台同步；失败保留旧数据，`sync.error` 展示错误，下一次 focus/online/visible 重试。
  同步收到账号 401 且本机有同账号凭据时，由 `api_login` 核对当前会话的 origin、用户 ID 和代次；
  自动重登只走原线路，或两端均可信且共享账号体系的线路。返回用户 ID 匹配且起始会话仍有效，
  才提交新 token 并重试资料和历史。失败保留原会话，提示在当前线路手动登录，同一代次不循环重登；
  手动「重试同步」重置拒绝标记。
- 批量取消收藏：开始时捕获 `accountGeneration` 和 `actionRevision`；每项请求前后比较快照。账号代次改变，
  或收到线路/代理变化事件、组件卸载导致修订号递增时，停止队列中尚未发送的项目，不写旧批次反馈。
  `removeHistory()` 自身仍按账号代次与请求身份保护远端删除；外层确认流程只在调用前后校验组件反馈，
  不把线路事件描述为可中断其内部远端队列。
- 收藏未知：初始/登录/失败同步 → `favoritesKnown=false` → “收藏状态未知”；
  成功返回 `favorite_video_ids`（即使为空）→ true → 才允许显示“还没有收藏”。
- 清历史：确认 → 增加 `clearVersion`、取消定时上传 → 远端分批删除当前账号历史 →
  本地写空数组；账号切换或清除代次变化时丢弃旧结果。
- 选择性删除历史：`removeHistory(ids)` 取消定时上传并等待当前同步/上传结束 → 读取远端历史，把选中
  `video_id` 映射为删除接口所需的行 `id` 并分批删除 → 过滤本地选中记录及其 dirty/local 标记；
  未选中的 dirty history 恢复定时上传，失败保留本地快照，账号切换丢弃旧结果。
- 清缓存：媒体内存缓存 → 平台缓存报告；不改账号、收藏、历史、会话、线路、代理或主题。
- TV 启动 PIN：设置模态按 `verify → enter → confirm` 推进（`setup` 直接从 `enter` 开始）；
  凑满 4 位时 `appendDigit` 同步清空输入缓冲并回调 `onComplete`，confirm 与 draft 不一致时清
  draft 回 `enter`；`verify` 连续失败 5 次进入 15 秒冷却。成功后写盐值 SHA-256 摘要到
  `hghubx_tv_pin_v1`（同步 sha256，兼容无 `crypto.subtle` 的旧 WebView），会话解锁态只存内存。
  启动解锁页保留标题、PIN 输入提示与必要的错误反馈，不加装饰性副标题或页脚说明。

## 约束与失败行为

- 未知不是空：`favoritesKnown=false` 只表示未知；缺字段、读取失败和同步中的空数组都不能当作
  已确认空收藏。历史读取失败也不应把成功的收藏快照作废。
- 迁移先写新键，再清旧键。写入失败/配额不足/隐私模式禁止存储时保留旧数据；不能用“清空后重试”
  掩盖失败。
- 不覆盖用户显式设置：默认值只在读取不到时使用；一次性迁移必须有独立标记，不能每次启动都
  把用户的 `false` 改回 `true`。
- `accountScope`、`lineEpoch`、`generation` 必须一起进入异步结果校验；旧账号或旧线路的返回
  不能写进当前桶，否则会把 A 的收藏/历史显示在 B 上。
- 批量收藏操作还要捕获最初的 `accountGeneration` 与 `actionRevision`，并在每项请求前后校验；
  `lineEpoch` 的 React 更新和重挂载不是同步取消信号，线路/代理事件应立即让修订号失效。
- 会话 token 绑定 origin 和 revision。`token()`/`user()`/`snapshot()` 按 origin 精确匹配；
  唯一跨 origin 通道是 `rebase_if_trusted()`——仅当旧新两端都是固定线路或本进程发布页确认的
  可信镜像时改写 origin（revision 递增并落盘），否则切线路仍 `SessionStore.clear()`。
  旧 `session.json` 没有 origin 时不得猜归属，也不参与 rebase。
- 清缓存不能调用 `clear_all_browsing_data`；它会连 cookies/localStorage 一起删，导致登录和
  偏好丢失。非 Linux 平台宁可只清内存缓存，也不做全量清理。
- 本地写入失败要可见（偏好提示、账号 `sync.error`），不能静默显示“已保存”。
- 日志和错误提示不输出 token、账号 ID、收藏内容或完整存储值。
- `CREDENTIAL_KEY` 保存在本机 WebView，只供静默重登使用。密码仅经 `api_login` 发送到校验过的登录接口，
  不进入 IPC 返回值、日志或同步错误文案。账号不同不读取旧凭据；自定义线路不接收其他线路保存的凭据。
- TV PIN 输入缓冲只由 `appendDigit`/`removeLast`/`clearAll` 的同步路径清空；不得用 passive
  effect 重置——步切换时 effect 晚 flush 会吞掉切换后已按的键。

## 验证命令

```sh
node scripts/test-storage-migration.mjs
pnpm test:smoke
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm test:playback --scenarios tv
```

`test-storage-migration` 覆盖旧键、写/删失败、损坏 JSON 和一次性 swipe 迁移；
`pnpm test:smoke` 包含 `account-sync` 套件，调用 `test-account-sync-empty-state.mjs`，覆盖同步中、失败、
缺收藏字段、历史失败等“未知”状态，账号 401 静默重登成功与失败、返回收藏页后已缓存条目出现新集，
以及切换账号时停止批量取消收藏队列的回归；如需单独执行该脚本，可运行
`node scripts/test-account-sync-empty-state.mjs`。
`src-tauri/src/session.rs` 的 `silent_login_preserves_existing_session_on_user_mismatch` 覆盖重登接口返回另一个账号时
原 token、用户、线路与代次保持不变。
这些是本地 fixture，不证明真实账号后端返回结构；真实接口变化需另加 fixture。
`test:playback --scenarios tv` 的 `pin-lock-gate-and-settings` 覆盖启动门解锁与设置模态两段输入、
不一致回退与冷却文案。
