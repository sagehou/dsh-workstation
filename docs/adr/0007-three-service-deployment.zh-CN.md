# ADR-0007 — 三个工作台服务

[English](0007-three-service-deployment.md) · 简体中文

完整 Compose 运行 Runtime、Gateway 和 Browser，并复用操作者已有的 Traefik。Go 控制台、Provider 和 Selkies 输入门禁作为独立进程运行在同一个 Gateway 容器。Provider 控制端口和输入门禁只绑定 Gateway 回环接口。工作台网络保留需要凭据的 `provider:8080`，让已经安装的 DSH Profile 继续使用原 MCP 地址。[Issue #36](https://github.com/sagehou/dsh-workstation/issues/36)

单个操作者共用 DSH 与 Chromium 状态，因此 Runtime、Gateway 和 Browser 共用 `workstation`。Traefik 在这张网访问 DSH 和 Selkies HTTP，通过现有代理网连接 Gateway。`workstation` 上可以访问 Selkies 的静态资源。Browser 的自定义初始化脚本在 Nginx 的两个监听端口上将 Selkies 数据 WebSocket 和令牌管理限制为来自 Gateway 工作台地址的请求。Selkies 本身只监听 Browser 回环。[Issue #37](https://github.com/sagehou/dsh-workstation/issues/37) · [LinuxServer 自定义脚本](https://docs.linuxserver.io/general/container-customization/#custom-scripts) · [固定的 Nginx 模板](https://github.com/linuxserver/docker-baseimage-selkies/blob/6379480bcbd4ba42c1f5d4ab5eca49304fdedf83/root/defaults/default.conf) · [固定的 Selkies 启动脚本](https://github.com/linuxserver/docker-baseimage-selkies/blob/6379480bcbd4ba42c1f5d4ab5eca49304fdedf83/root/etc/s6-overlay/s6-rc.d/svc-selkies/run)

LinuxServer 通过 `/custom-services.d` 启动 CDP 中继。中继使用 Chromium 的 `abc` 账户并写入 Unix socket，Gateway 只读挂载。Chromium 的 TCP 调试端口只监听 Browser 回环。[LinuxServer 自定义服务](https://docs.linuxserver.io/general/container-customization/#custom-services) · [固定的 Chromium 源码](https://github.com/linuxserver/docker-chromium/tree/4ec00555069627093b9110daff841d363f9a95f8)

Gateway 与浏览器辅助进程共享一个容器信任边界。重启 Gateway 会关闭代理和 MCP 连接。浏览器配置、Gateway SQLite 数据及 Provider 的恢复标记沿用已有卷。生产 Compose 默认禁用 Agent 浏览器工具，完整 CI 在测试环境显式启用 MCP 以验证租约和实际输入门禁。[输入门禁设计](0005-release-held-input-at-selkies.zh-CN.md)
