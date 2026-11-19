# AGENTS.md — DSH Workstation

English · [简体中文](AGENTS.zh-CN.md)

## Mission

Build a self-hosted Docker Compose workstation around the **official DeepSeek Harness (DSH) npm package**. The repository owns the runtime image, runtime version manager, Go authentication gateway, Workstation plugin, deployment configuration, and tests.

## Non-negotiable constraints

1. **Never fork or patch DSH core.** Extend it through documented Profile, Bundle, Plugin Manager, Cordis patch, and client-plugin APIs. If a requirement cannot be met through supported extension points, document the gap and stop for an architecture decision.
2. **DSH npm version is runtime-managed, not baked into the runtime image.** The base image supplies a compatible Node.js runtime, pinned pnpm, Git/SSH, CA certificates, and a plugin-capable toolchain. A persistent runtime manager installs multiple exact DSH npm versions, selects one, and rolls back.
3. Preserve the official DSH plugin ecosystem. Do not replace the official Plugin Manager with a custom installer. Preserve Profile manifests, lockfiles, pnpm store, installed dependencies, Bundle configuration, credentials, sessions, and other DSH_HOME state.
4. The human browser and Agent browser must use **one Chromium process and one persistent browser profile**. Human interaction is via LinuxServer Chromium/Selkies; Agent automation attaches to that same instance over CDP.
5. Browser UI is served on the **same origin** as DSH at `/browser/`. No separate browser hostname, no second browser login, no VNC/noVNC. Use Traefik ForwardAuth for DSH and browser routes.
6. Browser control is **exclusive**. Enforce ownership on the server/tool execution path and at the Selkies input path. A front-end toggle alone is not an implementation. If input interception cannot be proven, report the limitation and do not claim exclusivity.
7. Auth is a separate Go service using SQLite. Support password + TOTP (TOTP is a separate second screen after password succeeds), Passkeys/WebAuthn, recovery codes, configurable idle/absolute session lifetime, session revocation, audit, and Traefik ForwardAuth.
8. Password + TOTP and Passkey are distinct login ceremonies. TOTP is mandatory to enroll for an account; password login requires it. Passkey may be a separate phishing-resistant login path. Do not silently require three simultaneous factors.
9. Single-user operation is the initial deployment target. Auth data model may support a few accounts, but do not claim multi-tenant DSH/workspace/browser isolation until each user receives isolated DSH state, workspace, and browser profile.
10. Docker Compose is the deployment target. Keep services independently versioned. Do not introduce Redis/PostgreSQL/Browserless/Authentik unless a demonstrated requirement justifies it.
11. Do not put secrets in images, source, logs, or committed Compose files. Do not expose CDP to host/public networks. Do not mount Docker socket into DSH or Auth.
12. Never invent upstream APIs, paths, CLI flags, environment variables, plugin IDs, or version compatibility. Verify against the exact upstream release/source and record evidence in docs.

## Development workflow

- Start with M0 only. Do not jump to full implementation before its validation gates pass.
- For each task: inspect upstream contracts, write a short design note, implement the smallest vertical slice, add automated tests, run tests, document results, and report limitations.
- Use exact pinned versions and image digests in release/deployment configurations. Floating tags may be used only in explicitly marked experiments.
- Keep Runtime image version separate from DSH npm version.
- Runtime upgrades must be transactional: install to an isolated version directory, validate, switch atomically, health-check, and roll back on failure. Never mutate the active install in place.
- Back up DSH_HOME before operations that can migrate state or alter Profile dependencies. A code-version rollback is not assumed to reverse data migrations.
- pnpm install scripts/native build scripts require explicit review/approval. Never broadly allow all dependency build scripts by default.
- Tests must cover container recreation and persistent state, not just process startup.
- Keep security-sensitive operations auditable and require step-up authentication for credential/MFA changes.

## Code quality

- Prefer small modules with explicit interfaces.
- Go: context-aware handlers, structured logs, migrations, race tests for session/lease logic, constant-time comparisons where applicable, secure random tokens, parameterized SQL.
- TypeScript: follow the exact DSH client plugin API for the pinned DSH version; avoid private/internal imports unless documented and explicitly justified.
- Docker: non-root where compatible, least privilege, no privileged mode, no Docker socket, health checks, read-only root FS where practical.
- Never log passwords, TOTP codes/seeds, WebAuthn assertions, recovery codes, session tokens, or encryption keys.
- Keep README and examples honest: mark unverified PoC settings and do not label them production-ready.

## Required completion report

For every milestone, report:
1. Changes made.
2. Exact versions tested.
3. Commands/tests run and results.
4. Acceptance criteria passed/failed.
5. Remaining risks and next blocking decision.
6. Links to commits/PRs/issues when available.
