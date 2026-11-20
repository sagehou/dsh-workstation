# AGENTS.md — DSH Workstation

[English](AGENTS.md) · 简体中文

围绕**官方 DeepSeek Harness（DSH）npm 包**构建 Docker Compose 工作台。仓库负责 Runtime 镜像、版本管理器、Go Auth、Workstation 插件、部署和测试。

## 必须遵守的约束

### DSH 和 Runtime

- **不得 Fork 或修改 DSH 核心。** 使用有文档的 Profile、Bundle、Plugin Manager、Cordis patch 和客户端插件 API。扩展点无法满足需求时，记录缺口，等待架构决策。
- **在运行时安装指定的 DSH npm 版本。** 镜像提供兼容 Node.js、固定版本 pnpm、Git/SSH、CA 证书和支持插件的工具链。DSH 安装全部保存在持久化存储。版本管理器负责安装多个版本、选择和回滚。
- 保留官方 Plugin Manager。持久化 Profile 清单、锁文件、pnpm Store、已安装依赖、Bundle 配置、凭据、会话及其他 DSH_HOME 状态。
- 按确切上游版本和源码核对 API、路径、参数、环境变量、插件 ID 与兼容性，记录证据。

### 浏览器

- 人工和 Agent 共享**一个 Chromium 进程和一份持久化浏览器配置**。人工通过 LinuxServer Chromium/Selkies 操作，Agent 通过 CDP 连接同一实例。
- Selkies 使用同源 `/browser/`，沿用 DSH 的登录。两个路由都使用 Traefik ForwardAuth。排除 VNC 和 noVNC。
- **独占控制需要同时检查服务端工具执行和 Selkies 输入。** 如实报告未证明的输入限制。界面开关无法通过验收。
- CDP 保留在私网，不发布到宿主机或公网接口。

### 认证和部署

- Go Auth 是独立的 SQLite 服务。需要支持密码验证通过后单独显示 TOTP、Passkey/WebAuthn、恢复码、可配置的空闲和绝对会话时限、撤销、审计，以及 Traefik ForwardAuth。
- 账号必须绑定 TOTP，密码登录必须完成 TOTP。Passkey 可以作为独立的抗钓鱼登录方式。不要同时要求三种因素。
- 初期只面向一位使用者。多个账号不等于租户隔离。每个租户都需要独立的 DSH 状态、工作区和浏览器配置。
- 使用 Docker Compose，服务独立版本化。Redis、PostgreSQL、Browserless 和 Authentik 需要明确的需求依据。
- 密钥不得进入镜像、源码、日志或已提交的 Compose 文件。DSH 和 Auth 不挂载 Docker socket。

## 开发流程

1. 从 [M0](docs/roadmap/M0.zh-CN.md) 开始。验证通过后再实现完整功能。
2. 查明上游契约，写下设计，实现最小的端到端功能，添加并运行自动化测试，记录结果和局限。
3. 固定版本及镜像摘要。浮动标签只用于明确标记的实验。Runtime 镜像版本独立于 DSH npm 版本。
4. 升级时先装到独立目录，验证后原子切换，检查就绪，失败则回滚。不要就地修改活动安装。
5. 数据迁移或 Profile 依赖变更前备份 DSH_HOME。回退迁移时恢复对应的数据。
6. pnpm 安装脚本及原生构建须经明确审查和批准。不得默认允许所有依赖构建脚本。
7. 测试容器重建和状态持久化。审计敏感操作，修改凭据或 MFA 前再次验证身份。

## 代码质量

| 领域 | 要求 |
| --- | --- |
| 模块 | 使用小模块和明确的接口。 |
| Go | 使用请求上下文、结构化日志和迁移，对会话与租约做竞态测试，在适用处做常量时间比较，使用安全随机令牌和参数化 SQL。 |
| TypeScript | 遵循固定版本的客户端插件 API。私有或内部导入要有依据并记录。 |
| Docker | 兼容时以非 root 运行，采用最小权限，禁用特权模式和 Docker socket 挂载，配置健康检查，可行时用只读根文件系统。 |
| 日志 | 不记录密码、TOTP 码或种子、WebAuthn 断言、恢复码、会话令牌或加密密钥。 |
| 文档 | 标记未验证的原型设置。生产可用的判断须有证据。 |

## 里程碑报告

- 已完成的改动和测试所用的确切版本。
- 命令、实际结果和通过或未通过的验收项。
- 剩余风险与下一项等待决策的阻塞。
- 可用的提交、PR 和 Issue 链接。
