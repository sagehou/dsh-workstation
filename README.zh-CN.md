# DSH Workstation

[English](README.md) · 简体中文

基于官方 DeepSeek Harness（DSH）运行时的自托管 Web 工作台，通过 Docker Compose 部署。

## 项目状态

[公网 Compose 部署指南](deploy/public/README.zh-CN.md)说明怎样复用现有 Traefik，部署单用户 HTTPS、Go 认证网关和按 DSH 会话绑定标签页的浏览器 Provider。部署前请查阅[远端验证记录](docs/roadmap/public-compose.zh-CN.md)。也可以使用[私有预览](deploy/README.zh-CN.md)，仅监听服务器回环地址，通过 SSH 访问。

## 项目目标

- 运行官方 DSH npm 包，不 Fork 或修改 DSH 核心。
- 将 DSH npm 版本与基础 Docker 镜像解耦，支持安装、选择、升级和回滚固定版本。
- 容器重建后保留官方 DSH Profile、Bundle、Plugin Manager、pnpm 锁文件和包存储、凭据、会话及工作区数据。
- 共享一个 LinuxServer Chromium 实例，人工通过 Selkies 操作，Agent 通过 CDP/Playwright 自动化。
- 在与 DSH 同源的 `/browser/` 路径提供 Selkies。
- 通过服务端租约实现人工与 Agent 的独占控制，不能只靠界面状态。
- 提供轻量的自托管 Go 认证网关，支持密码与 TOTP、Passkey/WebAuthn、恢复码、可配置会话和 Traefik ForwardAuth。
- 用 Docker Compose 部署，将项目自建镜像发布到 GHCR。

## 首版不做

- Fork 或修改 DSH 核心。
- 替换 DSH Agent 运行时或主界面。
- 引入 VNC、noVNC 或 Xvfb 桌面栈。
- 为浏览器使用独立域名或独立登录。
- Windows Companion。
- DSH 多租户隔离。允许多个认证账号不代表各自拥有独立的 DSH 工作区或浏览器配置目录。

## 从这里开始

1. [AGENTS.md 中文版](AGENTS.zh-CN.md)：Codex 项目指引。
2. [产品规格](docs/SPEC.zh-CN.md)：需求与验收标准。
3. [架构](docs/ARCHITECTURE.zh-CN.md)：组件边界和部署拓扑。
4. 架构决策：[Runtime 版本解耦](docs/adr/0001-runtime-version-decoupling.zh-CN.md)、[共享 Chromium](docs/adr/0002-shared-selkies-chromium.zh-CN.md)、[自托管认证网关](docs/adr/0003-self-hosted-auth-gateway.zh-CN.md)。
5. [M0 证据](docs/roadmap/M0-evidence.zh-CN.md)与 [M1 范围](docs/roadmap/M1.zh-CN.md)。按住输入时的交接和原生侧栏仍在 [#1](https://github.com/sagehou/dsh-workstation/issues/1) 追踪。

## 工程约定

DSH、LinuxServer Chromium/Selkies、Traefik 和安全库都是有版本的外部依赖。使用 API、环境变量、路径或 CLI 参数前，须按固定版本核对上游源码。规划文档中未经验证的假设不能直接用于生产代码。

## 许可证

项目尚未选择许可证。在添加许可证之前，仓库所有者保留所有权利。
