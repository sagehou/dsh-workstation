# Architecture — DSH Web Workstation

## Component boundaries

### DSH Runtime image
A reusable environment image, not an application-version image. Contains compatible Node.js, pinned pnpm, Git/SSH, CA certificates, and common native build toolchain. It does not bake in a fixed DSH npm version. DSH versions live in persistent storage and are managed by a dedicated CLI/API.

### Runtime manager
Installs exact official DSH npm versions into isolated directories under DSH_HOME, validates them, atomically switches a current pointer, health-checks startup, and rolls back on failure. Must serialize mutations with a filesystem/process lock. Never modifies the active version in place.

### DSH Profile
Managed by official DSH CLI/Plugin Manager. Preserve the actual upstream directory structure for the pinned release. Mount DSH_HOME as one coherent persistent volume so pnpm symlinks/store relationships are not split across filesystems. Workspace is a separate mount.

### Auth gateway
Go HTTP service with SQLite WAL. Responsibilities: password/TOTP/WebAuthn ceremonies, recovery codes, opaque sessions, CSRF, audit, rate limits, ForwardAuth verification, and browser-control lease coordination. No DSH Agent execution.

### Workstation plugin
A DSH client plugin that registers a right-sidebar Browser Desktop tab using documented APIs for the selected DSH version. Embeds same-origin `/browser/` and communicates with Auth/Browser Control APIs. Must not patch DSH core or depend on undocumented internals without an ADR.

### Chromium
LinuxServer Chromium/Selkies, one Chromium process and one persistent profile. Selkies handles human interaction; CDP handles Agent automation. Same browser process is the key invariant. CDP is private to Docker and not published to host/public interfaces.

### Traefik
Routes:
- `/` -> DSH (ForwardAuth)
- `/browser/` -> Chromium Selkies (same ForwardAuth, preserve prefix)
- `/_auth/` -> Auth public login/account UI/API (no self-ForwardAuth)
- internal ForwardAuth verification endpoint -> Auth, reachable only by Traefik

Do not assume path-subfolder support, response headers, CSP, WebSocket behavior, or Auth signin behavior without testing exact upstream versions.

## Data ownership and persistence

- DSH_HOME: runtime versions, Profile manifests, lockfiles, node_modules, pnpm store, sessions, settings, credentials, plugin config. One persistent volume.
- Workspace: project files, separate volume/bind mount.
- Chromium /config: browser profile, cookies, extensions, downloads, persistent.
- Auth data: SQLite database, separate volume.
- Auth secrets: Docker secrets or read-only secret files, stored/backed up separately from DB.
- Deployment config: Git, no secrets committed.

## Authentication flow

Password ceremony:
1. POST credentials to Auth.
2. On success, issue short-lived, single-use pre-auth cookie/challenge.
3. Navigate to distinct TOTP screen; do not render password fields there.
4. Verify TOTP once per accepted time step.
5. Rotate to full opaque session cookie.

Passkey ceremony:
- WebAuthn challenge with strict RP ID/origin, required user verification, one-time challenge.
- Successful assertion creates full session.
- Passkey login is a separate ceremony; TOTP enrollment remains mandatory account policy.

Cookie: `__Host-dsh_session`, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain.

## Browser control

States: HUMAN, AGENT, HANDOVER, PAUSED, DISCONNECTED.

Lease fields: lease ID, owner type/ID, DSH session ID, generation, issued/expiry times. Use transactional compare-and-swap semantics. Tool provider must validate lease on every operation. Lease expiry and process death must fail closed to HUMAN or DISCONNECTED, never leave stale AGENT ownership.

A UI-only lock is insufficient. Human keyboard/mouse input at the Selkies boundary must be gated when AGENT owns control. If upstream Selkies cannot support reliable input gating without patching its image, investigate a small authenticated input-gateway/proxy or a separately maintained integration image; do not claim Exclusive mode until tested.

Agent automation must attach to the existing default Chromium context over CDP. Avoid launching a second browser or creating a separate isolated context when shared cookies/tabs are required. Verify Playwright CDP limitations and prevent tool operations such as closing the browser/context.

## Versioning

Independent version axes:
- Runtime image version
- DSH npm version
- Auth image version
- Workstation plugin version
- Chromium image tag/digest

DSH npm version changes do not rebuild the Runtime image. Runtime image changes do not silently update DSH. Profile/plugin data is not assumed backward-compatible across DSH releases; backup and migration checks are mandatory.

## Security boundaries

- No Docker socket mounts.
- No CDP host port publishing.
- Do not expose browser control endpoints publicly.
- Do not trust client-supplied identity headers.
- ForwardAuth strips/replaces identity headers from client input.
- Auth service and login routes are exempt from their own ForwardAuth.
- API/WebSocket auth failures must not receive an HTML signin page.
- Browser terminal is effectively powerful access to its container; only trusted users in initial scope.
- Authentication for multiple accounts is not tenant isolation.
