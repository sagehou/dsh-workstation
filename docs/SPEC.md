# Product Specification — DSH Web Workstation

English · [简体中文](SPEC.zh-CN.md)

The approved direction is a self-hosted workstation around the official DSH application and plugin ecosystem. The product is a deployment, security, browser-control, and operations layer around DSH—not a replacement Agent runtime, chat application, editor, or plugin marketplace. Technical assumptions go through M0. [Acceptance criteria](roadmap/M0.md) · [Observed results](roadmap/M0-evidence.md) · [Approved product baseline](adr/0004-single-user-release-and-deferred-sidebar.md)

## Users and release scope

| Area | Requirement |
| --- | --- |
| User model | Exactly one local administrator account in the first release. No user creation, invitations, multi-account administration, or tenant orchestration. Multiple Passkeys may belong to that one account. |
| Isolation | The first release is single-user, not multi-tenant. Do not expose additional accounts that share DSH_HOME, workspace, or Chromium profile. Any future multi-user release requires separate DSH_HOME, workspace, browser profile, sessions, and secrets per tenant. |
| Clients | Desktop browsers first, with basic mobile browser usability. |
| Deployment | Docker Compose and one public HTTPS origin, reusing an existing Traefik where possible. Initial support is Linux amd64 only. |

## DSH Runtime and plugins

| Area | Requirement |
| --- | --- |
| Base image | Compatible Node.js, pinned pnpm, Git/SSH, CA certificates, and a toolchain for common native Node dependencies. |
| Install | Install official DSH npm packages at runtime into persistent storage. Retain multiple exact versions and allow listing, installation, selection, upgrade, validation, rollback, and removal of inactive versions. |
| Switch | Check Node and DSH compatibility and available plugin metadata. Validate before atomic selection. An install or health failure preserves the previous version. Keep installed releases intact and leave Profile dependencies unchanged during switching. |
| Versions | Version the Runtime image and DSH npm independently. |
| Plugin Manager | Retain the official Profile and Plugin Manager. Support npm, pinned versions, Git HTTPS with pinned commits, supported local paths, ESM/CommonJS, and common native modules. Do not build a competing package manager or public marketplace. |
| Data | Keep manifests, lockfiles, node_modules links and content, pnpm store, Bundle manifests, settings, credentials, sessions, and plugin configuration in one DSH_HOME filesystem. Keep workspace separate. |
| Dependency scripts | Review pnpm and native build scripts individually. Document additional system prerequisites such as ffmpeg or libvips. Use optional services or documented extensions when required. |

### Upgrade transaction

- Back up DSH_HOME and record the current Runtime/DSH/Profile/plugin versions before a change that can modify persistent state.
- Install the candidate DSH version beside the active version. Do not mutate the active installation.
- Check Node compatibility, DSH startup/readiness, Profile and Bundle compatibility, locked dependencies, and approved build scripts.
- Treat pointer rollback and data rollback as separate operations. If a migration changes persistent state, rollback must restore the matching backup; switching the active symlink alone is not a data rollback.
- Keep a recovery path that can restore the previous Runtime image, DSH selection, Profile state, and backup as a matched set.

## Browser

| Area | Requirement |
| --- | --- |
| Chromium | Run one LinuxServer Chromium separately from Runtime. The operator and Agent share its process, persistent profile, and downloads. |
| Access | Serve Selkies at same-origin `/browser/` using the same login as DSH. Keep CDP inside a private Docker service boundary. |
| Automation | Use the official DSH Browser Use/Playwright MCP where supported, attached to the same Chromium over CDP. The Workstation Provider exposes only explicitly approved tools. |
| Control | Track HUMAN, AGENT, HANDOVER, PAUSED, and DISCONNECTED. Enforce server-side leases. Block human input at the Selkies input boundary while the Agent owns control and reject Agent calls during human control. |
| Takeover | Stop new Agent actions, safely finish or cancel the active action, revoke the lease, release any held human input, confirm release, then enable the next owner. The actual input boundary must pass validation. |
| Recovery | Display disconnect and reconnect states and provide recovery after a browser restart. Fail closed when operation completion or input state is uncertain. |

### Browser tool and network security

- Every browser tool call must pass the same server-side lease, session, generation, and in-flight-operation checks. Adding a tool must not create a bypass path to CDP.
- `BROWSER_TOOL_ORIGINS` is an application-level origin allowlist for Provider operations. It is not a network egress firewall, DNS/IP policy, or complete SSRF defense.
- Chromium executes page JavaScript and follows redirects. Do not describe the origin allowlist as isolating Chromium from private networks or protecting the host.
- Before enabling browsing of untrusted sites or broad Agent navigation, add and test a separate browser egress policy that blocks loopback, link-local, private, metadata, and other prohibited destinations after DNS resolution and across redirects. Keep the policy outside the DSH tool prompt.
- Keep CDP, Provider management, and Selkies token administration unavailable to unauthenticated public routes.

