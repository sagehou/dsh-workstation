# M0 验证结果与决策

[English](M0-evidence.md) · 简体中文

[Issue #1](https://github.com/sagehou/dsh-workstation/issues/1) · [验收标准](M0.zh-CN.md) · [实验设计](M0-design.zh-CN.md)

**继续 [M1 Runtime 和私有启动](M1.zh-CN.md)。** Runtime、Profile 持久化及共享 Chromium 实验通过。项目所有者批准开始 Runtime 工作，浏览器的限制留待后续。Selkies 的鼠标按住问题以及原生侧栏缺少的操作仍未解决，该决定不会把两项结果改为通过。

| 门槛 | 状态 | 证据 |
| --- | --- | --- |
| A — Runtime 与 Profile | 对测试的包和升级版本组合通过 | [Runtime 作业](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353929974)、[原生构建作业](https://github.com/sagehou/dsh-workstation/actions/runs/44460118655/job/135344573520) |
| B — 共享 Chromium | 对固定版本及测试夹具通过 | [共享标签页、同源路由和重启后恢复配置](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353930294) |
| C — 独占 | Agent 租约和接管排空通过；人工交给 Agent 时仍有已按住输入 | [独立 Provider 证据](M0-provider-evidence.zh-CN.md#实际结果) |
| D — DSH 插件 API | ACP 通过官方 MCP 限制浏览器调用；原生浮动最大化与还原仍未通过 | [侧栏生命周期作业](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353930328) |

## 确切的上游版本

- 记录时，官方 [npm 元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh)为 `latest=0.2.2-rc.1`、`next=0.2.2-rc.5` 和 `alpha=0.2.2-alpha.3`。`latest` 仍是候选发布版。两个测试包都要求 Node `>=24.9.0`，`dsh` 可执行入口位于 `lib/bin.js`。确切源码：[`dsh-v0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db)、[`dsh-v0.2.2-rc.5`](https://github.com/deepseek-ai/deepseek-harness/tree/9c2670d3bce5275e0d1610272958121af87787bb)。
- Runtime 基础镜像：`node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54`，pnpm `11.28.5`，构建中实际使用 Git `2.39.5`，UID `1000`。原生构建测试使用 `node-pty@1.2.0-beta.15`、`node-gyp@11.5.0` 和基础镜像自带的 Node 头文件。
- 浏览器：`lscr.io/linuxserver/chromium:075b0b99-ls64@sha256:6d2a8da6a45d4083a7287211a619ca29fdb518ebea0ef562c27392ba2f6698d2`，Chromium `156.0.8078.79`，CDP 协议 `1.3`。官方 registry 的 `linux/amd64` 清单为 `sha256:995fa4a4278d8ee90a13c33e983c45606aec8bd69bf6236b7c68cf07c89d16f4`。配置标签标明了 [Chromium 脚本源码](https://github.com/linuxserver/docker-chromium/tree/4ec00555069627093b9110daff841d363f9a95f8/root)，构建记录标明使用 [baseimage-selkies `debiantrixie-60ce2ea6-ls152`](https://github.com/linuxserver/docker-baseimage-selkies/releases/tag/debiantrixie-60ce2ea6-ls152)，包含 [Selkies `2.2.1`](https://github.com/selkies-project/selkies/tree/d6b9351421bd503ffa89bdee78e2bce758b1ffe5)、Pixelflux `2.2.3` 和 PCMFlux `2.2.1`。
- 入口和测试驱动：`traefik:v3.7.19@sha256:a6c0194dda77bcb804824580f36fa7edc56e315b1acfe933366c8b52844a78a4`、`mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48`、`playwright@1.61.1`。该 Playwright 包用于驱动测试；DSH Browser Use Provider 是独立的 `0.2.2-rc.1` 包，使用 `@playwright/mcp@0.0.80`。

复查发布元数据的只读命令：

```sh
curl -fsS 'https://registry.npmjs.org/@deepseek-ai%2fdsh' | jq '."dist-tags"'
curl -fsS 'https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.2-rc.1' | jq '{version, engines, bin, dist: .dist.integrity}'
curl -fsS 'https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.2-rc.5' | jq '{version, engines, bin, dist: .dist.integrity}'
curl -fsS 'https://api.github.com/repos/deepseek-ai/deepseek-harness/tags' | jq '.[] | {name, sha: .commit.sha}'
curl -fsS 'https://registry.npmjs.org/@deepseek-ai/dsh-client-ui-sidebar-right/-/dsh-client-ui-sidebar-right-0.2.2-rc.1.tgz' \
  | tar -xzOf - package/lib/types/client/tab-registry.d.ts
docker buildx imagetools inspect 'lscr.io/linuxserver/chromium:075b0b99-ls64'
```

## 远端复现

使用一次性远端 Docker 环境，检出干净副本，不使用已有的 DSH 或 Chromium 卷。[工作流](../../.github/workflows/m0.yml)在 GitHub Actions 的 `ubuntu-24.04` 上运行；向 `m0/issue-1` 推送实验文件或工作流变更时触发。上述运行记录 Docker `28.0.4` 和 Compose `2.38.2`。脚本使用隔离的 Compose 项目名并删除测试卷。日志不应包含 DSH 启动 URL、令牌和 Cookie。

[提交 `93a31de` 的最终运行](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576)通过以下四项实验作业，跳过单独的原生构建。运行只证明探针中实现的断言；C、D 剩余验收项仍受阻。

```sh
# Gate A — Runtime and Profile.
bash prototypes/m0/runtime/run.sh

# Gate B and the human input part of Gate C.
bash prototypes/m0/browser/run.sh
bash prototypes/m0/browser/run.sh --exclusive

# Gate D — Sidebar fixture.
bash prototypes/m0/browser/sidebar/run.sh
```

独立的原生构建已明确批准在远端执行一次。[提交 `058e789`](https://github.com/sagehou/dsh-workstation/commit/058e789)记录的命令：

```sh
docker compose -f prototypes/m0/runtime/compose.yml run --build --rm --no-deps -T runtime bash /m0/native.sh
```

再次执行该构建须单独获批。作业使用 `--ignore-scripts` 安装依赖，删除 `node-pty` 预构建产物，再以 UID `1000` 执行固定版本的 `node-gyp` rebuild。输出为 `gyp info ok` 和 `source-built node-pty emitted expected PTY output as uid 1000`。断言确认加载的是 `build/Release/pty.node`。这是独立的 PTY 检查，不是针对插件生命周期脚本的普遍批准，也未测试 DSH Web 终端。

## A — Runtime 和 Profile

官方 [CLI 参考](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/apps/cli/reference/README.md)和 [Plugin Manager 参考](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/plugin-manager/README.md)记录本次验证的契约。`dsh web --no-open --port 0` 会按需初始化自带的 Web Profile。启动后输出一个启动 URL，探针用该 URL 换取 Cookie，断言已认证的启动页返回 HTTP 200。所测试的版本拒绝 `--host 0.0.0.0`；有意触发的失败走实际启动路径。反向代理接入可参考 [Web 应用绑定、Host/Origin 和会话规则](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/web-app/README.md#public-deployments)。

`dsh plugin --profile web add` 使用 pnpm 调用官方包操作，原型采用 `--save-exact --ignore-scripts --ignore-workspace-root-check`。npm 测试包是 `@deepseek-ai/dsh-experimental-badge-skill-bundle@0.2.2-rc.1`。Git HTTPS 测试包是 `git+https://github.com/sagehou/dsh-workstation.git#8a1d8c03ff3e2f94abc82792ed0771bc82b6fb63&path:/prototypes/m0/runtime/fixture`。已保存的依赖与已启用的 `dsh.profile.bundles` 是不同状态，启用也不保证 Bundle 成功加载。Git 测试包在每次就绪测试启动时写入新的标记，测试不会从已安装推断已激活。加载顺序为 Bundle 层、Profile patch、home patch、CLI 叠加配置。内置 Bundle 由所选 DSH 安装目录解析；安装目录未提供的外部 Bundle 由 Profile 解析。

Plugin Manager 服务提供 Web Plugins 页面和 `plugin_manager` 工具。文档中的 `inspect`、`installBundle`、`listBundles` 分别区分来源元数据、安装和激活。启用 Profile HMR 时，变更可实时应用；只在启动时加载的 Profile 可能需要重启。[兼容性契约](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/plugin-manager/README.md#version-compatibility-and-exemptions)检查声明的 `engines.dsh` 和 DSH peer 范围。Git 元数据在获取后检查，拒绝操作可能在 Store 里留下已下载文件。确切版本的豁免保存在 Profile 的 `compatibility.json`，与依赖脚本批准分开。记录的测试使用 CLI，没有启用豁免或批准脚本。

| Runtime 容器内路径 | 归属和证据 |
| --- | --- |
| `/dsh-home/runtime/versions/<version>` 和 `/dsh-home/runtime/current` | 仅原型使用。在 `flock` 锁下暂存并原子更新符号链接；`current` 指向活动版本。 |
| `/dsh-home/profiles/web/package.json`、`cordis.patch.yml`、`compatibility.json` | 上游依赖和有序 Bundle 清单、Profile 叠加配置及可选的精确兼容性豁免。重建前后及双向切换版本时，清单和 patch 摘要一致。 |
| `/dsh-home/profiles/web/pnpm-lock.yaml`、`pnpm-workspace.yaml`、`node_modules/.pnpm` | 插件锁文件、原型 Store 与脚本策略、解析后的包链接。两个测试包的清单、patch 和链接目标一致。 |
| `/dsh-home/pnpm/store/v11` | 实验选用的 Store 路径，不是上游默认值。pnpm 报告使用内容寻址 Store 的硬链接；容器重建前后，Store 文件集合的指纹一致。 |
| `/dsh-home/cordis.patch.yml`、`.credentials.yaml`、`sessions/`、`storages/` | [基础 Profile](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/base/cordis.patch.yml)中的上游 home 叠加配置及数据。保存在同一个卷；未测试真实凭据、已保存对话的迁移与恢复。 |
| `/workspace`、`/backup` | 独立卷。原型在修改 Profile 依赖或切换版本前对 DSH_HOME 做快照。 |

[提交 `5686d9e` 的 Runtime 作业](https://github.com/sagehou/dsh-workstation/actions/runs/44460212791/job/135344880883)通过，日志如下：

```text
installed DSH 0.2.2-rc.1 in /dsh-home/runtime/versions/0.2.2-rc.1
authenticated Web boot OK; Git bundle apply: observed
container recreated: image unchanged
installed DSH 0.2.2-rc.5 in /dsh-home/runtime/versions/0.2.2-rc.5
readiness rejected DSH 0.2.2-rc.5; pointer restored to versions/0.2.2-rc.1
[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @deepseek-ai/dsh@0.0.0
active DSH 0.2.2-rc.5
active DSH 0.2.2-rc.1
runtime/plugins: tested both DSH versions, recreation and two rollback paths on one image
```

重建后不用重装，Store 和锁定的插件依赖仍在。两个 DSH 版本都能启动该 Profile，无需修改依赖并成功加载 Git 测试包。指针回滚不能撤销数据迁移。此测试未证明所有插件都兼容、Plugin Manager 内部可进行原生构建，未批准 Git `prepare` 脚本，也未覆盖有额外系统库依赖的插件。官方管理器可以按 Profile 批准审查过的精确待处理 `allowBuilds` 键；全局放开不在测试范围内。

## B — 同一个浏览器进程与配置目录

LinuxServer 的 [`autostart_wayland`](https://github.com/linuxserver/docker-chromium/blob/4ec00555069627093b9110daff841d363f9a95f8/root/defaults/autostart_wayland)把 `CHROME_CLI` 传给 [`wrapped-chromium`](https://github.com/linuxserver/docker-chromium/blob/4ec00555069627093b9110daff841d363f9a95f8/root/usr/bin/wrapped-chromium)。探针使用 `/config/m0-chromium` 和 CDP 端口 `9222`。同一网络命名空间里的中继只从隔离的 Docker 网桥转发到回环监听器。不发布宿主机端口。浏览器作业验证宿主机访问，并由对等容器请求 `/json/version` 和 `/json/list`。

在 [`d71856d`](https://github.com/sagehou/dsh-workstation/actions/runs/44461308475/job/135348481161) 中，人工经 Selkies 界面发送键盘输入，打开了 CDP 可发现的标签页，并在 Playwright 已有的默认上下文设置持久化测试 Cookie。随后由 Playwright 创建的标签页接收了 Selkies 输入并读到相同 Cookie。作业确认只有一个 Chromium 主进程，检查实际命令行、配置目录路径及重启前磁盘上的 Cookie。测试使用单独的无头浏览器驱动 Selkies 界面；人工和 Agent 共同操作的目标只有受管的桌面 Chromium。通过的作业输出：

```text
no host ports published; host CDP probes denied
private peer CDP: Chrome/156.0.8078.79; protocol 1.3
same-origin HTTPS iframe received Selkies WebSocket video through the unchanged /browser/ prefix
human-side Selkies keyboard opened a tab visible in CDP and set a cookie in the default context
agent-created tab accepted Selkies input and shared the human-set cookie
Chromium reported an enforced frame-ancestors denial for the cross-origin iframe
test cookie committed to the persistent Chromium profile
persistent cookie still present in the default context after Chromium restart
```

较早的运行分别因[重启后 Cookie 断言](https://github.com/sagehou/dsh-workstation/actions/runs/44459609588/job/135342898428)（`496a285`）和[到达持久化测试前的界面键盘导航](https://github.com/sagehou/dsh-workstation/actions/runs/44460212791/job/135344880671)（`5686d9e`）失败。最终探针会等到收到实际视频帧，并在 Chromium 的初始标签页聚焦一个链接，避免依赖观看端连续转发多个浏览器快捷键。

Traefik 保留 `/browser/` 前缀，LinuxServer 使用 `SUBFOLDER=/browser/`。[内置 Nginx 模板](https://github.com/linuxserver/docker-baseimage-selkies/blob/6379480bcbd4ba42c1f5d4ab5eca49304fdedf83/root/defaults/default.conf)要求该前缀，并把 API 代理给 Selkies。同一个测试用 ForwardAuth 拒绝未认证的应用请求和 `/browser/` API 请求，已认证的同源 iframe 经 WebSocket 播放视频。Traefik 明确设置 `frame-ancestors 'self'` 和 `X-Frame-Options: SAMEORIGIN`；同站点的另一个 HTTPS 源因浏览器 iframe 策略被拒绝。应用路由是测试服务，因此这次实验未证明能与 DSH 自身的启动令牌交换共同单点登录，也不代表实际认证服务的行为。

连接使用 `browser.contexts()[0]`，而非新建隔离上下文。通过的探针断开连接后，桌面仍在运行。不要为 Agent 开放关闭外部浏览器或上下文的操作。CDP 完整功能对等、下载持久化和 Provider 断开后的恢复不在本节观察结果内。

## C — 独占控制

Selkies `2.2.1` 文档描述 [`SELKIES_MASTER_TOKEN` 和 `POST /api/tokens`](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/docs/secure-mode.md)。它的[输入权限规则](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/src/selkies/sessions.py#L62)用于两种传输方式，实验固定使用 WebSocket。探针直接发送键盘和鼠标帧，检查 CDP 目标实际收到的事件数，不能只看服务端判断。同一个连接在锁定前后都能传递输入；锁定时事件计数不变，同时接收新视频。通过的 `d71856d` 运行报告：

```text
Selkies server denied raw keyboard and mouse frames while the same socket received new video
restoring the token table re-enabled keyboard and mouse on the existing socket
```

在 [`5686d9e`](https://github.com/sagehou/dsh-workstation/actions/runs/44460212791/job/135344880925) 中，作业因 `Selkies secure-mode control plane unavailable` 停止。通过的测试使用单行且尾部无换行的 Compose secret，并加入只显示状态的诊断。令牌管理路由不经过 Traefik 浏览器路由。WebRTC、其他输入或设备路径、交接时已按住的键或按钮，以及 Selkies 重启时能否保持安全状态，仍需在最终集成适用的情况下取得证据。

门槛 B 中未加鉴权的 CDP 中继仅供实验。官方 DSH [Browser Use Playwright MCP Provider](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/experimental/browser-use-playwright-mcp/README.md)记录了 `mode: attach` 和 `endpoint`。它的 Session 预留只在 Provider 实例内有效。共享的 `ctx.browserUse` 服务只用于注册 Provider，没有统一的操作拦截 API。DSH 的公开 [`ctx.tools.guard`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/tools.md#ctxtools--tools)可以拒绝工具调用，[流水线](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/pipeline.ts#L213)在分派前调用它。如果 Agent 的执行环境可以直接访问 CDP，DSH 的工具守卫无法对此强制执行租约。

获批的[独立 Provider 实验](M0-provider-evidence.zh-CN.md)在 ACP Profile 上使用 DSH 有文档的 [Streamable HTTP MCP 集成](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/mcp.md)。只有 Provider 能访问私网 CDP。该测试通过了租约准入、接管排空、过期、并发、旧代次以及 DSH、Chromium、Provider 进程退出和重启场景。按住鼠标键的断言失败，授权前的鼠标按下状态持续到输入权限交回 HUMAN。门槛 C 需要一种受支持的方法，在把控制权授予 Agent 前停止并释放已经接收的输入。

## D — 原生侧栏生命周期

对应版本的[侧栏文档](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/sidebar-right.md)和[客户端模块契约](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/client-modules.md)列出 `dsh.client`、Bundle 的 `./client` 导出、`ctx.sidebarRightTabs.register`、`sidebar.right.pane.tab` 插槽及 `keepMounted`。探针通过 Plugin Manager 安装本地 Bundle，使用这些公开服务。客户端产物采用[固定的上游预设](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/tsdown.client.ts#L1-L12)生成的、有文档支持的打包格式。iframe 加载的是同源测试响应，并非实时 Selkies。测试从 iframe 内读取加载次数和值，证明浏览上下文是否保留，不能只检查 iframe 元素还在不在。

[公开服务](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/service.ts#L249-L298)提供 `float` 和 `dock`。浮动层的[标题栏与大小调整手柄](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-dockkit/src/components/FloatLayer.tsx#L311-L345)支持原生拖动、调整大小和停靠，没有浮动最大化与还原。全屏适用于[停靠列](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx#L273-L292)。有文档的 [`hide` 实现](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/service.ts#L577-L585)会关闭浮动标签页；`keepMounted` 无法保留已关闭的标签。关闭 iframe 不会停止独立的 Chromium 容器。[`0.2.2-rc.5`](https://github.com/deepseek-ai/deepseek-harness/tree/9c2670d3bce5275e0d1610272958121af87787bb/packages/client)中对应的服务与浮动标题栏也有同样限制。

诊断运行 [`f4cd89a`](https://github.com/sagehou/dsh-workstation/actions/runs/44462375518/job/135351996893)报告 `web boot: 1 entry did not activate`（`dsh-m0-sidebar-probe: failed`）。子系统概述列出了一个 `guide` 条目的字段；发布的 [`SidebarRightTabDefinition`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/tab-registry.ts#L61-L137)要求 `guide?: readonly SidebarRightGuideEntry[]`，每个条目有 `id`。npm 包的 `./client` 类型声明和注册实现都确认是数组。修正该问题和对话定位后，[提交 `93a31de` 的远端侧栏作业](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353930328)在实际 npm Web 应用中运行。回环地址上的模型测试服务让会话完成，不需要 DeepSeek 账号：

```text
npm DSH loaded the external client plugin through its Profile bundle
iframe retained across tab selection and docked hide/show
iframe retained across native float, resize and dock
iframe retained across docked fullscreen and restore
upstream floating hide closes the tab; its iframe does not survive
```

约定的原生浮动生命周期等上游支持。独立 Provider 通过官方 MCP 在 ACP 中演示了受控的浏览器工具调用，没有改动 DSH 核心。实验未在租约下验证官方 Playwright MCP Browser Use 包，也未验证与 Web Profile 会话的凭据绑定。

证据收集于 2026-11-19 UTC。实验使用一次性环境，没有部署到生产服务器。
