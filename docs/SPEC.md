# Product Specification — DSH Web Workstation

Status: Approved product direction; technical assumptions remain subject to M0 verification.

## 1. Product

A self-hosted web workstation that retains the official DSH application and plugin ecosystem while adding a remotely accessible shared browser, a secure authentication gateway, and operational management.

## 2. Users and scope

- Initial use: one trusted user.
- Auth model: allow a small number of accounts (2–5) in the data model.
- Multi-user isolation is not in v1. Multiple authenticated users must not be represented as isolated tenants unless DSH_HOME, workspace, and browser profile are independently isolated.
- Clients: desktop browsers first; mobile browser basic usability.
- Deployment: Docker Compose, one public origin.

## 3. Product requirements

### 3.1 DSH runtime and version management

- Base Docker image contains compatible Node.js, pinned pnpm, Git/SSH, CA certificates, and a toolchain for common native Node dependencies.
- DSH is installed from the official npm package at runtime into a persistent data volume.
- User can query available npm versions, install an exact version, retain multiple versions, select a version, update, verify, and roll back.
- Version switching is transactional and never overwrites an installed version.
- Runtime image version and DSH npm version are independent.
- A failed install or health check must leave the prior version active.
- Before switching, validate DSH/Node compatibility and installed plugin compatibility where metadata is available.
- Do not automatically mutate Profile dependencies on DSH version switch.
- Back up DSH_HOME before migrations or dependency operations.

### 3.2 Plugin ecosystem and persistence

- Preserve official DSH Profile and Plugin Manager behavior.
- Support npm packages, pinned versions, Git HTTPS, Git pinned commit, local package paths where supported by upstream, ESM/CommonJS, and common native-module builds.
- Persist DSH_HOME as a coherent filesystem, including Profile package manifests, lockfiles, node_modules links/content, pnpm store, Bundle manifests, settings, credentials, sessions, and plugin configuration.
- Keep workspace separate from DSH_HOME.
- Installation, activation, compatibility, and runtime health are distinct states in UI.
- Review pnpm build scripts and native dependencies; never globally approve arbitrary install scripts.
- Special system dependencies (e.g. ffmpeg, libvips) may require optional services or documented host/runtime extensions; do not promise every third-party plugin works without its system prerequisites.

### 3.3 Shared Chromium/Selkies browser

- Use LinuxServer Chromium image; do not embed Chromium or a desktop stack in DSH runtime.
- One Chromium process and one persistent profile are shared by human and Agent.
- Human UI is Selkies served under the same origin at `/browser/`.
- Agent uses the official DSH Browser Use/Playwright MCP extension where supported, attaching via CDP to the same Chromium instance.
- No separate browser hostname or browser-specific login.
- CDP must not be published to host/public interfaces. Restrict it to a private Docker network/service boundary.
- Browser profile and downloads persist.
- Browser restart/reconnect must be visible and recoverable.
- Exclusive control: HUMAN, AGENT, HANDOVER, PAUSED, DISCONNECTED states. Server-side lease validation is mandatory. Human input must be blocked while Agent owns control, and Agent tool calls must be blocked while Human owns control.
- Takeover must stop admission of new Agent actions, safely finish/cancel the in-flight action, revoke lease, then enable human input.
- If Selkies cannot reliably gate human input, this requirement is not met; do not simulate it with a UI-only lock.

### 3.4 Workstation UI plugin

- Use supported DSH client plugin and right-sidebar APIs for the exact pinned DSH version.
- Add Browser Desktop as a right-sidebar tab.
- Support dock, float, resize, maximize/restore, hide, reconnect, and status display, using DSH-native pane lifecycle APIs.
- Keep iframe mounted when switching tabs/hiding if supported; hiding must not terminate Chromium.
- Browser frame uses relative same-origin `/browser/` URL.
- Add explicit Human/Agent control state, current owner, task status, and takeover action.
- Avoid reimplementing the DSH main chat, session, file, diff, or terminal interfaces.

### 3.5 Authentication gateway

