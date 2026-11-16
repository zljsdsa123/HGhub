# HGhubX 分流规则

统计日期：2026-11-07。包含 5 条域名后缀规则和 3 条精确域名规则；没有已确认的固定服务端 IP/CIDR。规则只决定流量如何分流，不改变应用的账号信任或正文清洗策略。

## 域名来源

| 匹配方式 | 域名 / 后缀 | 用途及证据 |
| --- | --- | --- |
| 后缀 | `huangguoai.com` | 固定 API 线路 1，正文相对 URL 的基址；`src-tauri/src/net.rs`、`src/html.ts` |
| 后缀 | `huangguoai.ai` | 固定 API 线路 2；`src-tauri/src/lines.rs` |
| 精确 | `huangguoai.pages.dev` | 镜像发布页及其 `publish.js`；`src-tauri/src/lines.rs` |
| 后缀 | `drleao.cn` | 图片 CDN 样本 `pic.drleao.cn`；`src-tauri/src/media.rs` 联网测试 |
| 后缀 | `hzjvlo.cn` | 视频 CDN 样本 `yd-lphu-hls.hzjvlo.cn`；`src-tauri/src/media.rs` 联网测试 |
| 后缀 | `xxbgwypx.cc` | 镜像样本 `thu.xxbgwypx.cc` 及动态子域；`src-tauri/src/lines.rs` 测试 |
| 精确 | `api.github.com` | GitHub Release 更新元数据；`src-tauri/src/api.rs` |
| 精确 | `github.com` | 更新页面，用户点击后交给外部浏览器；`src-tauri/src/api.rs` |

CDN 和镜像三条后缀来自仓库已有样本，不能据此认定它们当前仍在使用。当前发布页在线核对返回 HTTP 403。API 返回的封面、播放地址，HLS 子清单、分片、密钥、重定向地址及镜像列表都可能引入新域名，因此这是一份源码已知目标清单，不是完整流量白名单。新域名应依据代理连接日志继续补充。

GitHub 是共享基础设施，这两条精确规则也会匹配其他程序对同域名的访问。应用只打开更新网页，不自动下载更新包；外部浏览器下载时使用的其他 GitHub/CDN 域名未纳入本清单。

## Mihomo

使用 [hghubx.list](hghubx.list)，这是 `classical` 行为、`text` 格式的规则集合。将 `rules` 目录放在 Mihomo 配置目录中，并合并以下配置；把 `PROXY` 替换成已有代理组名。规则应放在其他兜底规则之前。

```yaml
rule-providers:
  hghubx:
    type: file
    behavior: classical
    format: text
    path: ./rules/hghubx.list

rules:
  - RULE-SET,hghubx,PROXY
```

也可通过 HTTP 托管该文件后使用 `type: http`，填写实际 `url` 和更新周期。`.list` 不包含策略名，不要直接作为完整的 `rules:` 配置粘贴。

## sing-box

使用 [hghubx.json](hghubx.json)，源规则集版本为 2，适用于 sing-box 1.10 及以上。将目录放在配置目录中，合并到现有 `route`；把 `proxy` 替换成实际出站标签，放在兜底规则之前。

```json
{
  "route": {
    "rule_set": [
      {
        "type": "local",
        "tag": "hghubx",
        "format": "source",
        "path": "./rules/hghubx.json"
      }
    ],
    "rules": [
      {
        "rule_set": ["hghubx"],
        "action": "route",
        "outbound": "proxy"
      }
    ]
  }
}
```

以上路由动作写法适用于 sing-box 1.11 及以上；1.10 使用相同源规则集时，删除路由项中的 `"action": "route"`。

需要二进制规则集时可使用已编译的 [hghubx.srs](hghubx.srs)，将配置的 `format` 改为 `binary`、`path` 改为 `./rules/hghubx.srs`。修改 JSON 后重新编译：

```sh
sing-box rule-set compile --output rules/hghubx.srs rules/hghubx.json
```

## IP/CIDR 与本地协议

`198.18.0.0/15` 是应用为兼容代理而允许的 FakeIP 地址池，不是上游服务专用网段。不能用它替代域名规则，也不要把共享 CDN 的 DNS 解析结果当作固定专用 CIDR。

`hg://localhost`、`hg.localhost`、`ipc.localhost`、`tauri.localhost` 是 WebView 内部协议；`localhost:1420` 是开发服务器，`127.0.0.1:7897` 是代理配置示例。它们均未加入远端代理规则。安全测试中的内网地址、示例域名，以及依赖下载、配置 schema、文档链接也未纳入。

如果代理日志只显示 IP，请先核对域名嗅探、FakeIP 映射恢复或应用使用系统 HTTP 代理的配置；无法恢复域名时，这份域名规则可能无法匹配。

格式参考：[Mihomo 规则集合](https://wiki.metacubex.one/config/rule-providers/)、[sing-box 源规则集](https://sing-box.sagernet.org/configuration/rule-set/source-format/)、[sing-box 路由迁移说明](https://sing-box.sagernet.org/migration/)。

## 本地验证

已使用 Mihomo v1.19.32 的 `-t` 和 sing-box v1.14.3 的 `check` 检查导入配置；确认 `.list` 与 `.json` 的 8 条目标一致，并对 sing-box 源规则及编译后的 `.srs` 完成 42 项正反匹配检查。验证临时目录已自动清理。
