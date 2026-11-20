# M0 独立浏览器 Provider

[English](M0-provider-evidence.md) · 简体中文

[Issue #1](https://github.com/sagehou/dsh-workstation/issues/1) · [M0 决策](M0-evidence.zh-CN.md) · [已批准的实验设计](M0-design.zh-CN.md)

**门槛 C 仍未通过。** 实验验证了 Agent 租约和接管排空，但交接前已按住的鼠标键没有释放。

## 实验拓扑

- 隔离 CDP 网桥只有 Provider 一个客户端。中继与 Chromium 共用网络命名空间。
- DSH 在独立网桥上，通过官方 MCP 发现一个固定测试动作。DSH 包和浏览器镜像沿用上游版本。[官方 MCP 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/README.md)

1. 可信测试驱动通过 ACP 配置不同连接凭据。控制监听器在独立内部网桥签发凭据和开始交接。[公开 ACP 会话接口](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/acp/acp/README.md#standard-acp-v1-surface)
2. 每个一次性凭据绑定一个有状态 MCP 会话及其 HTTP 事件流。分派前检查连接、代次、期限和是否已有操作。
3. 接管或过期时停止接收新调用，等待渲染器结束，撤销租约，再恢复 Selkies 输入。持久化浏览器标识在无法确认操作结束时禁止解锁同一 Chromium 进程。

## 在 GitHub Actions 复现

选择 `m0/issue-1` 上确切的实验提交，在 GitHub 托管的 `ubuntu-24.04` 作业运行。[M0 Browser Provider 工作流](../../.github/workflows/m0-provider.yml)

```sh
bash prototypes/m0/provider/run.sh
```

作业构建固定版本的测试镜像，将官方 DSH 安装到一次性卷，运行三个 Compose 文件和断言驱动，再删除容器和卷。脚本只在 GitHub 托管运行器上运行。

npm 和 pnpm 生命周期脚本已禁用。一次获批的 `node-pty` 构建单独执行。输出保存在 `m0-browser-provider`。

### 版本

- DSH `@deepseek-ai/dsh@0.2.2-rc.1`，配套 `@deepseek-ai/dsh-mcp-client@0.2.2-rc.1`，以及后者的 `@modelcontextprotocol/client@2.2.0`。测试驱动启动 `dsh --profile acp`，使用回环地址上结果确定的 Messages SSE 测试服务。npm 安装的 DSH 进程自己完成 MCP 发现、工具执行和会话持久化。
- Provider 使用 `@modelcontextprotocol/sdk@1.31.0` 的有状态 Streamable HTTP 和 `zod@4.4.3`。DSH 和 Provider 协商得到 MCP `2025-11-25`，租约基于该有状态版本的事件流。
- Runtime 与 Provider 使用 Node `24.22.3`，Runtime 使用 pnpm `11.28.5`，Chromium `156.0.8078.79` 和 CDP `1.3`，Selkies `2.2.1`、Playwright `1.61.1` 和 Traefik `3.7.19`。[固定基础镜像的摘要](M0-evidence.zh-CN.md#确切的上游版本)未变。

运行器版本为 Docker `28.0.4`、Compose `2.38.2`、Node `22.23.4`。

### 较早的运行

| 运行 | 结果 |
| --- | --- |
| [`6b1273e`](https://github.com/sagehou/dsh-workstation/actions/runs/44465917230/job/135363548859) | 镜像已构建。`docker compose run` 拒绝 `--no-build`，断言未执行。 |
| [`2b38dee`](https://github.com/sagehou/dsh-workstation/actions/runs/44466292113/job/135364758280) | 安装 DSH 并启动。CDP 容器正好是预期的两个，但列表多一个空行导致比较失败。后续忽略空行。 |
| [提交 `ffb3b37` 的运行](https://github.com/sagehou/dsh-workstation/actions/runs/44466616406/job/135365828906) | 网络、MCP `2025-11-25`、首次实际调用、第二个 Agent 拒绝和视频继续时的输入拦截通过。DSH 顺序执行批次工具，返回 `M0_OK,NO_LEASE`，未返回 `BUSY,M0_OK`。 |

DSH 调度器会串行执行未声明并发安全的工具。最终驱动保持真实 DSH 操作进行中，再用相同认证会话发出标准 MCP `tools/call`。它要求接管前返回 `BUSY`，排空时返回 `HANDOVER`，两个被拒请求均不影响渲染器。[官方调度器](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/pipeline.ts#L98-L113)

## 实际结果

提交 `2fbed01` 的作业执行以下各个场景，最后因按住鼠标断言失败退出，退出码 **1**。[提交 `2fbed01` 的作业](https://github.com/sagehou/dsh-workstation/actions/runs/44467202793/job/135367748850) · [日志产物](https://github.com/sagehou/dsh-workstation/actions/runs/44467202793/artifacts/14502827811)

| 场景 | 结果 | 实际行为 |
| --- | --- | --- |
| CDP 和控制面 | 通过 | 仅 Chromium 命名空间和 Provider 有 CDP 端点。宿主机、DSH 和观看端无法直连。DSH 也无法访问两个控制端点。MCP 拒绝匿名请求。 |
| 租约准入 | 通过 | 官方 DSH 工具在有效租约下写标记。无租约返回 `NO_LEASE`，不同会话携带当前代次收到 `NOT_OWNER`。两个并发授权请求产生一个授权和一个 `NOT_HUMAN`。 |
| Selkies 输入 | 新帧通过 | Agent 模式拦截原始键盘和鼠标按键帧。同一连接继续接收视频。 |
| 并发和接管 | 通过 | 重叠调用返回 `BUSY`，等当前操作结束期间的新调用返回 `HANDOVER`。两者均未到达渲染器。挂起的操作完成后撤销租约，并在原连接恢复人工输入。 |
| 过期和代次 | 通过 | `4500 ms` 的租约在真实操作中间过期。系统停止准入、等待渲染器，保留视频。旧代次在无租约时失败，同一会话新授权后也返回 `STALE_GENERATION`。 |
| DSH 重启 | 通过 | `docker compose kill -s SIGKILL dsh` 关闭 MCP 流。渲染器结束前保持输入锁定。原会话恢复后需要新凭据和租约。 |
| Chromium 重启 | 通过 | `docker compose kill -s SIGKILL chromium` 中断操作且无完成标记。`DISCONNECTED` 拒绝调用，重启后须显式恢复并取得新代次。 |
| Provider 重启 | 通过 | `docker compose kill -s SIGKILL provider` 后，操作仍完成，原 Selkies 连接保留视频并拦截输入。重启对旧进程返回 `RESET_NEEDS_NEW_BROWSER`。更换 Chromium 后可显式恢复并建立新租约。 |
| 按住鼠标 | **失败** | HUMAN 时按下事件到达 Chromium。Selkies 切换到 `MK_ACCESS,0` 后丢弃释放帧。Agent 操作发生在释放之前。接管回到 HUMAN 时释放帧才到达。 |

### 失败断言

```text
AssertionError [ERR_ASSERTION]: Gate C BLOCKED: a mouse button held before grant was not released by the live Selkies token update
```

## 决策

给 Agent 授权前，需停止并释放已进入浏览器的人工输入，再确认释放完成。固定版本的 Selkies 在在线连接上同步令牌权限，在断开路径释放按住的设备。实验没有使用输入代理或界面开关。[令牌同步逻辑](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/src/selkies/websockets_mode.py#L8297) · [释放已按住的输入](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/src/selkies/websockets_mode.py#L3103)

- 实验使用**单个 Provider**、固定 Docker 拓扑和 WebSocket Selkies，仅使用键盘和鼠标，禁用文件传输。可信 ACP 驱动提供每会话凭据。
- 实验不覆盖 Web Profile 会话绑定、租约下的官方 Playwright MCP Browser Use、网络分区及宿主机断电。
- 门槛 D 仍要求原生浮动最大化与还原及 iframe 生命周期。实验没有变更已接受的 ADR，也未授权启动 M1。

证据记录于 2026-11-19 UTC。
