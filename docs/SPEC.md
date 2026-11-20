# Product Specification — DSH Web Workstation

English · [简体中文](SPEC.zh-CN.md)

The approved direction is a self-hosted Web workstation around official DSH and its plugin ecosystem. Technical assumptions go through M0. [Acceptance criteria](roadmap/M0.md) · [Observed results](roadmap/M0-evidence.md)

## Users and scope

| Area | Requirement |
| --- | --- |
| User | One trusted operator initially. The Auth data model can allow 2–5 accounts. |
| Isolation | Separate DSH_HOME, workspace, and browser profile per tenant are prerequisites for multi-user isolation. |
| Clients | Desktop browsers first, with basic mobile browser usability. |
| Deployment | Docker Compose and one public HTTPS origin. |

## DSH Runtime and plugins

| Area | Requirement |
| --- | --- |
| Base image | Compatible Node.js, pinned pnpm, Git/SSH, CA certificates, and a toolchain for common native Node dependencies. |
| Install | Install official DSH npm packages at runtime into persistent storage. Retain multiple exact versions and allow listing, installation, selection, upgrade, validation, rollback, and removal of inactive versions. |
| Switch | Check Node and DSH compatibility and available plugin metadata. Validate before atomic selection. An install or health failure preserves the previous version. Keep installed releases intact and leave Profile dependencies unchanged during switching. |
| Versions | Version the Runtime image and DSH npm independently. |
| Plugin Manager | Retain the official Profile and Plugin Manager. Support npm, pinned versions, Git HTTPS with pinned commits, supported local paths, ESM/CommonJS, and common native modules. |
| Data | Keep manifests, lockfiles, node_modules links and content, pnpm store, Bundle manifests, settings, credentials, sessions, and plugin configuration in one DSH_HOME filesystem. Keep workspace separate. |
| Dependency scripts | Review pnpm and native build scripts individually. Document additional system prerequisites such as ffmpeg or libvips. Use optional services or documented extensions when required. |

## Browser

| Area | Requirement |
| --- | --- |
| Chromium | Run one LinuxServer Chromium separately from Runtime. The Agent and operator share its process, persistent profile, and downloads. |
| Access | Serve Selkies at same-origin `/browser/` using the DSH login. Keep CDP inside a private Docker service boundary. |
| Automation | Use official DSH Browser Use/Playwright MCP where supported, attached to the same Chromium over CDP. |
| Control | Track HUMAN, AGENT, HANDOVER, PAUSED, and DISCONNECTED. Enforce server-side leases. Block human input at Selkies while the Agent owns control and reject Agent calls during human control. |
| Takeover | Stop new Agent actions, finish or cancel the active action safely, revoke the lease, then enable human input. The actual input boundary must pass validation. |
| Recovery | Display disconnect and reconnect states and provide recovery after a browser restart. |

### Workstation plugin

- Register a Browser Desktop tab with supported right Sidebar APIs for the exact DSH release. Embed the relative URL `/browser/`.
- Use native pane lifecycle APIs for docking, floating, resizing, maximizing and restoring, hiding, reconnect, and status.
- Keep the iframe mounted across tab switches or hides when supported. Hiding leaves Chromium running.
- Display human or Agent control, owner, task status, and takeover and return actions. Keep the official DSH chat, session, file, diff, and terminal interfaces.

## Authentication

| Area | Requirement |
| --- | --- |
| Service | Independent Go service with SQLite WAL. Bootstrap closes after the first admin is created. |
| Password and TOTP | Hash passwords with Argon2id. Require RFC 6238 TOTP enrollment and a separate TOTP screen after password succeeds. |
| Passkey | Separate WebAuthn login with configured RP ID, exact HTTPS origin, required user verification, one-time challenges, and multiple credentials per user. |
| Recovery codes | Show once and store hashes. Each code is single use, and regeneration invalidates old codes. |
| Sessions | Generate cryptographically random opaque tokens and store only hashes. Configure idle and absolute limits and concurrent count. Revoke one session or all sessions. |
| Cookie | `__Host-dsh_session` with Secure, HttpOnly, SameSite=Lax, and Path=/. Omit Domain. |
| Protection | Rate limiting, CSRF and origin checks, protection against account enumeration, and secure secret management. Require step-up for sensitive account changes. |
| Audit | Record successful and failed logins, MFA and credential changes, session changes, and account disable or recovery. |

### Login screens

1. Show only username and password on the first screen.
2. On success, create a short-lived pre-auth challenge and open a separate screen or modal.
3. Show only TOTP entry, back or restart, and a recovery-code option.
4. Create a full session on a valid code and redirect to a validated same-origin relative path.
5. Offer Passkey as a separate visible login option.

## Routing and deployment

| Path or boundary | Requirement |
| --- | --- |
| `https://<host>/` | DSH and one shared session cookie. |
| `/browser/` | Selkies with LinuxServer's supported subfolder configuration. Preserve the prefix unless upstream explicitly requires stripping it. |
| `/_auth/` | Auth UI and API. Auth and the verification endpoint are exempt from their own ForwardAuth. |
| ForwardAuth | Protect DSH and Selkies. Unauthenticated APIs return 401 and WebSocket upgrades are denied. |
| Browser control | Internal or authenticated endpoints. Keep management off unauthenticated public routes. |
| Compose | Orchestrate DSH, Auth, and Chromium. Reuse an external Traefik on shared networks where applicable. |

## User interface and operations

| Area | Requirement |
| --- | --- |
| Browser | Render the full Selkies UI in the native DSH Browser Desktop tab. Show ownership, takeover and return, and reconnect status. |
| Runtime | Show active, installed, and available versions, compatibility, logs, backup status, and health. |
| Plugins | Show installed, marketplace or source, and updates. List source, version, compatibility, dependencies, and script approval. Use official Plugin Manager to install, enable, disable, update, and remove. Show logs and distinguish installation, activation, compatibility, and health. |
| Account | Manage password, Passkeys, TOTP, recovery codes, sessions, and audit. Require step-up for sensitive changes. |
| Releases | Version the Runtime image, DSH npm, Auth image, Workstation plugin, and Chromium independently. Pin release tags and digests. |
| Backups | Back up DSH_HOME before migrations or dependency operations. Cover DSH_HOME, workspace, Chromium profile, Auth DB, and encryption secrets. Restore tests must prove TOTP and existing Passkeys still work. |
| Health and recovery | Check actual readiness. Document and test upgrades and rollback. |

## Out of scope

Windows Companion, tenant orchestration, Kubernetes, a custom Agent runtime or editor, hosting a public plugin marketplace, and multiple simultaneous browsers. The initial deployment excludes Authentik, Browserless, Redis, PostgreSQL, VNC/noVNC, and a separate browser domain or login.

## Definition of Done

A feature includes implementation, automated tests, configuration docs, security implications, and coverage of recovery behavior.
