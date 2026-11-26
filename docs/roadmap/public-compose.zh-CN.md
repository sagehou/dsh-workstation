# 公网 Compose：设计与验证记录

[English](public-compose.md) · 简体中文

项目所有者批准首版单管理员公网 Compose。首版正式浏览器入口是已认证的独立浏览器/控制页面；原生 Sidebar 延后。#4 的已按住输入释放和独占交接通过前，不开放 Agent 浏览器控制；#11 的出口策略通过前，不开放 Agent 广泛访问不可信网站。[ADR-0004](../adr/0004-single-user-release-and-deferred-sidebar.zh-CN.md) · [M0](M0-evidence.zh-CN.md) · [Provider 验证](M0-provider-evidence.zh-CN.md) · [M1 Runtime 结果](M1.zh-CN.md) · [#1](https://github.com/sagehou/dsh-workstation/issues/1)

## 复用 Traefik 的三网拓扑

| 网络 | 用途 |
| --- | --- |
| 已有代理网 | Gateway 的公开和校验监听器。Gateway 核对 Traefik 的确切来源 IP。 |
| `workstation` | DSH 和官方 MCP。Traefik 和 Gateway 在这里连接 DSH。 |
| `browser` | Chromium、输入门禁和要求凭据的 Provider 管理监听器。Traefik 转发 Selkies HTTP，Gateway 转发 WebSocket。 |

