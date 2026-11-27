# ADR-0007 — 三个工作台服务

[English](0007-three-service-deployment.md) · 简体中文

完整 Compose 运行 Runtime、Gateway 和 Browser，并复用操作者已有的 Traefik。Go 控制台、Provider 和 Selkies 输入门禁作为独立进程运行在同一个 Gateway 容器。Provider 控制端口和输入门禁只绑定 Gateway 回环接口。工作台网络保留需要凭据的 `provider:8080`，让已经安装的 DSH Profile 继续使用原 MCP 地址。[Issue #36](https://github.com/sagehou/dsh-workstation/issues/36)

Browser 的 Chromium 和 Selkies 留在浏览器网络。LinuxServer 通过 `/custom-services.d` 启动 CDP 中继。中继使用 Chromium 的 `abc` 账户并写入 Unix socket，Gateway 只读挂载。Chromium 的 TCP 调试监听仍只在 Browser 回环，Browser 容器只加入浏览器网络。[LinuxServer 自定义服务](https://docs.linuxserver.io/general/container-customization/#custom-services) · [固定的 Chromium 源码](https://github.com/linuxserver/docker-chromium/tree/4ec00555069627093b9110daff841d363f9a95f8)

Gateway 与浏览器辅助进程共享一个容器信任边界。重启 Gateway 会关闭代理和 MCP 连接。浏览器配置、Gateway SQLite 数据及 Provider 的恢复标记沿用已有卷。生产 Compose 默认禁用 Agent 浏览器工具，完整 CI 在测试环境显式启用 MCP 以验证租约和实际输入门禁。[输入门禁设计](0005-release-held-input-at-selkies.zh-CN.md)