## Workstation browser integration

- The first release uses the authenticated standalone browser/control page as the supported entry point.
- The optional **浏览器** tab opens in the right sidebar of a DSH conversation. Use the supported Browser Bundle client export and Sidebar registry.
- The pane embeds `/_auth/browser`, which hands the authenticated operator to same-origin `/browser/`. The standalone page remains available in full deployments.
- Verify docking, floating, resize, maximize/restore, hide, reconnect, and iframe lifecycle against the exact DSH release. Keep the standalone page as a fallback.
- The official DSH chat, session, file, diff, terminal, Profile, and Plugin Manager remain the primary application interfaces.

## Authentication

| Area | Requirement |
| --- | --- |
| Service | Independent Go service with SQLite WAL. Bootstrap creates exactly one local administrator and closes permanently after successful initialization. No public user-creation or invitation flow. |
| Password and TOTP | Hash passwords with Argon2id. Require RFC 6238 TOTP enrollment and a separate TOTP screen after password succeeds. |
| Passkey | Separate WebAuthn login with configured RP ID, exact HTTPS origin, required user verification, one-time challenges, and multiple credentials for the single administrator. |
| Recovery codes | Show once and store hashes. Each code is single use, and regeneration invalidates old codes. |
| Sessions | Generate cryptographically random opaque tokens and store only hashes. Configure idle and absolute limits and concurrent count. Revoke one session or all sessions. |
| Cookie | `__Host-dsh_session` with Secure, HttpOnly, SameSite=Lax, and Path=/. Omit Domain. |
| Protection | Rate limiting, CSRF and origin checks, protection against account enumeration, and secure secret management. Require step-up for sensitive account changes. |
| Audit | Record successful and failed logins, MFA and credential changes, session changes, and administrator recovery/disable operations. |

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
| `/_auth/` | Gateway authentication UI and API. The Gateway checks access to the protected routes itself. |
| `/mgmt` | Authenticated Gateway console for Runtime status, backups, browser control and account settings. |
| ForwardAuth | Protect DSH and Selkies. Unauthenticated APIs return 401 and WebSocket upgrades are denied. |
| Browser control | Internal or authenticated endpoints. Keep management off unauthenticated public routes. |
| Compose | Core runs Runtime and Gateway. Full adds Browser. Gateway hosts Provider and the input gate. Browser hosts Chromium, Selkies, and the private CDP relay. Both reuse an external Traefik. |
| Networks | Runtime, Gateway and Browser share one configurable workstation subnet. Traefik connects to it and keeps its existing proxy network for Gateway and ForwardAuth. Derive fixed addresses and the Runtime certificate SAN from `WORKSTATION_SUBNET` and check for overlaps before deployment. |
| Images | Publish Runtime and Gateway to GHCR by immutable digest. Pin the upstream LinuxServer Chromium image by digest. |

## User interface and operations

| Area | Requirement |
| --- | --- |
| Browser | Provide the authenticated standalone Selkies/control page for the first release. Native Sidebar is optional/deferred. Show ownership, takeover/return, and reconnect status. |
| Runtime | Show active, installed, and available versions, compatibility, logs, backup status, and health. |
| Plugins | Show installed packages, source, version, compatibility, dependencies, and script approval. Use the official Plugin Manager to install, enable, disable, update, and remove. Show logs and distinguish installation, activation, compatibility, and health. |
| Account | Manage the single administrator's password, Passkeys, TOTP, recovery codes, sessions, and audit. No user administration. Require step-up for sensitive changes. |
| Releases | Version the Runtime image, DSH npm, Gateway image, and Chromium independently. Provider and the input gate ship with Gateway. |
| Backups | Back up DSH_HOME before migrations or dependency operations. Cover DSH_HOME, workspace, Chromium profile, Gateway SQLite database, Provider state, and encryption secrets. Restore tests must prove TOTP and existing Passkeys still work. |
| Health and recovery | Check actual readiness. Document and test upgrades, matched data restore, and rollback. |

## Out of scope

Multi-user accounts and tenant orchestration, Windows Companion, Kubernetes, a custom Agent runtime or editor, hosting a public plugin marketplace, multiple simultaneous browsers, and a mandatory native Sidebar in the first release. The initial deployment excludes Authentik, Browserless, Redis, PostgreSQL, VNC/noVNC, and a separate browser domain or login.

## Definition of Done

A feature includes implementation, automated tests, configuration docs, security implications, recovery behavior, and an Issue with observable acceptance evidence. CI success on a different dependency version is not target-environment verification.
