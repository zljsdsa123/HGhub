# 上游线路

## 责任与边界

线路子系统负责当前上游 origin 的选择、持久化和信任判定：一条固定主站线路、地址发布页公布的镜像、
用户显式保存的自定义线路，以及探测、自动选线和回切主站。它回答“这次请求发往哪个 HTTPS
origin”，不负责 HTTP 客户端、代理、DNS 固定或媒体字节（见
[network-proxy-media.md](network-proxy-media.md)）。

凭据只属于 origin：`token()`/`user()`/`snapshot()` 按 origin 精确匹配。上游各可信线路共享同一
账号体系，因此固定线路与可信镜像之间的切换经 `SessionStore::rebase_if_trusted()` 把会话 origin
改写为新线路（revision 递增并落盘），登录得以保留；任一端不可信（自定义线路、未被发布页确认的
镜像）时仍然 `SessionStore.clear()`，旧 token 不会跟着地址走。镜像只有在被可信发布页实际解析
出来后才获得携带凭据与参与 rebase 的资格；`line.json` 里的历史地址本身不授予信任。

## 事实来源

- 线路状态与持久化：[`src-tauri/src/net/mod.rs`](../../src-tauri/src/net/mod.rs) 的
  `DEFAULT_BASE`、`LineConfig`、`BASE`、`BASE_FILE`；
  [`src-tauri/src/net/line.rs`](../../src-tauri/src/net/line.rs) 的
  `base()`、`is_custom_line()`、`normalize_base()`、
  `trusted_auth_origin()`、`persisted_line()`、`bind_base()`、`set_base()`、
  `set_custom_base()`、`save_line()`、`apply_base()`。
- 固定线路与发布页：[`src-tauri/src/lines/mirror.rs`](../../src-tauri/src/lines/mirror.rs) 的
  `FIXED`、`PUBLISH_PAGES`、`mirrors()`、`merge_publishers()`、`remember_published()`、
  `is_trusted_mirror()`、`is_fixed()`、`verify_published_origin()`。
- 发布脚本与 JS-as-data 解析：[`src-tauri/src/publish_parser.rs`](../../src-tauri/src/publish_parser.rs) 的
  `MIRROR_MAX`、`parse_mirrors()`、`script_src()`、`absolute()`、`js_tokens()`、`js_string()`、`js_array()`。
- 探测与选择：[`src-tauri/src/lines/probe.rs`](../../src-tauri/src/lines/probe.rs) 的
  `healthy_video_data()`、`probe_hit()`、`probe()`、`auto_candidates()`、`pick_from_hits()`、
  `auto_pick()`、`try_main()`、`health()`。
