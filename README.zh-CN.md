# DSH Workstation

[English](README.md) · 简体中文

基于官方 DeepSeek Harness（DSH）npm 包的自托管工作台。

## 部署

| 需求 | 指南 |
| --- | --- |
| 用现有 Traefik 和域名部署 | [公网 Compose](deploy/public/README.zh-CN.md) |
| 通过 SSH 试用 DSH Web 和浏览器 | [私有预览](deploy/README.zh-CN.md) |

## 当前状态

| 功能 | 当前行为 |
| --- | --- |
| Runtime | 将指定 DSH 版本安装到持久化存储。版本切换和回滚独立于 Runtime 镜像。 |
| 插件和数据 | 使用官方 Profile、Bundle 和 Plugin Manager。容器重建后保留这些状态、pnpm Store 与锁文件、凭据、会话和独立工作区。 |
| 公网访问 | 一位使用者通过 HTTPS 登录，可用密码加 TOTP 或 Passkey。Go 网关提供恢复码、会话管理和 Traefik ForwardAuth。 |
| 浏览器 | 人工与 Agent 共享 Chromium。Selkies 位于 `/browser/`，每个在线 DSH 会话通过官方 MCP 绑定自己的标签页。 |
| 待补 | 完整独占交接，包括释放已按住的输入，以及原生侧栏。[#1](https://github.com/sagehou/dsh-workstation/issues/1) |
| 镜像 | GitHub Actions 构建 Compose 镜像。发布自建镜像到 GHCR 是项目目标。[部署验证](docs/roadmap/public-compose.zh-CN.md) |

## 项目文档

| 想了解 | 文档 |
| --- | --- |
| 产品需求与验收 | [规格](docs/SPEC.zh-CN.md) |
| 服务、网络和数据 | [架构](docs/ARCHITECTURE.zh-CN.md) |
| 架构决策 | [Runtime 版本](docs/adr/0001-runtime-version-decoupling.zh-CN.md) · [共享 Chromium](docs/adr/0002-shared-selkies-chromium.zh-CN.md) · [认证网关](docs/adr/0003-self-hosted-auth-gateway.zh-CN.md) |
| 复现验证 | [M0 验收](docs/roadmap/M0.zh-CN.md) · [M0 结果](docs/roadmap/M0-evidence.zh-CN.md) · [M1 预览](docs/roadmap/M1.zh-CN.md) · [公网 Compose](docs/roadmap/public-compose.zh-CN.md) |
| 参与开发 | [项目指引](AGENTS.zh-CN.md) |

首版范围不含 DSH 核心或主界面改造、VNC/noVNC/Xvfb 桌面栈、独立浏览器域名或登录、Windows Companion，以及租户隔离。

## 许可证

添加许可证前，由仓库所有者保留所有权利。
