# DSH Web Workstation 产品规格

[English](SPEC.md) · 简体中文

产品方向已批准：围绕官方 DSH 应用和插件生态构建自托管工作台。项目负责部署、安全、浏览器控制和运维增强，不替代 Agent Runtime、聊天应用、编辑器或插件市场。技术假设由 M0 验证。[验收标准](roadmap/M0.zh-CN.md) · [实际结果](roadmap/M0-evidence.zh-CN.md) · [正式产品基线](adr/0004-single-user-release-and-deferred-sidebar.zh-CN.md)

## 用户和首版范围

| 领域 | 要求 |
| --- | --- |
| 用户模型 | 首版严格只有一个本地管理员账户。不提供创建用户、邀请、多账户管理或租户编排。该管理员可以注册多个 Passkey。 |
| 隔离 | 首版是单用户，不是多租户。不得开放多个账户却让它们共用 DSH_HOME、工作区或 Chromium 配置。未来如需多用户，必须为每个租户独立提供 DSH_HOME、工作区、浏览器配置、会话和密钥。 |
| 客户端 | 优先桌面浏览器，移动浏览器需基本可用。 |
| 部署 | Docker Compose 和一个公网 HTTPS 源，尽可能复用现有 Traefik。首版只支持 Linux amd64。 |

## DSH Runtime 和插件

| 领域 | 要求 |
| --- | --- |
| 基础镜像 | 提供兼容的 Node.js、固定版本 pnpm、Git/SSH、CA 证书和常见 Node 原生依赖构建工具。 |
| 安装 | 在运行时将官方 DSH npm 包安装到持久化存储。保留多个确切版本，支持查询版本、安装、选择、升级、验证、回滚和删除未激活版本。 |
| 切换 | 核对 Node 与 DSH 兼容性及可用插件元数据。验证后原子切换。安装或健康检查失败时保留旧版本。切换不覆盖已安装版本，也不自动修改 Profile 依赖。 |
| 版本 | Runtime 镜像和 DSH npm 独立版本化。 |
| Plugin Manager | 保留官方 Profile 和 Plugin Manager。支持 npm、固定版本、固定提交的 Git HTTPS、上游支持的本地路径、ESM/CommonJS 和常见原生模块。不得另造包管理器或公共插件市场。 |
| 数据 | 清单、锁文件、node_modules 链接和内容、pnpm Store、Bundle 清单、设置、凭据、会话和插件配置放在同一个 DSH_HOME 文件系统。工作区单独存储。 |
| 依赖脚本 | 逐项审查 pnpm 构建脚本和原生依赖。记录 ffmpeg 或 libvips 等额外系统前置条件，按需使用可选服务或有文档的扩展。 |

### 升级事务

- 对会修改持久化状态的变更，先备份 DSH_HOME，并记录 Runtime、DSH、Profile 和插件版本。
- 将候选 DSH 版本安装在活动版本旁边，不修改当前活动安装。
- 检查 Node 兼容性、DSH 启动和就绪、Profile/Bundle 兼容性、锁定依赖和已批准的构建脚本。
- 版本指针回滚与数据回滚是两种操作。若迁移修改了持久化状态，回滚必须恢复匹配的备份；仅切换软链接不构成数据回滚。
- 保留成套恢复路径，能够恢复上一版 Runtime 镜像、DSH 选择、Profile 状态和对应备份。

## 浏览器

| 领域 | 要求 |
| --- | --- |
| Chromium | Runtime 外单独运行一个 LinuxServer Chromium。人工和 Agent 共享浏览器进程、持久化配置和下载。 |
| 访问 | 通过同源 `/browser/` 提供 Selkies，沿用 DSH 登录。CDP 只在私有 Docker 服务边界内可用。 |
| 自动化 | 上游支持时，使用官方 DSH Browser Use/Playwright MCP 连接同一个 Chromium。Workstation Provider 只开放明确批准的工具。 |
| 控制 | 状态包括 HUMAN、AGENT、HANDOVER、PAUSED、DISCONNECTED。强制验证服务端租约。Agent 控制时在 Selkies 输入边界拦截人工输入，人工控制时拒绝 Agent 工具调用。 |
| 接管 | 停止接收新的 Agent 操作，安全完成或取消当前操作，撤销租约，释放并确认已按住的人工输入，再开放下一位控制者。实际输入边界须通过验证。 |
| 恢复 | 显示断开和重新连接状态，浏览器重启后可以恢复。无法确认操作完成或输入状态时必须失败关闭。 |

### 浏览器工具和网络安全

