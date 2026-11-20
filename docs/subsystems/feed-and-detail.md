# Feed 与详情

## 责任与边界

Feed 负责列表播放页的条目位置、详情/帖子读取、标签门、详情/评论/选集面板、
相关推荐和动作上下文；详情子组件只消费已经归一化的 `Detail`/`Post` 数据。
播放器的媒体生命周期、seek 和 HLS 恢复归 [playback.md](playback.md)；
线路、代理、账号凭据分别归各自的子系统页。

## 事实来源

- [`src/features/feed/Feed.tsx`](../../src/features/feed/Feed.tsx)：`requestPlay`、
  `useFeedDetails` 的调用、`tagKey`/`permissionKey`、`effectiveVideoIds`、
  `details`/`posts`、`relatedByVideo`、`actionContext`；视口/手势/动作与界面覆盖层分别位于同目录的
  [`useFeedViewport.ts`](../../src/features/feed/useFeedViewport.ts)、
  [`useFeedTouchGestures.ts`](../../src/features/feed/useFeedTouchGestures.ts)、
  [`useFeedActions.ts`](../../src/features/feed/useFeedActions.ts)、
  [`FeedItemChrome.tsx`](../../src/features/feed/FeedItemChrome.tsx)、
  [`FeedPlayerShellChrome.tsx`](../../src/features/feed/FeedPlayerShellChrome.tsx)。
- [`src/features/feed/useFeedDetails.ts`](../../src/features/feed/useFeedDetails.ts)：
  `detailRequests`、`requestDetail`、`effectiveVideoIds`、`detailsRef`。
- [`src/features/feed/Panels.tsx`](../../src/features/feed/Panels.tsx) 的
  `CommentsPanel`、`EpisodesPanel`、`ArticlePanel`；
  [`src/features/feed/VideoDetailsPanel.tsx`](../../src/features/feed/VideoDetailsPanel.tsx)。
- [`src/features/posts/Posts.tsx`](../../src/features/posts/Posts.tsx) 的 `PostDetail`：
  吃瓜详情的正文/播放数据 effect 与线路事件下的后台刷新。
- [`src/shared/model/store.tsx`](../../src/shared/model/store.tsx) 的 `lineEpoch` 和 `accountScope` 传递；
  [`src/shared/model/store.tsx`](../../src/shared/model/store.tsx) 暴露的 `accountGeneration` 与
  [`src/shared/model/accountData.ts`](../../src/shared/model/accountData.ts) 的 `generation`；
  [`src/shared/model/contentPreferences.ts`](../../src/shared/model/contentPreferences.ts) 的 `blockReason`。
- 后端读取：[`src-tauri/src/api/feed.rs`](../../src-tauri/src/api/feed.rs)、
  [`src-tauri/src/api/video.rs`](../../src-tauri/src/api/video.rs)、
  [`src-tauri/src/api/interact.rs`](../../src-tauri/src/api/interact.rs)。

## 主运行时路径

1. Feed 使用 `api_feed`/分类/搜索/list page 传入的 `videoIds`，不自行重新请求列表。
   当前条目由 `position` 与 `effectiveVideoIds` 锚定；列表变化时优先保持正在播放的 id，
   找不到才取相邻可见项。
2. 详情读取走 `useFeedDetails.requestDetail(id)`。single-flight key 是
   `` `${accountScope}:${lineEpoch}:${id}` ``，最多保留 12 个进行中 Promise；
   成功结果放入组件内 `details: Record<number, Detail>`，失败不写入成功缓存。
3. 帖子读取走 `api.post(id)`，结果进入 `posts: Record<number, Post>`。Feed 的
   标签门、正文入口和播放界面从同一个 `Post` 归一化视图读取。
4. 标签门只在 `filtering` 时成为媒体闸门：
   `filtering = !preferences.paused && (blockedTags.length > 0 || hideUntagged)`。
   需要读取的候选是当前项以及前后各一项；普通模式只读当前项。
5. 标签门的键是 `` `${accountScope}:${lineEpoch}:${kind}:${id}` ``。
   `checked` 只在成功响应后置 true；`tagErrors` 保留可重试错误。
   失败不会把标签当成空数组；启用过滤时，读取失败继续阻止媒体请求。