精简版常驻 Gateway 和 Runtime，共两个工作台容器。完整版增加 Chromium、Provider、CDP 中继和输入门禁，共六个。两种形态都复用已有 Traefik。已发布的 Auth 版本容器数相同。[部署指南](../../deploy/public/README.zh-CN.md#选择部署形态)

CDP 中继与 Chromium 共用网络命名空间，通过专用 Unix socket 卷转发回环 CDP。中继写入 socket，Provider 只读挂载。Playwright 从 Provider 自己的回环监听器接入。拓扑无需自定义宿主机防火墙规则。

### 在 GitHub Actions 复现

Public Compose 在固定 Go 镜像内运行 `go test -race -v ./...`，并在 GitHub 托管运行器执行 `bash deploy/public/ci.sh`。集成测试使用单独启动的 Traefik、临时证书及结果确定的模型服务。[Public Compose](../../.github/workflows/public-compose.yml)

作业矩阵的版本只来自 [`deploy/public/traefik-matrix.env`](../../deploy/public/traefik-matrix.env)。每条腿拉取 `tag@digest`，跑同一套 Compose、同一个边缘探测和同一套登录后浏览器检查，唯一差异是 Traefik 镜像。[#3](https://github.com/sagehou/dsh-workstation/issues/3)

### Traefik 兼容性矩阵

| Traefik | 固定摘要 | 状态 |
| --- | --- | --- |
| `v3.7.19` | `sha256:a6c0194dda77bcb804824580f36fa7edc56e315b1acfe933366c8b52844a78a4` | 在 `f57e92d` 通过默认及自定义网段测试 |
| `v3.7.14` | `sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c` | 在 `f57e92d` 通过默认及自定义网段测试 |

已记录通过的最低版本为 **v3.7.14**。两条腿都在[运行 45115206598](https://github.com/sagehou/dsh-workstation/actions/runs/45115206598)通过，检查项完全一致：`v3.7.14`（[作业 137496422641](https://github.com/sagehou/dsh-workstation/actions/runs/45115206598/job/137496422641)）与 `v3.7.19`（[作业 137496422567](https://github.com/sagehou/dsh-workstation/actions/runs/45115206598/job/137496422567)）；在 `43065af` 的[运行 45116032367](https://github.com/sagehou/dsh-workstation/actions/runs/45116032367) 再次通过。

只有表中列出的版本有运行记录，本表也不代表两者之间的版本可用。未列出的版本视为未验证，`deploy/public/traefik-image.sh` 会直接拒绝解析，而不是悄悄测一个浮动 tag。

矩阵中每一条腿都验证了：HTTP 跳转 HTTPS、HSTS/nosniff/referrer 头、ForwardAuth 对 API 返回 401 且对文档返回 303、伪造 `X-Workstation-User`/`X-Forwarded-User`/`Remote-User` 不能通过、`/browser/` 前缀要求登录、`/browser/api/tokens` 未被路由、DSH 内部 TLS 链路、Selkies WebSocket 视频、登录后同源帧策略。

CONNECT 在两个版本上行为不同，探测按版本记录实际观察值：

- `v3.7.15` 及以后在路由前就把 `CONNECT` 拒绝为 **501**：入口点挂了 `denyConnect`（`pkg/server/server_entrypoint_tcp.go`）。
- `v3.7.14` 完全没有 `denyConnect`，`CONNECT` 会落到路由器，返回 **404**。它仍然不是隧道，但不是 501 那种保证。
- 迁移文档中 `v3.7.9` 关于 HTTP/1 `CONNECT` 的说明与 `v3.7.14` 源码不符，因此 `v3.7.14` 的实际状态以运行结果记录，不按文字推断。

### Gateway 候选版验证

- Go 1.27.3 的 `go test -race -v ./...` 通过。四组 `bash deploy/public/ci.sh` 使用 DSH 0.2.2-rc.1 与 Playwright 1.61.1，验证 HTTPS 登录、Passkey、会话恢复、Gateway 管理页、备份创建与校验和浏览器输入交接。[f57e92d 的 Public Compose](https://github.com/sagehou/dsh-workstation/actions/runs/45816293100)
- `bash deploy/public/ci-core.sh` 确认仅 Gateway 与 Runtime 在运行，真实 TOTP 登录可进入 DSH，已登录访问 `/browser/` 返回 503。独立的 `release-compose` 作业匿名拉取 `81feffd` 对应的已发布 Auth 镜像。[精简版作业](https://github.com/sagehou/dsh-workstation/actions/runs/45816293100/job/139896781308) · [发布镜像作业](https://github.com/sagehou/dsh-workstation/actions/runs/45816293100/job/139896902377)
- Chromium 156.0.8078.4 和 Playwright 1.61.1 使用测试数据渲染 Gateway 实际页面，验证桌面和窄屏布局、系统暗色、键盘操作、登录与备份校验反馈。[界面验收记录](https://github.com/sagehou/dsh-workstation/issues/35#issuecomment-7191691647)

集成测试在 GitHub 托管运行器完成，界面实测使用本地测试数据。目标主机的验收仍待完成。[部署验收 Issue](https://github.com/sagehou/dsh-workstation/issues/6)

## 历史验证

### `333e6f3` 的实际结果

提交 `333e6f3` 的作业通过（当时只有 Traefik 3.7.19 一条腿）。使用 Traefik `3.7.19`、Chromium `156.0.8078.79`、Selkies `2.2.1`、DSH `0.2.2-rc.1` 和 Playwright `1.61.1`。[提交 `333e6f3` 的 GitHub Actions 作业](https://github.com/sagehou/dsh-workstation/actions/runs/44688814854/job/136129433239)

| 检查项 | 实际结果 |
| --- | --- |
| 三张网和 CDP | 只有中继和 Provider 挂载 socket 卷。DSH 可访问需要凭据的 MCP 监听器，无法直连 Selkies、CDP、Provider 管理监听器或 ForwardAuth。宿主机无法访问 CDP 监听器。 |
| 登录和恢复 | HTTP 跳转 HTTPS。未认证的 API、WebSocket 返回 401。密码加 TOTP 或单独使用 Passkey 均可登录。SQLite 备份还原到新 Auth 卷后，原会话仍可用。撤销会话后，已建立的 DSH 与 Selkies WebSocket 均关闭。 |
| Chromium 和中继重建 | 杀死中继后，Compose 用原来的卷重建两个容器。Provider 经复用的 socket 卷连接到新的 CDP 实例。 |
| 会话标签页 | Selkies 在 DSH 同源播放视频。两个真实 DSH 会话在 A → B → A 切换中各自保留标签页。无租约、跨会话和旧代次操作均被拒绝。 |

### 镜像

- Runtime `0.2.0`、Auth `0.1.1` 和 Provider `0.2.0`。归档含源码提交、镜像 ID、校验文件和集成日志。[amd64 镜像包](https://github.com/sagehou/dsh-workstation/actions/runs/44688814854/artifacts/14607841816)
- 归档 SHA-256 为 `1213fd422aeac235081e6ed1180a3021db26d10b69281a85982e8e7f71d3afc8`。
- 产物于 `2027-02-18T06:34:57Z` 到期。

## 原有独立部署拓扑

### Auth 和 DSH 集成

- Traefik 终止公网 TLS。Go Auth 发放会话 Cookie，信任原独立网桥上的 Traefik，写请求校验公网源，HTTP 与升级后的连接沿用同一 SQLite 会话时限。导航到正文与拒绝匿名 API 或 WebSocket 分开处理。
- 官方 TLS 参数启用 **Secure DSH Cookie**。网关经校验过的内部 TLS 交换启动 URL，使用准确的公网 Host，转发 Cookie，然后跳转到验证过的相对路径。[官方 `dsh web` TLS 参数](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/web-app/src/startup.ts)
- 官方 Plugin Manager 按宿主 peer 依赖规则链接 Workstation Bundle。Bundle 把官方 MCP 客户端接入在线 Agent 的 Cordis 上下文。[官方 Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/plugin-manager/README.md) · [宿主 peer 依赖解析规则](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/user/develop/basic/publish.md#install-into-a-profile) · [官方 MCP 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/README.md) · [Cordis 上下文](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/core.md)
- MCP 客户端 SDK `2.2.0` 用 `server/discover` 探测。已认证探测收到旧协议响应，不消耗签名凭据，匿名探测返回 401。旧协议 `initialize` 一次性消耗凭据。浏览器控制权需单独授权，模型工具参数不能选客户端或标签页。[MCP client SDK 2.2.0](https://www.npmjs.com/package/@modelcontextprotocol/client/v/2.2.0)

### Provider 与输入

- 只有 Provider 访问 CDP。它实施一个全局租约、按客户端绑标签页、每次授权产生新代次、同一时间只执行一个操作、接管排空和重启保护。
- Selkies 拦截新输入并保留视频。已接收的按住输入可能持续。原生侧栏支持前使用单独控制页。[安全模式和令牌表](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/docs/secure-mode.md)
- Provider 的根文件系统只读，为 Playwright 连接时的临时文件挂载限额文件系统。健康检查需要已经连接 Chromium。[Playwright 连接 CDP 时生成的临时文件](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/chromium/chromium.ts#L118)

### 固定版本

| 层 | 版本 |
| --- | --- |
| Runtime | DSH 和官方 MCP 客户端 `0.2.2-rc.1`、Node `24.22.3`、pnpm `11.28.5`。 |
| Auth | Go `1.27.3`、go-webauthn `0.18.2`、go-sqlite3 `1.14.53`。 |
| 入口和浏览器 | Traefik `3.7.19`、LinuxServer Chromium `075b0b99-ls64`、Selkies `2.2.1`。 |
| Provider | MCP server SDK `1.31.0`、Playwright `1.61.1`。 |

Compose 和 Dockerfile 记录镜像摘要，锁文件记录模块哈希。

### 复现原有运行

GitHub 托管的 Ubuntu 24.04 作业运行 `go test -race -v ./...` 和 `bash deploy/public/ci.sh`。一次性 CA 和结果固定的 Messages 测试服务驱动实际路由、官方 DSH 可执行文件和 MCP 客户端。部署时，正式 ACME HTTP-01 仍需公网 DNS 和 TCP 80。[Public Compose 工作流](https://github.com/sagehou/dsh-workstation/blob/de823f9d850ae5a8bc001a67613413220ff4fd7e/.github/workflows/public-compose.yml)

### 原有结果

提交 `de823f9` 的独立 Compose 作业通过。[GitHub Actions 运行 44488230831](https://github.com/sagehou/dsh-workstation/actions/runs/44488230831/job/135436965916) · [`de823f9`](https://github.com/sagehou/dsh-workstation/commit/de823f9d850ae5a8bc001a67613413220ff4fd7e)

| 检查项 | 实际结果 |
| --- | --- |
| `go test -race -v ./...` | `TestTwoStepLoginAndReplay` 和 `TestForwardAuthAndRevocation` 通过。覆盖 TOTP 重放、单次恢复码、可信代理校验、会话过期与撤销。 |
| HTTPS 和网络隔离 | HTTP 重定向到 HTTPS。未认证的 API 和 WebSocket 请求返回 401。Selkies 令牌管理路由未公开。DSH 无法访问 CDP、Provider 控制端或 ForwardAuth。匿名 MCP 版本探测返回 401。 |
| 浏览器登录与恢复 | 密码和 TOTP 分为两屏。浏览器收到两个带 Secure 和 HttpOnly 的 Cookie，DSH 在地址不含启动令牌时正常启动。浏览器验证器注册了 Passkey。把认证备份恢复到新卷后，原有会话仍可用，密码加 TOTP 及 Passkey 都能再次登录。撤销会话关闭了已建立的 DSH 和 Selkies WebSocket。 |
| 经 DSH Web 使用浏览器 Provider | 通过认证的 `/browser/` 能播放 Selkies 视频。真实 DSH Web RPC 创建两个会话。授予租约前均收到 `NO_LEASE`。跨会话导航收到 `NOT_OWNER`，越出允许源收到 `ORIGIN_NOT_ALLOWED`，旧租约代次收到 `STALE_GENERATION`。A 读到 `WTAB_ALPHA`，B 读到 `WTAB_BETA`，切回 A 仍读到 `WTAB_ALPHA`。 |

### 原有镜像归档

- Runtime `0.2.0`、Auth `0.1.0` 和 Provider `0.1.0`，附源码提交、镜像 ID、SHA-256 文件和日志。[public-compose-linux-amd64 产物](https://github.com/sagehou/dsh-workstation/actions/runs/44488230831/artifacts/14512006785) · [部署指南](https://github.com/sagehou/dsh-workstation/blob/8b6f02dad5580fb02382409d127cc198162bdbb8/deploy/public/README.zh-CN.md)
- 归档 SHA-256 为 `8e06e50bd7bfaf184fa91f797800f1ac151acd318edaa3690fe0d87f3d1a9044`。到期时间为 `2027-02-17T08:30:48Z`。
- 可重放时运行 `gh run rerun 44488230831 --repo sagehou/dsh-workstation`。也可从已验证提交建 `public/**` 分支，改动 `deploy/public/` 触发新构建。

### 测试范围

- 两次全栈运行均在 GitHub Actions 使用临时证书完成。公网 CA 签发和实际使用者主机部署不在证据范围内。
- 标签页所有权绑定在线 MCP 连接。新连接须重新授权。接管排空、过期、并发、断开和重启的独立验证见 M0。[M0 Provider 结果](M0-provider-evidence.zh-CN.md)
