# ADR-0007 — Three Workstation services

English · [简体中文](0007-three-service-deployment.zh-CN.md)

Full Compose runs Runtime, Gateway and Browser and reuses the operator's Traefik. Gateway keeps the Go console, Provider and Selkies input gate as separate processes in one container. Provider control and the input gate listen on Gateway loopback. The credential-protected MCP listener retains `provider:8080` on the workstation network for existing DSH Profiles. [Issue #36](https://github.com/sagehou/dsh-workstation/issues/36)

Browser keeps Chromium and Selkies on the browser network. LinuxServer starts the CDP relay through `/custom-services.d`. The relay runs as Chromium's `abc` account and writes a Unix socket that Gateway mounts read-only. This keeps Chromium's TCP debug listener on its own loopback and leaves the workstation and proxy networks outside the Browser container. [LinuxServer custom services](https://docs.linuxserver.io/general/container-customization/#custom-services) · [Pinned Chromium source](https://github.com/linuxserver/docker-chromium/tree/4ec00555069627093b9110daff841d363f9a95f8)

Gateway and its browser helpers share a container trust boundary. Restarting Gateway closes its proxy and MCP connections. The Browser profile, Gateway SQLite data and Provider fence stay on their existing volumes. Production Compose starts with Agent browser tools disabled. The full CI fixture exercises the existing lease and input checks with an explicitly enabled MCP listener. [Input gate design](0005-release-held-input-at-selkies.md)
