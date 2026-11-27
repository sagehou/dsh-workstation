# DSH Workstation

[English](README.md) · 简体中文

围绕官方 DeepSeek Harness（DSH）应用构建的自托管部署、安全、浏览器控制和运维增强层。

## 部署

当前 Compose 精简版常驻 **Runtime + Gateway**，完整版常驻 **Runtime + Gateway + Browser**。各服务共用一张 `workstation` 网络，两种形态都复用现有 Traefik。SSH 私有预览共 **3 个**，含自带的 Traefik。

| 需求 | 指南 |
| --- | --- |
| 用现有 Traefik 和域名部署 | [公网 Compose](deploy/public/README.zh-CN.md) |
| 发布与核对镜像 | [发布镜像](docs/release.zh-CN.md) |
| 通过 SSH 试用 DSH Web 和浏览器 | [私有预览](deploy/README.zh-CN.md) |

## 当前状态

| 功能 | 当前行为 |
| --- | --- |
| 产品范围 | 首版严格只有一个本地管理员、一份 DSH_HOME、一个工作区和一份 Chromium 配置。管理员可注册多个 Passkey。 |
| Runtime | 将指定 DSH 版本安装到持久化存储。版本切换独立于 Runtime 镜像；数据迁移必须有匹配备份。 |
| 插件和数据 | 使用官方 Profile、Bundle 和 Plugin Manager。容器重建后保留状态、pnpm Store 与锁文件、凭据、会话和独立工作区。 |
| 公网访问 | 一位使用者通过 HTTPS 登录，可用密码加 TOTP 或 Passkey。Go Gateway 提供会话管理和 Traefik ForwardAuth。`/mgmt` 统一提供账户、浏览器控制和 Runtime 运维入口。 |
| 浏览器 | 人工与 Agent 共享 Chromium。Selkies 位于 `/browser/`；首版正式入口是已认证的独立浏览器/控制页面。 |
| 延后 | DSH 原生 Sidebar 延后到首版上线后。[#5](https://github.com/sagehou/dsh-workstation/issues/5) 真实栈已验证交接和断线时释放鼠标按键。键盘、租约过期、重启和 Provider 异常退出仍待真实栈验收。[#4](https://github.com/sagehou/dsh-workstation/issues/4) |
| 镜像 | 已发布的 Auth 完整部署有六个工作台容器。Gateway 的三服务候选版目前从源码构建。[发布状态](docs/release.zh-CN.md#当前部署版本) · [部署验证](docs/roadmap/public-compose.zh-CN.md) |

## 项目文档

| 想了解 | 文档 |
| --- | --- |
| 产品需求与验收 | [规格](docs/SPEC.zh-CN.md) |
| 服务、网络和数据 | [架构](docs/ARCHITECTURE.zh-CN.md) |
| 架构决策 | [Runtime 版本](docs/adr/0001-runtime-version-decoupling.zh-CN.md) · [共享 Chromium](docs/adr/0002-shared-selkies-chromium.zh-CN.md) · [认证网关](docs/adr/0003-self-hosted-auth-gateway.zh-CN.md) · [首版单用户与 Sidebar 延后](docs/adr/0004-single-user-release-and-deferred-sidebar.zh-CN.md) |
| 开发和移交 | [开发路线图](docs/roadmap/development-roadmap.zh-CN.md) |
| 复现验证 | [M0 验收](docs/roadmap/M0.zh-CN.md) · [M0 结果](docs/roadmap/M0-evidence.zh-CN.md) · [M1 预览](docs/roadmap/M1.zh-CN.md) · [公网 Compose](docs/roadmap/public-compose.zh-CN.md) |
| 参与开发 | [项目指引](AGENTS.zh-CN.md) |

首版不包含多用户租户、修改 DSH 核心、自研 Agent Runtime/编辑器、公共插件市场、Kubernetes、Windows Companion、多个并行浏览器和强制原生 Sidebar。

## 许可证

添加许可证前，由仓库所有者保留所有权利。
