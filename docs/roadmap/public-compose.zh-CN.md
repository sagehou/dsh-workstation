# 公网 Compose：设计与验证记录

[English](public-compose.md) · 简体中文

项目所有者批准继续交付单用户公网 Compose，已按住输入时的完整交接和原生侧栏留待后续。实现建立在 [M0](M0-evidence.zh-CN.md)、[Provider 验证](M0-provider-evidence.zh-CN.md)和 [M1 Runtime 结果](M1.zh-CN.md)之上。M0 尚未通过的验收项继续保留。

## 复用 Traefik 的三网拓扑

五个工作台容器使用已有的可信代理网和两个 Compose 网桥。Go Auth 只在代理网的别名地址上监听，并核对 Traefik 的确切来源 IP。Runtime 和 MCP 监听器在 `workstation`。Chromium 和 Provider 管理监听器在 `browser`。Traefik 接入两张网代理 DSH 和 Selkies，Auth 用两张网转发 WebSocket。Provider 管理接口仍要求 Auth 持有的凭据。[部署指南](../../deploy/public/README.zh-CN.md)

中继与 Chromium 共用网络命名空间，把回环 CDP 转发到 Unix socket。专用卷由中继写入，Provider 只读挂载。Playwright 通过 Provider 容器内的回环监听器连接该 socket。浏览器网和 Runtime 网保留各自的出站能力。CDP 不监听网桥地址，部署无需自定义宿主机防火墙规则。

在 GitHub Actions 通过 [Public Compose](../../.github/workflows/public-compose.yml) 运行 `bash deploy/public/ci.sh`。它单独启动 Traefik 并使用临时 HTTPS 证书，检查 socket 挂载和网络隔离，在保留卷的情况下重建已杀死的中继和 Chromium，并验证完整登录及 DSH 到 Provider 的流程。

