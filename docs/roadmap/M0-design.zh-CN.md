# M0 实验设计

[English](M0-design.md) · 简体中文

在一次性远端运行器上做实验，使用新建 Compose 卷，不使用 DeepSeek 凭据。M0 在独立分支进行，实验夹具仅用于验证。[#1 的范围](https://github.com/sagehou/dsh-workstation/issues/1)

## 探针

| 门槛 | 设计 |
| --- | --- |
| A · Runtime | 固定 Node 和 pnpm，使用非 root UID 和一个 DSH_HOME 卷。确切版本分别安装到独立目录，操作持锁。 |
| B · 浏览器 | 用摘要固定已发布的 LinuxServer 镜像。中继只绑定隔离网接口，让 Playwright 连接回环 CDP。Traefik 保留 Selkies 路径前缀。 |
| C · 独占 | 核查固定 Selkies 版本的安全模式令牌表及 DSH 公开工具守卫。分派调用时，使用者应保留视频并失去输入权限。DSH 的 shell 工具也不能另行直连 CDP。 |
| D · 扩展 API | 查阅公开的侧栏、客户端模块和 Browser Use 契约。只用公开 API。注册、浮动和保留 DOM 的测试无法证明缺失的原生操作可用。 |

- 在 A 中验证已认证的 Web 启动和 Profile 状态。有意触发一次就绪失败并确认指针回滚。重建容器后无需重装，检查 Store、清单、锁文件、包链接及 Bundle 的启动标记。单独记录生命周期脚本结果。
- 在 B 中远程操作 Selkies 和 CDP。比较标签页和 Cookie，再检查配置持久化、响应头和传输。
- 在 C 中引入自定义输入拦截镜像或代理前，先取得架构决策。
- D 的探针不改 DSH 核心，不导入 dockkit 私有模块。

## 独立 Provider 实验

1. 只让 Provider 作为客户端接入隔离 CDP 网桥。DSH 通过官方 ACP 使用范围受限、有状态的 Streamable HTTP MCP。
2. 每个一次性凭据绑定一个连接。MCP 事件流中断时撤销租约。授权和接管走独立控制网。
3. 分派前验证在线连接、代次和期限。工具在 Chromium 已有上下文的测试标签页写入标记。
4. 用同步点挂起真实操作。在此期间尝试并发调用和交接，同时发送 Selkies 输入。
5. 断线后无法确认操作完成时，保持锁定，换新的 Chromium 进程后再恢复输入。

使用一次性卷和密钥。实验不增加 DSH API，不改侧栏，不实现产品功能。

## 证据

记录命令、运行器链接、失败和未完成的检查。日志不记录启动认证 URL、令牌或 Cookie。[M0 报告](M0-evidence.zh-CN.md) · [Provider 运行记录](M0-provider-evidence.zh-CN.md)
