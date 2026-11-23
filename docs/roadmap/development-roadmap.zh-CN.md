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

[#8 — DSH/Profile 升级事务与数据恢复](https://github.com/sagehou/dsh-workstation/issues/8) 已完成：`dsh-runtime upgrade` 是一个事务，含兼容门禁、匹配备份，以及互相独立的指针回滚与数据恢复路径，已在[运行 45124380864](https://github.com/sagehou/dsh-workstation/actions/runs/45124380864) 中验证。两项限制继续保留：尚无可确知会迁移 Profile 数据的 DSH 版本，检测仅由合成改动证明；随镜像发布的浏览器 Bundle 固定 `engines.dsh 0.2.2-rc.1`，因此 DSH 与 Bundle 必须同步升级。下一项是 [#9 — 可配置 Docker 子网与重叠预检](https://github.com/sagehou/dsh-workstation/issues/9)。

首版界面使用独立浏览器页面。Sidebar #5 明确延期。
