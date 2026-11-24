# 开发路线图与 Coding Agent 移交规范

[English](development-roadmap.md) · 简体中文

**基线批准日期：2026-11-23。** 本路线图落实 [ADR-0004](../adr/0004-single-user-release-and-deferred-sidebar.zh-CN.md)。Issue 标题前缀代表执行顺序；GitHub Issue 编号是永久标识，不随排序改变。

## 产品护栏

- 官方 DSH 继续作为 Agent Runtime 和主要聊天/会话/终端/插件体验。
- 首版只有一个本地管理员、一份 DSH_HOME、一个工作区和一份 Chromium 配置。该管理员可以注册多个 Passkey。
- 首版使用已认证的独立浏览器/控制页面。原生 Sidebar 延后，不得阻塞部署。
- 不 Fork DSH 核心、不自研 Agent Runtime、不替代官方 Plugin Manager、不托管公共插件市场、不提供多人共用模式、不引入 Kubernetes。
- 首版部署只支持 Linux amd64。
- `BROWSER_TOOL_ORIGINS` 是应用层来源白名单，不是网络出口隔离。针对不可信目标的独立出口策略完成前，Agent 浏览必须保持关闭或严格受限。

## 有序任务

| 顺序 | Issue | 工作 | 依赖/退出条件 |
| --- | --- | --- | --- |
| 00 | [#7](https://github.com/sagehou/dsh-workstation/issues/7) | Issue-first 开发和 Agent 进度纪律 | 所有任务都必须遵守；AGENTS 规范已提交，后续任务需验证实际执行。 |
| 01 | [#3](https://github.com/sagehou/dsh-workstation/issues/3) | Traefik 3.7.14 与 3.7.19 兼容性矩阵 | 两条腿均已通过；入口版本未固定时无法解析。 |
| 02 | [#8](https://github.com/sagehou/dsh-workstation/issues/8) | DSH/Profile 升级事务与数据恢复 | 在用户数据上执行原地升级或迁移前完成。 |
| 03 | [#9](https://github.com/sagehou/dsh-workstation/issues/9) | Docker 子网可配置和冲突预检 | 目标主机部署前完成。固定 IP、健康检查和证书 SAN 从同一配置生成。 |
| 04 | [#4](https://github.com/sagehou/dsh-workstation/issues/4) | 浏览器输入独占和安全交接 | 开放 Agent 控制共享浏览器前完成。 |
| 05 | [#10](https://github.com/sagehou/dsh-workstation/issues/10) | GHCR 镜像发布和不可变部署引用 | 宣布具备可重复的正式镜像分发前完成。 |
| 06 | [#6](https://github.com/sagehou/dsh-workstation/issues/6) | 目标主机部署、HTTPS、备份恢复和故障演练 | 依赖 #3、#8、#9 和 #10。#4 通过前关闭 Agent 浏览器控制；#11 通过前关闭不可信网站浏览。 |
| 07 | [#11](https://github.com/sagehou/dsh-workstation/issues/11) | 浏览器出口策略和 SSRF 边界 | 开放 Agent 广泛访问不可信网站前完成。 |
| 08 | [#23](https://github.com/sagehou/dsh-workstation/issues/23) | `main` 分支的 CI 覆盖 | 在相信「合并后的树就是被测试过的树」之前完成；#6 从 main 部署。 |
| 90 | [#5](https://github.com/sagehou/dsh-workstation/issues/5) | DSH 原生 Browser Sidebar | 延后增强；独立页面持续可用，不阻塞首版。 |

## 发布门槛

### Gate A — 可部署的单用户工作台

- 目标 Traefik 补丁版本通过集成矩阵。
- 目标主机 Docker 子网冲突预检和配置通过。
- 单管理员初始化、密码+TOTP、Passkey、会话撤销和恢复可用。
- DSH 和独立浏览器页面可经现有 Traefik 域名访问。
- DSH_HOME、工作区、浏览器配置、Auth DB、Provider 状态和密钥均有经过测试的备份/恢复流程。
- 不宣称多用户隔离或 ARM64 支持。

### Gate B — 安全的 Agent 浏览器控制

- 所有浏览器工具经过同一服务端租约/会话/代次校验。
- Agent 持有租约时 Selkies 阻止人工输入。
- 所有权变更前释放并确认已按住的输入。
- 过期、并发、断开、Provider 重启和 Chromium 重启均失败关闭。
- 此门槛通过前，生产环境不得开放 Agent 浏览器控制。

### Gate C — 不可信网站浏览

- 在模型提示词之外强制执行浏览器网络出口控制。
- 解析并校验目标地址，阻止禁止 IP 范围，并重新校验重定向。
- 验证 DNS rebinding、IPv4/IPv6、回环、链路本地、私有网段和云元数据目标。
- 单靠来源白名单不满足此门槛。

### Gate D — 原生 Sidebar（上线后）

- 只使用 DSH 公开 API，不 Fork 核心或依赖私有 DOM。
- 验证停靠、浮动、调整大小、最大化/还原、隐藏、重连和 iframe 生命周期。
- 独立浏览器/控制页面始终保留为备用入口。

## Coding Agent 移交合同

每个分配的 Issue，Agent 必须：

1. 修改前阅读本路线图、ADR-0004、SPEC、ARCHITECTURE 和对应 Issue。
2. 确认 Issue 范围、依赖和验收清单。缺少必要 Issue 时，先创建再开发。
3. 修改严格限定在分配的 Issue 内，不顺带重构无关服务。
4. 在重要进度节点更新 Issue checkbox，并留言同步进度或阻塞。
5. 每个 PR 添加 `Refs #N` 或 `Closes #N`。不得仅因 PR 合并就关闭 Issue。
6. 运行 Issue 要求的确切测试和版本矩阵，记录命令、版本、CI run/job 链接和实际结果。
7. 汇报通过/未通过的验收项、commit/PR、剩余风险和下一项阻塞决策。
8. 没有可复现证据时，不得宣称部署、恢复、架构兼容或安全保证已经完成。

## 当前移交入口

[#4 — 浏览器人工输入独占与安全交接](https://github.com/sagehou/dsh-workstation/issues/4) 已按 [ADR-0005](../adr/0005-release-held-input-at-selkies.zh-CN.md) 交付。已固定的 Selkies 会在每个输入帧上按实时令牌表判定权限，并且**先**安装新表**再**通告变更，因此权限收回之后发出的释放帧会被丢弃——这正是 M0 的失败现象从服务端视角的表述。不 fork Selkies，而是在输入边界上增加一个小的 `browser-gate`，用上游自带的 `reset_keyboard()` 与 `release_mouse_buttons()` 原语释放已按住输入，排在 Provider 切换令牌表之前，并用 PING/PONG 屏障证明已被派发。

已按住输入的释放是**在真实栈上实测**的，而非推论：在操作者自己的 Selkies 连接上按住鼠标键再交接，由 Agent 的标签页读回「一次按下、一次释放」；按住时直接断开的客户端不会留下按下状态；而移除门禁调用后，同一探针会报告「有按下、无释放」。按住的按键与修饰键、按住时租约过期、按住时 Chromium 重启、Provider 异常退出，仅由「复现真实顺序的假上游」测试覆盖，**尚未**在真实主机实测。在这些实测完成之前，独占性可视为「指针按键与断线场景已证明」，其余尚未证明。

[#10 — GHCR 镜像发布与不可变部署引用](https://github.com/sagehou/dsh-workstation/issues/10) 增加了 `deploy/public/images.env`（逐镜像的 manifest 摘要）与 `deploy/public/images.sh`（解析器：摘要缺失或畸形即拒绝，绝不回退到标签）。初始化脚本新增 `--release`，把四个按摘要固定的 GHCR 引用写入 `.env.public`；默认模式写入本地构建标签，切换模式会替换这些键而不是追加。`publish-images.yml` 仅在 `v*` 标签或手动触发时运行，`packages: write` 只授予发布作业，仅能由标签或手动触发（fork PR 无法发布），拒绝以不同摘要重发已记录的版本，把 SBOM 与构建来源附着到摘要上，并在最后匿名拉取每个已记录摘要。Public Compose 的归档保留为审计证据。

摘要机制已在真实守护进程上针对回环 registry 实测：固定引用能拉取、升级跟随新摘要、回滚恢复到完全相同的旧镜像、清空摘要会失败而非漂移到标签。`WORKSTATION_IMAGE_REGISTRY` 只接受 GHCR 或回环地址，因此该测试无法冒充发布。

首次发布**已经**发生：标签 `v0.2.0` 推送了四个镜像，每个记录的摘要均已脱离工作流独立核对、可用匿名拉取令牌解析、并带有 `linux/amd64` 目标。CI 新增的 `release-compose` 作业在无凭据条件下拉取这些摘要、不执行构建、并通过同一套栈检查，因此「发布产物确实能运行」是实测而非假设。

`release-compose` 腿在首次运行时就发现 `runtime:0.2.0` 无法启动：`COPY --chmod` 把其模块目录设成了 0644，以 `node` 运行的容器无法进入该目录。发布流程现在会在推送前对镜像做冒烟测试，runtime 因此为 `0.2.1`；`0.2.0` 保持公开并明确标注为已被取代。本地构建的镜像此前通过了全部栈测试，因此除了实际运行发布产物，没有任何检查能发现这个问题。

不存在审批门槛，也不声称有：唯一操作者也是唯一能触发发布的人，因此触发器集合就是控制手段。仍未验证：在真实部署主机上跨两个发布的升级/回滚演练、以及任何非 `amd64` 产物。

[#23 — `main` 分支的 CI 覆盖](https://github.com/sagehou/dsh-workstation/issues/23) 补上了本交接此前略过而非修掉的缺口：在此之前没有任何 workflow 在 `main` 上触发，`?branch=main` 返回 **零** 次运行。每个 PR 都在自己的分支上通过，所以这不是「把坏代码发了出去」，但绿色的 PR 并不证明合并后的树是绿的——squash、冲突解决、或两个各自通过的 PR 交互后失败，都不会被任何运行发现，而真正被部署的正是那个提交。`Public Compose` 与 `M1 private preview` 现在也在 `main` 上运行；`Publish images` 仍限于 `v*` 标签或手动触发，因此 main 推送无法发布任何镜像。M0 的两个 workflow 去掉了 `push` 触发，因为它们监听的 `m0/issue-1` 分支已不存在——它们仍可手动触发，这样 M0 证据依旧可复现，又不会把原型作业塞进每次 main 运行。

下一项是 [#6 — 目标主机部署、HTTPS、备份/恢复与恢复演练](https://github.com/sagehou/dsh-workstation/issues/6)。它的四项依赖（#3、#8、#9、#10）均已完成，除了一台主机之外没有别的阻塞。Agent 浏览器控制在 #4 剩余矩阵实测前保持关闭，不可信站点浏览在 #11 完成前保持关闭。

首版界面使用独立浏览器页面。Sidebar #5 明确延期。