- Independent Go service; SQLite WAL.
- Password hashing: Argon2id.
- TOTP: RFC 6238; enrollment mandatory for accounts; password login requires a separate TOTP step.
- TOTP UX: first screen contains username/password only. After password verification, replace it with a distinct second screen/modal containing only TOTP input. Never show password and TOTP fields together.
- Passkeys: WebAuthn with exact configured RP ID and HTTPS origin, required user verification, one-time challenges, multiple credentials per user.
- Passkey may be a separate login ceremony; it is not silently treated as Password+TOTP. Sensitive account changes require step-up authentication.
- Recovery codes: one-time, hashed at rest, shown only once; regeneration invalidates old codes.
- Sessions: opaque cryptographically random tokens, only token hashes stored; configurable idle timeout, absolute lifetime, max sessions, per-session revoke, revoke-all.
- Cookie: `__Host-dsh_session`, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain attribute.
- Auth endpoints and ForwardAuth verification endpoint must not be protected by their own ForwardAuth middleware.
- ForwardAuth protects DSH and `/browser/`; API and WebSocket unauthenticated behavior must be correct (401/deny upgrade, not an HTML login page).
- Audit events for login success/failure, MFA changes, credential changes, session changes, account disable/recovery.
- Rate limiting, CSRF protection, origin checks, anti-enumeration behavior, secure secret management.
- Bootstrap is one-time and disabled after initial admin creation.

### 3.6 Routing and deployment

- One origin: `https://<host>/`.
- DSH at `/`.
- Selkies at `/browser/`, using LinuxServer-supported subfolder configuration and preserving path prefix through Traefik (no StripPrefix unless upstream documentation explicitly requires otherwise).
- Auth UI/API at `/_auth/`.
- Browser control APIs are internal-only or authenticated and never exposed as an unauthenticated public management surface.
- Traefik ForwardAuth protects DSH and browser routes using the same session cookie.
- Docker Compose orchestrates DSH, Auth, Chromium; Traefik may be an existing external service on the shared network.
- No Authentik, Browserless, Redis, PostgreSQL, VNC/noVNC, or separate browser domain in the initial design.

### 3.7 Operations

- Independent versions for runtime image, DSH npm package, Auth image, Workstation plugin, and Chromium image.
- Pin release tags/digests in production.
- Backup/restore for DSH_HOME, workspace, Chromium profile, Auth DB, and encryption secrets.
- Restore test must prove TOTP and Passkey registration remains usable.
- Health checks must test actual readiness, not only process existence.
- Upgrade/rollback documented and tested.

## 4. UX requirements

### Login
1. Password screen: username and password only.
2. On valid password, server creates short-lived pre-auth challenge and navigates to a separate TOTP screen.
3. TOTP screen: code only, back/restart and recovery-code option.
4. Successful TOTP creates full session and redirects only to a validated same-origin relative return path.
5. Passkey is a separate visible login option.

### Browser
- Right-side Browser Desktop tab.
- Native DSH floating/docking lifecycle.
- Full Selkies UI.
- Human/Agent state and ownership visible.
- Clear takeover/return controls.
- Reconnect and disconnected states.

### Runtime
- Current version, installed versions, available versions.
- Install exact version, activate, rollback, remove inactive version.
- Compatibility report, logs, backup status, health status.

### Plugins
- Installed, Marketplace/source, Updates.
- Show source/version/DSH compatibility/dependencies/build-script approval.
- Install/enable/disable/update/remove via official DSH Plugin Manager.
- Show operation logs and distinguish installed vs activated vs healthy.

### Security
- Password change, passkey management, TOTP management, recovery code regeneration, session list/revocation, audit log.
- Sensitive changes require step-up authentication.

## 5. Out of scope

Windows Companion, multi-tenant orchestration, Kubernetes deployment, custom agent runtime, custom editor, public plugin marketplace hosting, and multiple concurrent browser instances.

## 6. Definition of Done

A feature is done only when implementation, automated tests, documented configuration, security implications, and recovery behavior are included. A running container alone is not acceptance.