- 每次浏览器工具调用都必须经过统一的服务端租约、会话、代次和执行中操作检查。增加工具不得产生绕过检查直达 CDP 的路径。
- `BROWSER_TOOL_ORIGINS` 是 Provider 操作层的来源白名单，不是网络出口防火墙、DNS/IP 策略或完整 SSRF 防护。
- Chromium 会执行页面 JavaScript 并跟随重定向。不得宣称来源白名单可以隔离 Chromium 的私网访问或保护宿主机。
- 在允许 Agent 浏览不可信网站或广泛导航前，增加独立浏览器出口策略；需在 DNS 解析后及重定向各阶段阻止回环、链路本地、私有网段、云元数据和其他禁止目标。策略必须在 DSH 工具提示词之外强制执行。
- CDP、Provider 管理接口和 Selkies Token 管理不得出现在未认证的公网路由中。

## Workstation 浏览器集成

- 首版以已认证的独立浏览器/控制页面作为正式入口。
- DSH 原生右侧 Sidebar 延后实现，不作为首版部署验收门槛。
- 后续实现只能使用对应 DSH 版本支持的公开客户端/Sidebar API，嵌入相对路径 `/browser/`。不得 Fork DSH 核心或依赖私有 DOM。
- 按确切 DSH 版本验证停靠、浮动、调整大小、最大化/还原、隐藏、重连和 iframe 生命周期。独立页面始终保留为备用入口。
- 官方 DSH 聊天、会话、文件、差异对比、终端、Profile 和 Plugin Manager 仍是主要应用界面。

## 认证

| 领域 | 要求 |
| --- | --- |
| 服务 | 独立 Go 服务使用 SQLite WAL。初始化只创建一个本地管理员，成功后永久关闭初始化。不提供公开用户创建或邀请流程。 |
| 密码和 TOTP | 密码用 Argon2id 哈希。要求绑定 RFC 6238 TOTP，密码正确后显示独立的 TOTP 界面。 |
| Passkey | 使用独立 WebAuthn 登录，严格核对配置的 RP ID 和 HTTPS 源，要求用户验证和一次性挑战。单个管理员可注册多个凭据。 |
| 恢复码 | 仅显示一次，以哈希保存。每个码用一次，重新生成使旧码失效。 |
| 会话 | 使用不透明的安全随机令牌，仅保存哈希。空闲和绝对时限、会话数量可配置，可撤销单个或全部会话。 |
| Cookie | `__Host-dsh_session`，使用 Secure、HttpOnly、SameSite=Lax 和 Path=/，省略 Domain。 |
| 防护 | 限流、CSRF 和源校验、防账号枚举和安全密钥管理。敏感操作前再次验证身份。 |
| 审计 | 记录登录成功和失败、MFA 与凭据变更、会话变更、管理员恢复和停用操作。 |

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
| 网络 | 部署前检查 Docker 子网冲突。工作台和浏览器子网可配置，固定地址、健康检查目标和证书 SAN 从同一配置源生成。 |
| 镜像 | 建立发布流程后，将 Runtime、Auth 和 Provider 镜像发布到 GHCR。部署使用不可变 digest。 |

## 界面和运维

| 领域 | 要求 |
| --- | --- |
| 浏览器 | 首版提供已认证的独立 Selkies/控制页面。原生 Sidebar 可延期。显示所有权、接管/交还和重连状态。 |
| Runtime | 显示当前、已安装和可用版本，以及兼容性、日志、备份和健康状态。 |
| 插件 | 显示已安装插件、来源、版本、兼容性、依赖和脚本批准。通过官方 Plugin Manager 安装、启用、停用、更新和删除。展示日志，并区分安装、激活、兼容性和健康状态。 |
| 账户 | 管理唯一管理员的密码、Passkey、TOTP、恢复码、会话和审计。不提供用户管理。敏感操作前重新验证身份。 |
| 发布 | Runtime 镜像、DSH npm、Auth 镜像、Workstation Provider 和 Chromium 分别版本化。固定发布标签及摘要。 |
| 备份 | 迁移或依赖操作前备份 DSH_HOME。备份覆盖 DSH_HOME、工作区、Chromium 配置、认证数据库、Provider 状态和加密密钥。恢复测试需证明 TOTP 和已注册的 Passkey 仍可用。 |
| 健康和恢复 | 检查实际就绪。记录并验证升级、匹配数据恢复和回滚。 |

## 范围外

多用户账户和租户编排、Windows Companion、Kubernetes、自定义 Agent Runtime 或编辑器、公共插件市场托管、同时运行多个浏览器，以及首版强制原生 Sidebar。首版部署不引入 Authentik、Browserless、Redis、PostgreSQL、VNC/noVNC 或独立浏览器域名及登录。

## 完成标准

功能完成需包含实现、自动化测试、配置文档、安全影响、故障恢复，以及带可观察验收证据的 Issue。不同依赖版本上的 CI 通过不等于目标环境验证。
