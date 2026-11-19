# ADR-0002：人工和 Agent 共享 Selkies Chromium

[English](0002-shared-selkies-chromium.md) · 简体中文

状态：已接受，仍需 M0 实证。

## 背景

工作台需要支持完整的人工浏览和 Agent 自动化，两者必须共享登录状态、标签页、Cookie 和浏览器配置目录。

## 决策

- 运行一个带 Selkies 的 LinuxServer Chromium 容器，使用同一份持久化浏览器配置目录。
- 人工通过同源的 `/browser/` 使用 Selkies。
- Agent 通过 CDP/Playwright 连接现有 Chromium 进程。
- 不为 Agent 启动第二个浏览器。
- 不把 CDP 暴露到宿主机或公网接口。
- 通过服务端独占租约控制浏览器。
- Agent 持有控制权时，必须在 Selkies 输入边界拦截人工输入。

## 后果和验收门槛

- 必须针对固定 Chromium 版本测试 Playwright 的 CDP 限制。
- 必须验证 Selkies 子路径、iframe CSP、WebSocket 和 Traefik 的行为。
- Agent 命令和 Selkies 人工输入都实际受控时，才能认为实现了独占模式。
- 如果不维护集成层就无法可靠拦截 Selkies 输入，停下来请用户做架构决策。不要用界面状态模拟独占。
