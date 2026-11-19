# ADR-0003：自托管认证网关

[English](0003-self-hosted-auth-gateway.md) · 简体中文

状态：已接受。

## 背景

DSH 和 Selkies 应共享一个公网源和一次登录，无需外部身份平台。

## 决策

- 实现由 SQLite 提供存储的轻量 Go 认证服务。
- 用 Traefik ForwardAuth 保护 DSH 和 `/browser/`。
- 认证路由不经过自己的 ForwardAuth。
- 密码登录分两屏：先输入用户名和密码，再进入单独的 TOTP 界面。
- 账号必须绑定 TOTP，使用密码登录时必须输入 TOTP。
- Passkey 是独立的 WebAuthn 登录流程，并要求用户验证。
- 恢复码只能使用一次，以哈希方式存储。
- 会话使用不透明的随机令牌，仅保存令牌哈希。
- Cookie 为 `__Host-dsh_session`，带 Secure、HttpOnly、SameSite=Lax、Path=/，不设 Domain。
- 会话空闲超时、绝对时限和最大数量可以配置。

## 安全要求

- 严格验证 RP ID 和 HTTPS 源。
- WebAuthn 挑战只用一次，防止重复使用同一 TOTP 时间步。
- 密码哈希使用 Argon2id。
- 使用外置主密钥加密 TOTP 种子。
- 改变状态的请求必须做 CSRF 和源校验。
- 对登录、TOTP、Passkey 和恢复流程限流。
- 不记录凭据、OTP、断言、恢复码、会话令牌或密钥。
- API 和 WebSocket 请求不返回 HTML 登录页面。
- 不信任客户端自带的身份请求头。