[提交 `333e6f3` 的 GitHub Actions 作业](https://github.com/sagehou/dsh-workstation/actions/runs/44688814854/job/136129433239)通过。验证使用 Traefik `3.7.19`、Chromium `156.0.8078.79`、Selkies `2.2.1`、DSH `0.2.2-rc.1`、Playwright `1.61.1`，以及 Runtime `0.2.0`、Auth `0.1.1`、Provider `0.2.0`。

| 检查项 | 实际结果 |
| --- | --- |
| 三张网和 CDP | 只有中继和 Provider 挂载 socket 卷。DSH 可访问需要凭据的 MCP 监听器，无法直连 Selkies、CDP、Provider 管理监听器或 ForwardAuth。宿主机无法访问 CDP 监听器。 |
| 登录和恢复 | HTTP 跳转 HTTPS。未认证的 API、WebSocket 返回 401。密码加 TOTP 或单独使用 Passkey 均可登录。SQLite 备份还原到新 Auth 卷后，原会话仍可用。撤销会话后，已建立的 DSH 与 Selkies WebSocket 均关闭。 |
| Chromium 和中继重建 | 杀死中继后，Compose 用原来的卷重建两个容器。Provider 经复用的 socket 卷连接到新的 CDP 实例。 |
| 会话标签页 | Selkies 在 DSH 同源播放视频。两个真实 DSH 会话在 A → B → A 切换中各自保留标签页。无租约、跨会话和旧代次操作均被拒绝。 |

[amd64 镜像包](https://github.com/sagehou/dsh-workstation/actions/runs/44688814854/artifacts/14607841816)包含三个镜像、源码提交、镜像 ID、校验文件和集成日志。归档 SHA-256 为 `1213fd422aeac235081e6ed1180a3021db26d10b69281a85982e8e7f71d3afc8`，GitHub 列出的过期时间为 `2027-02-18T06:34:57Z`。CI 使用临时证书和结果固定的模型服务。

## 原有独立部署拓扑

- Traefik 在公网入口终止 TLS，并在 DSH 和 Selkies 路由使用 Go ForwardAuth。会话 Cookie 仅由 Go 服务发放。它信任专用网桥上的代理，修改状态的请求要验证公网源。登录页面与 API、WebSocket 的拒绝行为分开。通过认证网关升级后的浏览器和 DSH 连接，与 HTTP 请求使用同一个 SQLite 会话的存活时限。
- [官方 `dsh web` TLS 参数](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/web-app/src/startup.ts)启用 DSH Secure Cookie。网关使用准确的公网 Host，经已校验的内部 TLS 交换 DSH 私有启动 URL，转发官方 Cookie，然后重定向到安全的相对路径。
- [官方 Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/plugin-manager/README.md)按照[宿主 peer 依赖解析规则](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/user/develop/basic/publish.md#install-into-a-profile)链接 Workstation Bundle。Bundle 将宿主的[官方 MCP 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/README.md)接到在线 Agent 的 [Cordis 上下文](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/core.md)。
- 固定版本的 [MCP client SDK 2.2.0](https://www.npmjs.com/package/@modelcontextprotocol/client/v/2.2.0)用 `server/discover` 探测。已认证的探测收到旧协议响应，不消耗签名准入凭据；未认证仍返回 401。旧协议的 `initialize` 一次性消耗凭据。取得浏览器控制权还需要单独的已认证授权，模型工具参数不能选客户端或标签页。
- 现有 Provider 实施全局租约、按客户端绑定标签页、每次授权的代次校验、同一时间只执行一个操作、接管期间等待已开始的操作结束及重启保护。只有它能访问 CDP。Selkies [安全模式和令牌表](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/docs/secure-mode.md)拦截新输入，同时保留视频。已经接收的按住输入仍是已知限制。原生侧栏未支持前，控制页独立于 DSH。
- Provider 的根文件系统只读，挂载限额临时文件系统，用于 [Playwright 连接 CDP 时生成的临时文件](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/chromium/chromium.ts#L118)。健康检查通过私有控制监听器确认已连接浏览器。

固定版本：DSH 和官方 MCP 客户端 `0.2.2-rc.1`、Node `24.22.3`、pnpm `11.28.5`、Go `1.27.3`、go-webauthn `0.18.2`、go-sqlite3 `1.14.53`、Traefik `3.7.19`、LinuxServer Chromium `075b0b99-ls64`（含 Selkies `2.2.1`）、MCP server SDK `1.31.0`、Playwright `1.61.1`。发布镜像摘要见 Compose 和 Dockerfile，模块哈希见依赖锁文件。

通过 [Public Compose 工作流](https://github.com/sagehou/dsh-workstation/blob/de823f9d850ae5a8bc001a67613413220ff4fd7e/.github/workflows/public-compose.yml)在 GitHub 托管的 Ubuntu 24.04 运行器复现：它在固定的 Go 镜像里运行 `go test -race -v ./...`，并运行 `bash deploy/public/ci.sh`。脚本不解析真实域名，使用一次性证书和结果确定的测试模型服务；它验证实际部署路由、官方 DSH 可执行文件和 MCP 客户端。部署时，正式 CA 签发仍需要公网 DNS 和 TCP 80。

[GitHub Actions 运行 44488230831](https://github.com/sagehou/dsh-workstation/actions/runs/44488230831/job/135436965916)在提交 [`de823f9`](https://github.com/sagehou/dsh-workstation/commit/de823f9d850ae5a8bc001a67613413220ff4fd7e)通过：

| 检查项 | 实际结果 |
| --- | --- |
| `go test -race -v ./...` | `TestTwoStepLoginAndReplay` 和 `TestForwardAuthAndRevocation` 通过。覆盖 TOTP 重放、单次恢复码、可信代理校验、会话过期与撤销。 |
| HTTPS 和网络隔离 | HTTP 重定向到 HTTPS。未认证的 API 和 WebSocket 请求返回 401。Selkies 令牌管理路由未公开。DSH 无法访问 CDP、Provider 控制端或 ForwardAuth；匿名 MCP 版本探测返回 401。 |
| 浏览器登录与恢复 | 密码和 TOTP 分为两屏。浏览器收到两个带 Secure 和 HttpOnly 的 Cookie，DSH 在地址不含启动令牌时正常启动。浏览器验证器注册了 Passkey。把认证备份恢复到新卷后，原有会话仍可用，密码加 TOTP 及 Passkey 都能再次登录。撤销会话关闭了已建立的 DSH 和 Selkies WebSocket。 |
| 经 DSH Web 使用浏览器 Provider | 通过认证的 `/browser/` 能播放 Selkies 视频。真实 DSH Web RPC 创建两个会话。授予租约前均收到 `NO_LEASE`；跨会话导航收到 `NOT_OWNER`，越出允许源收到 `ORIGIN_NOT_ALLOWED`，旧租约代次收到 `STALE_GENERATION`。A 读到 `WTAB_ALPHA`，B 读到 `WTAB_BETA`，切回 A 仍读到 `WTAB_ALPHA`。 |

[public-compose-linux-amd64 产物](https://github.com/sagehou/dsh-workstation/actions/runs/44488230831/artifacts/14512006785)包含 Runtime `0.2.0`、Auth `0.1.0` 和 Provider `0.1.0` 镜像、源码提交、镜像 ID、SHA-256 文件及测试日志。按[部署指南](https://github.com/sagehou/dsh-workstation/blob/8b6f02dad5580fb02382409d127cc198162bdbb8/deploy/public/README.zh-CN.md)校验和加载归档。GitHub 记录的归档 SHA-256 为 `8e06e50bd7bfaf184fa91f797800f1ac151acd318edaa3690fe0d87f3d1a9044`，过期时间为 `2027-02-17T08:30:48Z`。运行仍可重放时用 `gh run rerun 44488230831 --repo sagehou/dsh-workstation`；也可在以已验证提交为基础的 `public/**` 分支修改 `deploy/public/` 下的内容，触发新的构建。

全栈验证使用一次性 CA、两个真实的在线 DSH 会话和结果确定的 Messages 测试服务。没有部署到服务器，也未申请真实公网证书。标签页所有权限于在线 MCP 连接，每个新连接需要重新授权。已按住输入的交接及原生侧栏暂缓。接管排空、过期、并发、断开和重启的独立实验见 [M0 Provider 结果](M0-provider-evidence.zh-CN.md)。