6. `allowed = !filtering || (tagsReady && !blocked)`：普通模式直接允许；启用过滤时，
   必须成功读取标签且 `blockReason` 为空才允许。`allowed` 之前不请求播放地址；
   在首页被屏蔽时通过 `onBlocked` 跳过，在上下文播放页则关闭面板。
7. `requestPlay(id, episode)` 的 key 是
   `` `${accountScope}:${lineEpoch}:${id}:${episode}` ``，最多缓存 12 个 Promise。
   当前集开始播放后，才预取下一集的地址；下一部视频还要先通过详情/标签检查。
8. 评论面板使用 `api.comments` 或 `api.postComments`（仅短剧开放评论发送，帖子评论只读，
   不向短剧接口串写），选集使用当前 `detail.episodes`，
   详情面板显示作者/标签/相关推荐。桌面端停靠 `desktop-dock-panel`，移动端使用
   `Sheet`；面板本身不在 Feed 之外维护第二套详情缓存。
9. 相关推荐只在 `panel === "detail"` 时调用 `api.related`，缓存键是
   `` `${lineEpoch}:${curId}` ``。它不是首播前的预取，避免和视频地址争网络。
10. 动作使用 `actionContext = { accountScope, lineEpoch, id, ep, kind }`。
    请求返回后，`actionIsCurrent()` 再比较这五个字段；旧账号/旧线路/旧集数的结果
    不弹 toast、不更新视觉反馈。动作 pending key 也带 `accountScope`。

## 状态转换

- 条目切换：更新 `position`/`renderIndex` → 清理标签菜单和面板 → 重置播放 key →
  按新 key 读取详情/标签 → 允许后才请求播放地址。活跃条目的手势 overlay 在整个切集
  过渡期常驻：新集地址未解析（`playUrl` 为空）时 overlay 内部渲染封面而不是卸载，
  保证连续上下划继续切集，不会落到可滚动列表上切到别的视频。
- 标签门：未读 → loading → `checked=true`（再按 `blockReason` 判断）或 `tagErrors`（显示重试）；
  启用过滤时依据结果放行媒体；设置或账号/线路变化会使旧键失效并重新判断。
- 过滤结果：`effectiveVideoIds` 先按 `checked`/`tagErrors`/`blockReason` 过滤；
  正在播放项被移除时锚定相邻项，避免列表突然跳回第一屏。
- 详情加载：`requestDetail` 进行中 → 成功写入 `details` 和 `detailsRef` →
  面板可见；失败保留已有对象，不把 `undefined` 写成“无标签”。
- 动作：用户点击 → pending → 成功更新本地收藏/喜欢/关注 → 若上下文仍匹配才反馈；
  失败只提示错误，不凭空翻转状态。

## 约束与失败行为

- [创作者主页](../../src/features/account/User.tsx)按当前登录账号 ID 判断是否为本人；
  本人主页隐藏「关注」，并在处理关注操作前拦截本人目标。其他创作者主页仍可关注或取消关注。
- `details`/`posts` 是 Feed 实例的局部状态，不是跨应用持久缓存；页面销毁后重新读取。
  这避免把旧标签或旧正文带进新会话，但也意味着返回 Feed 时可能重新请求。
- 详情读失败不能标记 `checked`，不能把 `tags` 当空数组；启用过滤时不能让播放器抢跑。
  标签门重试会删除对应 `tagErrors` 并增加 `proxyRetry`。
- `useFeedDetails.requestDetail` 的 key 按账号/线路隔离、去重进行中的请求，本身不校验响应
  是否仍可写入。详情/标签 effect 返回后检查组件仍挂载及 `actionContext` 的账号/线路；
  动作返回后另由 `actionIsCurrent()` 校验完整动作上下文，防止旧结果更新当前反馈。
- 标签过滤不是内容搜索：`normalizeTag` 只做大小写/空白归一，不做模糊匹配；
  未知标签按 `hideUntagged` 处理。
- 相关推荐不做后台无限预取；关闭详情面板或切换条目不会删除 `relatedByVideo` 中的旧键。
  缓存留在当前 Feed 实例，读取按 `lineEpoch:curId` 隔离，不把旧线路键当作当前结果。
