# M0 独立浏览器 Provider

[English](M0-provider-evidence.md) · 简体中文

[Issue #1](https://github.com/sagehou/dsh-workstation/issues/1) · [M0 决策](M0-evidence.zh-CN.md) · [已批准的实验设计](M0-design.zh-CN.md)

这是对门槛 C 和门槛 D 中 Browser Use 扩展检查的一次性补充实验。Provider 是隔离 CDP 网桥上的唯一客户端；中继与 Chromium 共享网络命名空间。DSH 在独立的 MCP 网桥上。其唯一的浏览器工具是固定的测试动作，由 DSH 的[官方 MCP 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/README.md)发现。没有修改 DSH 包或上游浏览器镜像。

可信的 Actions 测试驱动通过[公开 ACP 会话接口](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/acp/acp/README.md#standard-acp-v1-surface)配置各自的连接凭据。只有独立内部网桥上的控制端点可签发凭据或开始交接。MCP 监听器将一个一次性凭据绑定到一个有状态 MCP 会话及其 HTTP 事件流。分派工具前核验在线连接、活动代次、期限，以及是否有操作正在执行。接管或过期会停止接收新操作，等待实际渲染器操作结束，撤销租约，再开放 Selkies 输入。进程崩溃后渲染器操作可能仍在运行，因此会持久化 Chromium 进程标识，无法确认完成时禁止在同一进程恢复输入。

## 在 GitHub Actions 复现

用 `m0/issue-1` 上对应的实验提交运行 [M0 Browser Provider 工作流](../../.github/workflows/m0-provider.yml)。托管的 `ubuntu-24.04` 作业执行：

```sh
bash prototypes/m0/provider/run.sh
```

脚本拒绝在非 GitHub 托管环境运行。它构建固定版本的测试镜像，把官方 DSH npm 精确版本安装进一次性卷，运行三个 Compose 文件和断言驱动，再移除容器和卷。npm 和 pnpm 生命周期脚本已禁用。一次性批准的 `node-pty` 原生构建不在此工作流内。GitHub 将输出保存为 `m0-browser-provider`。

- DSH `@deepseek-ai/dsh@0.2.2-rc.1`，配套 `@deepseek-ai/dsh-mcp-client@0.2.2-rc.1`，以及后者的 `@modelcontextprotocol/client@2.2.0`。测试驱动启动 `dsh --profile acp`，使用回环地址上结果确定的 Messages SSE 测试服务。npm 安装的 DSH 进程自己完成 MCP 发现、工具执行和会话持久化。
- Provider 使用 `@modelcontextprotocol/sdk@1.31.0` 的有状态 Streamable HTTP 和 `zod@4.4.3`。DSH 和 Provider 协商得到 MCP `2025-11-25`，租约基于该有状态版本的事件流。
- Runtime 与 Provider 使用 Node `24.22.3`，Runtime 使用 pnpm `11.28.5`，Chromium `156.0.8078.79` 和 CDP `1.3`，Selkies `2.2.1`、Playwright `1.61.1` 和 Traefik `3.7.19`。[固定基础镜像的摘要](M0-evidence.zh-CN.md#确切的上游版本)未变。

托管运行器报告 Docker `28.0.4`、Compose `2.38.2` 和宿主 Node `22.23.4`。[提交 `6b1273e` 的运行](https://github.com/sagehou/dsh-workstation/actions/runs/44465917230/job/135363548859)构建了镜像，但在断言前停止，因为 `docker compose run` 不支持 `--no-build`。[提交 `2b38dee` 的运行](https://github.com/sagehou/dsh-workstation/actions/runs/44466292113/job/135364758280)安装了 DSH 并启动实验环境。列出的 CDP 网络容器正好是预期的两个，但多出一个空行，导致比较中断；测试现已忽略空行。

[提交 `ffb3b37` 的运行](https://github.com/sagehou/dsh-workstation/actions/runs/44466616406/job/135365828906)通过网络边界检查、协商 MCP `2025-11-25`、执行真实 DSH 工具调用、拒绝第二个 Agent，并拦截 Selkies 原始键盘和鼠标输入，同时保留视频。它在并发断言处停止：DSH 批次中的两个工具顺序执行，返回 `M0_OK,NO_LEASE`，而非 `BUSY,M0_OK`。[官方调度器](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/pipeline.ts#L98-L113)会串行执行未声明并发安全的工具。更新后的测试保持真实 DSH 操作进行中，在 DSH 容器中用同一已认证会话发出第二个标准 MCP `tools/call`。测试要求接管前返回 `BUSY`，等待已开始操作结束期间返回 `HANDOVER`，并且两个被拒请求都不产生渲染器效果。

## 实际结果

[提交 `2fbed01` 的作业](https://github.com/sagehou/dsh-workstation/actions/runs/44467202793/job/135367748850)运行了下列所有场景。最后一项按住鼠标键的断言失败，退出码为 **1**。[日志产物](https://github.com/sagehou/dsh-workstation/actions/runs/44467202793/artifacts/14502827811)包含完整输出。GitHub Actions 作业仍标为失败。

| 断言 | 实际结果 |
| --- | --- |
| CDP 和控制面隔离 | **通过。** 只有 Chromium 和 Provider 在 CDP 网桥中有端点，中继共享 Chromium 的命名空间。宿主机、DSH 及视频观察网桥均不能直连 CDP。DSH 也无法访问 Provider 或 Selkies 控制端点；它能访问的 MCP 监听器拒绝未认证请求。 |
| 租约与所有权 | **通过。** 官方 DSH 进程使用有效租约，在已有 Chromium 上下文写入标记。无租约的调用收到 `NO_LEASE`，不同 DSH 会话携带当前代次调用时收到 `NOT_OWNER`。同时发出两次授权，一个成功、一个收到 `NOT_HUMAN`。Agent 模式下，原始键盘和鼠标按键帧未到达 Chromium，而同一 Selkies 连接继续接收新视频帧。 |
| 并发调用与接管 | **通过。** 同一持有者的重叠调用收到 `BUSY`，开始接管后的新调用收到 `HANDOVER`，二者均未到达渲染器。被挂起的 CDP 操作完成时，人工输入仍被拦截。随后 Provider 撤销租约，Chromium 又从同一 Selkies 连接收到键盘和鼠标事件。 |
| 过期与旧代次 | **通过。** `4500 ms` 租约在实际挂起的操作期间过期。系统关闭新调用入口，等待渲染器完成，视频继续。旧代次在无租约时无法调用，对同一 DSH 会话重新授权后也不能调用（`STALE_GENERATION`）。 |
| DSH 断开与重启 | **通过。** `docker compose kill -s SIGKILL dsh` 使 MCP 事件流关闭。渲染器操作结束之前，Provider 继续锁定输入。重启后，已用过的传输凭据不能初始化；原持久化 DSH 会话使用新凭据恢复，且需要新租约。 |
| Chromium 断开与重启 | **通过。** `docker compose kill -s SIGKILL chromium` 中断挂起的渲染器操作。未出现完成标记；Provider 进入无租约的 `DISCONNECTED`，拒绝后续 MCP 操作。须对重启后的浏览器显式执行恢复并取得新代次，工具才能再次调用。 |
| Provider 断开与重启 | **通过。** 执行 `docker compose kill -s SIGKILL provider` 后，即使原有渲染器操作继续并完成，同一 Selkies 连接仍保留视频并拦截键盘与鼠标输入。Provider 重启后，由于保留了原 Chromium 进程标识，对该进程恢复得到 `RESET_NEEDS_NEW_BROWSER`。更换 Chromium 并显式恢复后，新 MCP 租约生效。 |
| 授权前已按住的输入 | **失败。** 在 HUMAN 状态，原始鼠标按下事件到达 Chromium。Selkies 切到 `MK_ACCESS,0` 后丢弃随后的释放帧。Provider 授予租约并执行了 Agent 操作，此时 Chromium 尚未收到鼠标释放。接管后回到 HUMAN 状态，释放帧才到达 Chromium。 |

日志以如下错误结束：

```text
AssertionError [ERR_ASSERTION]: Gate C BLOCKED: a mouse button held before grant was not released by the live Selkies token update
```

## 决策

独立 Provider 证明了可通过官方 MCP 在 DSH ACP 会话中强制实施服务端租约，且通过本次测试覆盖的 Agent 交还人工、接管等待和恢复场景。**门槛 C 仍阻塞在人工交给 Agent 的切换。** 固定版 Selkies 的[令牌同步逻辑](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/src/selkies/websockets_mode.py#L8297)会在现有连接上通知权限变更；[释放已按住的输入](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/src/selkies/websockets_mode.py#L3103)在断开路径中执行。授权给 Agent 前，需要一种受支持的方法来停止人工输入、释放已按住的键或按钮，并确认已经完成。仅丢弃新输入帧不够。这是架构阻塞；实验没有引入输入代理或用界面开关替代。

测试范围为固定 Docker 拓扑中的单个 Provider，Selkies 使用 WebSocket，禁用键盘和鼠标以外的外设及文件传输。可信 ACP 驱动提供每个会话的凭据。实验未证明 DSH Web Profile 如何把这些凭据绑定到在线会话，也未验证上游 Playwright MCP Browser Use 包在租约下的运行、网络分区或宿主机断电。门槛 D 仍等待上游原生浮动最大化与还原，保留 iframe 生命周期验收项。此实验本身不改变已接受的 ADR，也不授权开始 M1。

证据记录于 2026-11-19 UTC。
