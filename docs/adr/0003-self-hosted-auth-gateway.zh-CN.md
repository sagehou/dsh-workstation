# ADR-0003 — 自托管认证网关

[English](0003-self-hosted-auth-gateway.md) · 简体中文

**已接受**

## 背景

DSH 和 Selkies 共用一个公网源和一次登录，无需外部身份平台。

## 决策

| 领域 | 选择 |
| --- | --- |
| 网关 | 独立 Go 服务使用 SQLite。Traefik ForwardAuth 保护 DSH 和 `/browser/`。认证路由不经过自己的 ForwardAuth。 |
| 密码 | 先显示用户名和密码，再单独显示 TOTP。账号要绑定 TOTP，密码登录要验证 TOTP。 |
| Passkey | 通过独立 WebAuthn 流程登录，要求用户验证。 |
| 恢复 | 以哈希保存一次性恢复码。 |
| 会话 | 发放不透明随机令牌，只存哈希。可设置空闲时限、绝对时限和最大会话数。 |
| Cookie | `__Host-dsh_session`，使用 Secure、HttpOnly、SameSite=Lax、Path=/，省略 Domain。 |

## 安全要求

- 严格验证 RP ID 和 HTTPS 源。WebAuthn 使用一次性挑战，拒绝重放相同时间步的 TOTP。
- 密码使用 Argon2id 哈希。用外置主密钥加密 TOTP 种子。
- 写请求要检查 CSRF 和来源。对登录、TOTP、Passkey 及恢复流程限流。
- 日志不记录凭据、OTP、断言、恢复码、会话令牌或密钥。
- 拒绝未认证 API 和 WebSocket 时不返回 HTML 登录页。丢弃客户端身份请求头。

[认证验证结果](../roadmap/public-compose.zh-CN.md)
