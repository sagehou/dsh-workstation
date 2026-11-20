# ADR-0002 — 人工和 Agent 共享 Selkies Chromium

[English](0002-shared-selkies-chromium.md) · 简体中文

**已接受，仍需 M0 实证**

## 背景

人工操作和 Agent 浏览器自动化需要共享登录状态、标签页、Cookie 和浏览器配置。

## 决策

| 领域 | 选择 |
| --- | --- |
| 浏览器 | 一个带 Selkies 的 LinuxServer Chromium 容器和一份持久化配置。 |
| 人工访问 | 通过同源 `/browser/` 使用 Selkies。 |
| Agent 访问 | 用 CDP/Playwright 连接现有进程。CDP 不发布到宿主机和公网接口。 |
| 控制权 | 服务端独占租约。Agent 控制时在 Selkies 输入边界拦截人工输入。 |

## 后果和验收门槛

- 按固定版本验证 Playwright 的 CDP 限制、Selkies 子路径、iframe CSP、WebSocket 和 Traefik。
- 宣称独占模式前，必须验证 Agent 命令和实际人工输入都受控制。
- 如果可靠的输入拦截需要维护集成层，先停下来做架构决策。界面状态无法代替实际拦截。

[M0 结果](../roadmap/M0-evidence.zh-CN.md#b--同一个浏览器进程与配置目录) · [独占控制结果](../roadmap/M0-provider-evidence.zh-CN.md#实际结果)
