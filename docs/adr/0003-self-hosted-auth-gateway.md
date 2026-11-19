# ADR-0003: Self-hosted Auth Gateway

Status: Accepted

## Context

DSH and Selkies should share one public origin and one login without an external identity platform.

## Decision

- Implement a small Go authentication service with SQLite.
- Traefik ForwardAuth protects DSH and `/browser/`.
- Auth routes are exempt from their own ForwardAuth.
- Password login is a two-screen flow: username/password first, then a separate TOTP screen.
- Accounts must enroll TOTP. Password login requires TOTP.
- Passkey is a separate WebAuthn login ceremony with required user verification.
- Recovery codes are one-time and stored hashed.
- Sessions use opaque random tokens; only token hashes are stored.
- Cookie is `__Host-dsh_session`, Secure, HttpOnly, SameSite=Lax, Path=/, with no Domain.
- Session idle timeout, absolute lifetime, and maximum session count are configurable.

## Security requirements

- Strict RP ID and HTTPS Origin validation.
- One-time WebAuthn challenges and TOTP time-step replay prevention.
- Argon2id password hashing.
- Encrypt TOTP seeds with an external master key.
- CSRF and Origin checks for state-changing requests.
- Rate-limit login, TOTP, Passkey, and recovery flows.
- Never log credentials, OTPs, assertions, recovery codes, session tokens, or secrets.
- Do not return HTML signin pages to API or WebSocket requests.
- Do not trust client-supplied identity headers.
