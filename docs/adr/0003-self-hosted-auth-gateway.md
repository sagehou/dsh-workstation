# ADR-0003 — Self-hosted Auth gateway

English · [简体中文](0003-self-hosted-auth-gateway.zh-CN.md)

**Accepted**

## Context

DSH and Selkies share one public origin and login without an external identity platform.

## Decision

| Area | Choice |
| --- | --- |
| Gateway | Independent Go service with SQLite. Traefik ForwardAuth protects DSH and `/browser/`. Auth routes are outside their own ForwardAuth. |
| Password | Show username and password, then TOTP on a separate screen. Require TOTP enrollment and verification for password login. |
| Passkey | Separate WebAuthn login with required user verification. |
| Recovery | Store hashed, single-use recovery codes. |
| Sessions | Issue opaque random tokens and store only their hashes. Configure idle timeout, absolute lifetime, and maximum session count. |
| Cookie | `__Host-dsh_session` with Secure, HttpOnly, SameSite=Lax, and Path=/. Omit Domain. |

## Security requirements

- Verify exact RP ID and HTTPS origin. Use one-time WebAuthn challenges and reject TOTP time-step replay.
- Use Argon2id password hashes. Encrypt TOTP seeds with an external master key.
- Check CSRF and origin on writes. Rate-limit login, TOTP, Passkey, and recovery.
- Keep credentials, OTPs, assertions, recovery codes, session tokens, and secrets out of logs.
- Reject unauthenticated API and WebSocket traffic without returning HTML sign-in. Discard client-supplied identity headers.

[Auth verification](../roadmap/public-compose.md)