- Tauri 命令：[`src-tauri/src/api/lines.rs`](../../src-tauri/src/api/lines.rs) 的
  `line_state`、`line_set`、`line_custom_set`、`line_reset`、`line_cancel`、`line_mirrors`、
  `line_probe`、`line_auto`、`line_try_main`、`line_health`；命令注册在
  [`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs) 的 `generate_handler!`。
- 前端自动选线：[`src/shared/network/autoLine.ts`](../../src/shared/network/autoLine.ts) 的 `autoLineEnabled()`、
  `pickLine()`、`check()`、`attach()`、`initAutoLine()`、`setAutoLine()`。
- 线路 UI：[`src/features/settings/LinePicker.tsx`](../../src/features/settings/LinePicker.tsx) 的
  `readState()`、`readMirrors()`、`probe()`、`applyLine()`、`saveCustom()`。

## 主运行时路径

1. 启动时 `bind_base(app_data_dir)` 读取 `line.json`。格式是 `{v:2, base, custom}`；
   `persisted_line()` 只接受纯 HTTPS origin，旧 `{base}` 格式恢复地址但不恢复自定义线路的登录
   授权。`refresh_media_scope()` 让媒体缓存看到新的线路代次。
2. 固定线路只有一条：`https://huangguoai.com`。`https://huangguoai.ai` 只是导航站，
   `/api/*` 全部 nginx 404，不作为 API 线路，也不授予凭据信任。`line_state` 返回
   `base`、`default`、`custom` 和 `FIXED`；`line_mirrors` 才去抓两条发布页，
   平时不轮询。发布页和 `publish.js` 必须在 8 秒、512 KiB 内完成，脚本必须是同源 HTTPS、
   文件名为 `publish.js`，重定向不能跨 origin。
3. `parse_mirrors()` 只接受 `urls` 和可选 `subdomains` 的字面量字符串数组；`js_array()` 不执行
   远程 JavaScript。域名只保留合法 DNS 名称，最多 `MIRROR_MAX` 个；两条发布页的结果交错合并
   并去重，一条失败不会丢掉另一条的成功结果。
4. 手动选择固定线路走 `line_set`；自定义线路走 `line_custom_set`。二者都先经过
   `normalize_base()`（HTTPS、无路径/查询/片段、拒绝内网），非自定义线路还必须属于 `FIXED`
   或 `is_trusted_mirror()`。成功后写入 `line.json`（临时文件 + rename），刷新 HTTP 客户端；
   地址变化时 `line_set` 先尝试 `rebase_if_trusted()`（两端都是固定/可信镜像则保留会话），
   失败才 `state.session.clear()`；`line_custom_set` 永远清空——自定义站点不参与可信 rebase，
   即使旧 origin 可信也不能把 token 带过去。
5. 自动选线由 `autoLine.ts` 驱动：启动、上线、页面重新可见、`api_*` 连续两次网络失败或
   手动开启都会触发体检。`line_health` 只探当前线路；连续两次失败才 `line_auto`，每 15 秒最多
   主动选一次，定时体检按 60/120/300 秒退避。
6. `auto_pick()` 先探固定线路 1 的 `/api/videos?page=1&size=1`；主站可用就直接返回。否则抓
   发布页，从**已发布且已记住**的镜像里最多取 10 个并发探测。判据是
   `healthy_video_data()`：解包后的 `items`、`pagination` 和每条 `id/title` 都有效，HTTP 200 或
   HTML 落地页都不算健康。
7. `pick_from_hits()` 选择 `ok=true` 且耗时最短的候选；没有候选时返回
   `reason="all-down"`、`base=""`。前端收到 all-down 只提示一次并保持当前线路，不盲切
   `.ai`。`line_auto` 在真正落盘前重新检查 `LINE_SELECTION` 代次，用户手动操作会让旧探测作废。
8. 当前是镜像时，健康检查会调用 `line_try_main()`：只探固定线路 1，通了就切回，代价是一个
   请求；两端可信时会话经 rebase 保留，旧 origin 不可信（如自定义线路）则清空。切回后
   `hg:line-changed` 让列表和详情按新 `lineEpoch` 重新读取。`line_auto` 落盘切换时同样执行
   rebase-or-clear；`app_boot` 在当前 origin 查不到会话、但存有旧 origin 会话时，同时对旧 origin
   与当前 origin 做 `verify_published_origin()` 可信刷新（填充 `TRUSTED_MIRRORS`），再尝试 rebase，覆盖
   镜像登录后重启回固定线路或切新镜像的场景。
9. 带 token 的业务请求在严格模式下还要过 `trusted_auth_origin()`：固定线路、本次进程内由发布页
   确认过的镜像，或用户显式保存的自定义线路。已落盘但尚未验证的镜像会触发
   `verify_published_origin()`；验证失败只允许游客浏览，登录/注册被拒绝。

## 状态转换

- 启动：无 `line.json` 或内容损坏 → `DEFAULT_BASE`；有效 v2 自定义线路 → 恢复
  `{base, custom:true}`；旧格式 → 只恢复地址，`custom=false`。boot 的登录可见性由
  `session::boot_credentials_visible()` 决定：严格模式下本进程发布页验证失败时，
  绑在当前线路的会话仍对前端可见（不报登出）；未绑当前线路的会话仍 fail closed 报登出。
- 选择：手动点击 → `line_set`/`line_custom_set` → 校验 → 写临时文件 → rename →
  更新内存 `BASE` → `refresh_client()` → 地址变化时清会话 → UI 收到 `hg:line-changed`。
- 自动：`health.ok` → 重置失败计数并延长体检间隔；连续两次不健康 → `auto_pick`；
  有赢家 → 切换并回到 60 秒；all-down → 保持当前线路并 10 秒后重试。
- 取消：`line_cancel` 只增加代次，不修改线路；正在探测的 `line_auto` 返回
  `cancelled=true`，不再落盘。
- 发布页：首次成功解析 → `remember_published()` 写入进程内可信集合（上限 256）；
  单纯读取 `line.json`、展示当前地址或手动探测都不会加入该集合。

## 约束与失败行为

- JS 只当数据：不执行、不 `eval`、不跟随动态表达式；注释、字符串、模板和正则里的伪声明必须
  被忽略；重复声明、非字符串元素、未闭合注释都 fail closed。
- 发布页脚本只能同源、HTTPS、精确文件名 `publish.js`；`MIRROR_MAX`、512 KiB 和 8 秒都是硬上限。
- 线路必须是纯 HTTPS origin。`normalize_base()` 拒绝路径、查询、片段、认证信息和普通内网/
  回环地址；`FakeIP` 的 198.18/19 段由网络策略单独处理。
- 全部线路不可用时不得返回一个“可切换”的地址；`all-down` 必须保留当前线路，避免把可用会话
  切到已知 404 的落地页。
- 自动选线不持久化“候选信任”。只有发布页解析成功才更新 `TRUSTED_MIRRORS`；持久化文件、
  探测结果和 UI 推荐都不能替代这一步。
- 镜像登录失败不是网络错误：严格模式下未验证镜像只允许游客浏览，提示用户切回固定线路或
  重新加载发布页，不要清空本地收藏/历史来“修复”。
- 账号 401 的自动重登必须携带预期账号与线路。若当前线路已变化，或保存凭据来自不同且不互信的线路，
  后端不发送凭据；即使重登接口成功，身份或会话代次不符也不写回原会话。
- 启动时发布页超时不清本地登录态：`app_boot` 对绑当前线路的会话返回登录态，凭据发送仍由
  `edge` 的未验证镜像拒绝兜底；发布页恢复可达后下一次带 token 请求会自动完成验证。
- 线路保存失败要保留原线路并返回错误；不能先改内存再报告成功。写文件采用临时文件 + rename，
  避免半截 JSON。

## 验证命令

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
node scripts/test-line-selection.mjs
pnpm test:smoke
```

`src-tauri/src/publish_parser.rs` 与 `src-tauri/src/lines/mod.rs` 的单元测试覆盖脚本词法、域名规范化、发布页同源、交错合并、
all-down、健康判据和候选排序；`test-line-selection` 覆盖前端自动选线状态。
发布页和真实镜像的可达性属于外部状态，测试不请求上游网络；实机结果需单独记录。
