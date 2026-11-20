# DSH Web Workstation 产品规格

[English](SPEC.md) · 简体中文

产品方向已批准。工作台自托管，保留官方 DSH 应用和插件生态。技术假设由 M0 验证。[验收标准](roadmap/M0.zh-CN.md) · [实际结果](roadmap/M0-evidence.zh-CN.md)

## 用户和范围

| 领域 | 要求 |
| --- | --- |
| 用户 | 初期供一位可信用户使用。认证模型可支持 2 至 5 个账号。 |
| 隔离 | 为每个租户独立隔离 DSH_HOME、工作区和浏览器配置后，才能提供多用户隔离。 |
| 客户端 | 优先桌面浏览器，移动浏览器需基本可用。 |
| 部署 | Docker Compose 和一个公网 HTTPS 源。 |

## DSH Runtime 和插件

| 领域 | 要求 |
| --- | --- |
| 基础镜像 | 提供兼容的 Node.js、固定版本 pnpm、Git/SSH、CA 证书和常见 Node 原生依赖构建工具。 |
| 安装 | 在运行时将官方 DSH npm 包安装到持久化存储。保留多个确切版本，支持查询版本、安装、选择、升级、验证、回滚和删除未激活版本。 |
| 切换 | 核对 Node 与 DSH 兼容性及可用的插件元数据。验证后原子切换。安装或健康检查失败时保留旧版本。切换不覆盖已安装版本，也不自动修改 Profile 依赖。 |
| 版本 | Runtime 镜像和 DSH npm 独立版本化。 |
| Plugin Manager | 保留官方 Profile 和 Plugin Manager。支持 npm、固定版本、固定提交的 Git HTTPS、上游支持的本地路径、ESM/CommonJS 和常见原生模块。 |
| 数据 | 清单、锁文件、node_modules 链接和内容、pnpm Store、Bundle 清单、设置、凭据、会话和插件配置放在同一个 DSH_HOME 文件系统。工作区单独存储。 |
| 依赖脚本 | 逐项审查 pnpm 构建脚本和原生依赖。记录 ffmpeg 或 libvips 等额外系统前置条件，按需使用可选服务或有文档的扩展。 |

## 浏览器

| 领域 | 要求 |
| --- | --- |
| Chromium | Runtime 外单独运行一个 LinuxServer Chromium。人工和 Agent 共享浏览器进程、持久化配置和下载。 |
| 访问 | 通过同源 `/browser/` 提供 Selkies，沿用 DSH 登录。CDP 只在私有 Docker 服务边界内可用。 |
| 自动化 | 上游支持时，使用官方 DSH Browser Use/Playwright MCP 通过 CDP 连接同一个 Chromium。 |
| 控制 | 状态包括 HUMAN、AGENT、HANDOVER、PAUSED、DISCONNECTED。强制验证服务端租约。Agent 控制时在 Selkies 拦截人工输入，人工控制时拒绝 Agent 工具调用。 |
| 接管 | 停止接收新的 Agent 操作，安全完成或取消当前操作，撤销租约，再开放人工输入。实际输入边界须通过验证。 |
| 恢复 | 显示断开和重新连接状态，浏览器重启后可以恢复。 |

### Workstation 插件

- 用固定 DSH 版本支持的右侧栏 API 注册浏览器桌面标签页，嵌入相对路径 `/browser/`。
- 使用原生面板生命周期 API，支持停靠、浮动、调整大小、最大化和还原、隐藏、重连及状态显示。
- 如果上游支持，切换标签页和隐藏时保留 iframe 挂载。隐藏时 Chromium 继续运行。
- 显示人工或 Agent 控制状态、控制者、任务状态、接管及交还操作。沿用官方 DSH 聊天、会话、文件、差异对比和终端界面。

## 认证

| 领域 | 要求 |
| --- | --- |
| 服务 | 独立 Go 服务使用 SQLite WAL。创建首个管理员后关闭初始化。 |
| 密码和 TOTP | 密码用 Argon2id 哈希。要求绑定 RFC 6238 TOTP，密码正确后显示独立的 TOTP 界面。 |
| Passkey | 使用独立 WebAuthn 登录，严格核对配置的 RP ID 和 HTTPS 源，要求用户验证和一次性挑战，支持每人多个凭据。 |
| 恢复码 | 仅显示一次，以哈希保存。每个码用一次，重新生成使旧码失效。 |
| 会话 | 使用不透明的安全随机令牌，仅保存哈希。空闲和绝对时限、会话数量可配置，可撤销单个或全部会话。 |
| Cookie | `__Host-dsh_session`，使用 Secure、HttpOnly、SameSite=Lax 和 Path=/，省略 Domain。 |
| 防护 | 限流、CSRF 和源校验、防账号枚举和安全密钥管理。敏感操作前再次验证身份。 |
| 审计 | 记录登录成功和失败、MFA 与凭据变更、会话变更、账号停用及恢复。 |

### 登录界面

1. 第一屏只显示用户名和密码。
2. 密码正确后创建短期预认证挑战，进入独立的第二屏或弹窗。
3. TOTP 界面只显示验证码输入、返回或重新开始，以及恢复码入口。
4. 验证码正确后创建完整会话，只跳转到验证过的同源相对路径。
5. 另提供清晰可见的 Passkey 登录入口。

## 路由和部署

| 路径或边界 | 要求 |
| --- | --- |
| `https://<host>/` | DSH 和共享会话 Cookie。 |
| `/browser/` | 使用 LinuxServer 支持的 Selkies 子路径配置。只有上游明确要求时才移除前缀。 |
| `/_auth/` | 认证界面和 API。认证以及校验端点不经过自己的 ForwardAuth。 |
| ForwardAuth | 保护 DSH 和 Selkies。未认证的 API 返回 401，WebSocket 升级被拒绝。 |
| 浏览器控制 | 仅供内部或通过认证访问。管理端点不作为免认证公网入口。 |
| Compose | 编排 DSH、Auth 和 Chromium，可复用共享网络上的外部 Traefik。 |

## 界面和运维

| 领域 | 要求 |
| --- | --- |
| 浏览器 | 在 DSH 原生浏览器桌面标签页展示完整 Selkies。显示所有权、接管和交还、重连状态。 |
| Runtime | 显示当前、已安装和可用版本，以及兼容性、日志、备份和健康状态。 |
| 插件 | 显示已安装、市场或来源、更新，以及来源、版本、兼容性、依赖和脚本批准。通过官方 Plugin Manager 安装、启用、停用、更新和删除。展示日志，并区分安装、激活、兼容性和健康状态。 |
| 账户 | 管理密码、Passkey、TOTP、恢复码、会话和审计。敏感操作前重新验证身份。 |
| 发布 | Runtime 镜像、DSH npm、Auth 镜像、Workstation 插件和 Chromium 分别版本化。固定发布标签及摘要。 |
| 备份 | 迁移或依赖操作前备份 DSH_HOME。备份覆盖 DSH_HOME、工作区、Chromium 配置、认证数据库和加密密钥。恢复测试需证明 TOTP 和已注册的 Passkey 仍可用。 |
| 健康和恢复 | 检查实际就绪。记录并验证升级回滚。 |

## 范围外

Windows Companion、多租户编排、Kubernetes、自定义 Agent Runtime 或编辑器、公共插件市场托管，以及并行运行多个浏览器实例。首版部署不引入 Authentik、Browserless、Redis、PostgreSQL、VNC/noVNC 或独立浏览器域名及登录。

## 完成标准

功能完成需包含实现、自动化测试、配置文档、安全影响和故障恢复。
