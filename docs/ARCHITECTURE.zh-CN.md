# DSH Web Workstation 架构

[English](ARCHITECTURE.md) · 简体中文

## 组件边界

### DSH Runtime 镜像

可复用的运行环境镜像，提供兼容的 Node.js、固定版本的 pnpm、Git/SSH、CA 证书和常见原生构建工具链。镜像不包含固定 DSH npm 版本；各版本保存在持久化存储中，由专用 CLI 或 API 管理。

### Runtime 管理器

将官方 DSH npm 包的确切版本安装到 DSH_HOME 中相互独立的目录，先验证，再原子切换当前版本指针，检查服务启动健康，失败时回滚。文件系统锁或进程锁须保证写操作串行。不得就地修改活动版本。

### DSH Profile

由官方 DSH CLI 和 Plugin Manager 管理。保留固定上游版本的实际目录结构。将 DSH_HOME 整体挂载到同一个持久化卷，避免把 pnpm 符号链接和 Store 分到不同文件系统。工作区单独挂载。

### 认证网关

使用 SQLite WAL 的 Go HTTP 服务。负责密码、TOTP、WebAuthn 流程，恢复码，不透明会话，CSRF 防护，审计，限流，ForwardAuth 校验和浏览器控制租约协调。不会执行 DSH Agent。

### Workstation 插件

DSH 客户端插件，由所选版本的公开 API 注册右侧栏浏览器桌面标签页。嵌入同源 `/browser/`，并与认证服务和浏览器控制 API 通信。不得修改 DSH 核心；依赖未公开内部实现须有 ADR 依据。

### Chromium

LinuxServer Chromium/Selkies 使用同一个 Chromium 进程和同一份持久化浏览器配置目录。人工通过 Selkies 操作，Agent 通过 CDP 自动化。始终共享同一个浏览器进程。CDP 仅在 Docker 私网可用，不发布到宿主机或公网。

### Traefik

- `/` → DSH，使用 ForwardAuth。
- `/browser/` → Chromium Selkies，使用同一 ForwardAuth，保留前缀。
- `/_auth/` → 公开登录及账户界面和 API，不应用自身的 ForwardAuth。
- 内部 ForwardAuth 校验端点 → 认证服务，只允许 Traefik 访问。

对子路径支持、响应头、CSP、WebSocket 和登录行为的判断，须经确切上游版本的测试。

## 数据归属和持久化

- DSH_HOME：Runtime 版本、Profile 清单、锁文件、node_modules、pnpm Store、会话、设置、凭据和插件配置。使用同一个持久化卷。
- 工作区：项目文件，使用独立卷或绑定挂载。
- Chromium `/config`：浏览器配置目录、Cookie、扩展和下载，持久化。
- 认证数据：SQLite 数据库，使用独立卷。
- 认证密钥：Docker secrets 或只读密钥文件，与数据库分开存储和备份。
- 部署配置：保存在 Git，不提交密钥。

## 认证流程

密码登录：

1. 向认证服务 POST 用户凭据。
2. 验证成功后发放短期、一次性的预认证 Cookie 或挑战。
3. 切换到独立的 TOTP 界面，不在此处显示密码字段。
4. 每个有效 TOTP 时间步只接受一次验证码。
5. 换发带不透明令牌的正式会话 Cookie。

Passkey 登录：

- 发出一次性 WebAuthn 挑战，严格检查 RP ID 和源，要求用户验证。
- 断言验证成功后建立完整会话。
- Passkey 是独立的登录流程；账号仍然必须绑定 TOTP。

Cookie：`__Host-dsh_session`，Secure、HttpOnly、SameSite=Lax、Path=/，不设 Domain。

## 浏览器控制

状态：HUMAN、AGENT、HANDOVER、PAUSED、DISCONNECTED。

租约字段包括租约 ID、持有者类型和 ID、DSH 会话 ID、代次、发放时间及过期时间。比较与交换须具备事务语义。每次工具操作前，Provider 必须校验租约。租约过期或进程退出时要回到 HUMAN 或 DISCONNECTED，不能遗留过时的 AGENT 控制权。

Agent 拥有控制权时，必须在 Selkies 输入边界拦截人工键盘及鼠标输入，仅在界面锁定不足以实现独占。如果上游 Selkies 必须修改镜像才能可靠拦截输入，评估小型认证输入网关或代理，或单独维护的集成镜像。验证前不宣称实现独占模式。

Agent 的自动化通过 CDP 连接 Chromium 已有的默认上下文。需要共享 Cookie 或标签页时，不启动第二个浏览器，也不新建隔离上下文。验证 Playwright 的 CDP 限制，禁止工具关闭浏览器或上下文。

## 版本管理

独立维护以下版本：

- Runtime 镜像版本
- DSH npm 版本
- 认证镜像版本
- Workstation 插件版本
- Chromium 镜像标签和摘要

改变 DSH npm 版本不需要重建 Runtime 镜像。更新 Runtime 镜像不会自动升级 DSH。不假定不同 DSH 版本间的 Profile 和插件数据向后兼容，必须备份并检查迁移。

## 安全边界

- 不挂载 Docker socket。
- 不把 CDP 端口发布到宿主机。
- 不向公网暴露浏览器控制端点。
- 不信任客户端自带的身份请求头。
- ForwardAuth 删除或替换客户端输入的身份请求头。
- 认证服务和登录路由不经过自己的 ForwardAuth。
- API 和 WebSocket 认证失败时不能返回 HTML 登录页。
- 浏览器终端拥有访问其容器的强大权限，初期只供可信用户使用。
- 多个账号可通过认证不等于租户隔离。