- 评论/选集面板只在 `active` 且 `allowed` 时保持开放；被覆盖时关闭，不阻塞返回键
  或下层 Feed。
- 手势 overlay 的挂载只取决于条目是否活跃，不取决于 `playUrl` 是否已解析；否则切集
  过渡期的触摸会被列表原生滚动吃掉（2.2.0 反馈的连划跳视频根因）。
- 标准版「我的」卡片支持电脑右键、手机长按进入多选，继续点按切换选择；收藏页逐项取消收藏，历史页
  调用 `removeHistory()` 只删除选中记录。批量操作需确认，切换收藏/历史或短剧/帖子会清空选择；
  收藏部分失败时保留失败项供重试，未选中的观看记录和收藏互不影响。批量取消收藏在开始时捕获
  `accountGeneration` 与 `actionRevision`；每项请求前后都校验二者，线路/代理事件或组件卸载会使修订号失效，
  随即停止未发送项并抑制旧批次的错误、完成状态与 toast。账号代次检查独立于组件重挂载，避免 cleanup
  执行前队列继续用新账号发起下一项。
- 标准版「我的」收藏与观看历史保持原有网格列数；滚动容器接近底部哨兵（提前 300px）时
  每次扩展 12 项，不再显示「加载更多」按钮。
- 标准版「我的 → 收藏 → 短剧」重新激活时，按已展现的列表范围后台刷新详情，每批最多 6 部。
  展开更多时读取新增条目；同一激活期间已刷新的条目不重复请求。旧卡片与观看断点保留，
  刷新失败不将旧集数当空数据，离开页面或切线后丢弃在途结果。
- 吃瓜详情（[`src/features/posts/Posts.tsx`](../../src/features/posts/Posts.tsx) 的
  `PostDetail`）区分「换帖子/账号」与「仅线路代次变化」：`hg:line-changed`/`hg:proxy-changed`
  （自动选线切换、保存代理）推进 `lineEpoch` 时，只有 `id`/`accountScope` 变化才清空重置；
  仅 `lineEpoch` 变化保留已显示的 `post`、正文与滚动位置，后台重拉 `api_post` 与
  `api_post_playback`，播放地址解析失败保留旧地址不清空。否则整页回加载态会卸载播放器
  portal，视频从 0 重播（issue #165）。
- 吃瓜详情的正文仅在正文内容或安全模式改变时重新清洗。渲染时复用同一个
  `dangerouslySetInnerHTML` 属性对象；滚动更新「阅读进度」以及刷新得到同一正文时不替换
  图片节点，避免懒加载图片反复消失、重载和撑开布局（issue #165）。
- 上下划切集的提示 toast 带 `tag="episode"`（`useFeedTouchGestures.ts`）；`store.tsx` 的
  `pushToastItem` 对同 tag 原地替换内容并重置 2200ms 计时，快速连续划集只显示一张最新卡片，
  不堆叠、不重放入场动画；无 tag 的 toast 仍按原逻辑堆叠（最多 3 张）。

## 验证命令

```sh
pnpm build
pnpm test:smoke
pnpm test:api-loading
pnpm test:post-flicker
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

`test:smoke` 当前包含 `api-loading`、`storage-migration`、`line-selection`、
`diagnostic-copy`、`ui-feedback`、`home-controls`、`account-sync`（最后运行）。账号切换期间批量取消收藏的
fixture 位于 `scripts/test-account-sync-empty-state.mjs`；需要单独运行时可执行
`node scripts/test-account-sync-empty-state.mjs`。浏览器 fixture 使用 mock Tauri IPC 且阻断外部请求，
不能证明真实上游的正文结构或账号接口；真实接口变化需要另加网络隔离的 fixture 或手动验证。
`test:post-flicker` 是吃瓜详情线路/代理事件的回归（issue #165）：浏览器 fixture，
mock IPC，本地 ffmpeg HLS 分片，不访问上游；需要 ffmpeg，归入播放诊断
（`pnpm test:playback --scenarios post-flicker`，CI 的 core 分片），不进 smoke。
账号切换 fixture 会挂起第一项取消收藏请求，切换账号后再释放，并检查没有发送第二项、没有向新账号
写入旧结果或弹出旧批次成功提示；该回归随 `pnpm test:smoke` 的 `account-sync` 套件运行。
