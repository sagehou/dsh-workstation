# Public Compose: design and evidence

English · [简体中文](public-compose.zh-CN.md)

The owner approved a single-administrator public Compose release. The authenticated standalone browser/control page is the first-release UI; native Sidebar is deferred. Agent browser control remains gated until held-input release and exclusive handoff pass #4, and broad untrusted-site browsing remains gated until the egress policy passes #11. [ADR-0004](../adr/0004-single-user-release-and-deferred-sidebar.md) · [M0](M0-evidence.md) · [Provider results](M0-provider-evidence.md) · [M1 Runtime results](M1.md) · [#1](https://github.com/sagehou/dsh-workstation/issues/1)

## Existing Traefik and three Docker networks

| Network | What it carries |
| --- | --- |
| Existing proxy | Go Auth listeners. Auth checks the exact Traefik source IP from the trusted proxy network. |
| `workstation` | DSH and official MCP. Traefik and Auth can reach DSH here. |
| `browser` | Chromium, Selkies, and the credential-protected Provider management listener. Traefik connects for HTTP and Auth for WebSockets. |

Five workstation containers reuse external Traefik. Runtime and Chromium keep independent outbound routes. [Deployment guide](../../deploy/public/README.md)

The CDP relay shares Chromium's network namespace. It forwards loopback CDP over a dedicated Unix socket volume. The relay writes the socket, and the Provider mounts the volume read-only. Playwright attaches via the Provider's own loopback listener. The topology requires no custom host firewall rules.

### Reproduce on GitHub Actions

Public Compose runs `go test -race -v ./...` in the pinned Go image and `bash deploy/public/ci.sh` on the GitHub-hosted runner. The integration uses a separate Traefik, a temporary certificate, and a deterministic model fixture. [Public Compose](../../.github/workflows/public-compose.yml)

The job matrix reads its versions only from [`deploy/public/traefik-matrix.env`](../../deploy/public/traefik-matrix.env). Each leg pulls `tag@digest`, runs the same Compose stack, the same edge probe and the same post-login browser checks; only the Traefik image differs. [#3](https://github.com/sagehou/dsh-workstation/issues/3)

### Traefik compatibility matrix

| Traefik | Pinned digest | Status |
| --- | --- | --- |
| `v3.7.19` | `sha256:a6c0194dda77bcb804824580f36fa7edc56e315b1acfe933366c8b52844a78a4` | Awaiting a matrix run |
| `v3.7.14` | `sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c` | Awaiting a matrix run |

Minimum supported edge version: **v3.7.14**. This table is not a claim that any Traefik 3.7 patch works — only versions listed here have a recorded run. A version absent from the table is untested, and `deploy/public/traefik-image.sh` refuses to resolve it rather than silently testing a floating tag.

Every leg must verify the HTTP→HTTPS redirect, HSTS/nosniff/referrer headers, ForwardAuth returning 401 for APIs and 303 for documents, forged `X-Workstation-User`/`X-Forwarded-User`/`Remote-User` failing to authenticate, the `/browser/` prefix requiring login, `/browser/api/tokens` staying unrouted, the internal DSH TLS chain, Selkies WebSocket video, and the same-origin frame policy after login.

CONNECT differs across the matrix, so the probe records the observed status per version instead of assuming one behaviour:

- HTTP/1 `CONNECT` has been rejected since `v3.7.9`; both pinned versions return 501.
- From `v3.7.15` every HTTP version of `CONNECT` returns 501. On `v3.7.14` it is merely unrouted, which is not the same guarantee.

### Observed results

The job passed at `333e6f3` with a single Traefik 3.7.19 leg. It used Traefik `3.7.19`, Chromium `156.0.8078.79`, Selkies `2.2.1`, DSH `0.2.2-rc.1`, and Playwright `1.61.1`. [GitHub Actions job at `333e6f3`](https://github.com/sagehou/dsh-workstation/actions/runs/44688814854/job/136129433239)

| Check | Observed result |
| --- | --- |
| Three networks and CDP | Only the relay and Provider mounted the socket volume. DSH could reach the credential-protected MCP listener. Direct DSH connections to Selkies, CDP, the Provider management listener and ForwardAuth failed. The host did not reach any CDP listener. |
| Login and recovery | HTTP redirected to HTTPS. Unauthenticated API and WebSocket requests returned 401. Password with TOTP and the separate Passkey login both worked. A fresh Auth volume restored from SQLite backup honored the existing session. Revocation closed established DSH and Selkies sockets. |
| Chromium and relay recreation | After killing the relay, Compose recreated both containers on their original volumes. The Provider attached to a new CDP instance via the reused socket volume. |
| Session tabs | Selkies streamed on the DSH origin. Two real DSH sessions retained distinct tabs through A → B → A switching. Unleased, cross-session and stale generation operations were rejected. |

### Images

- Runtime `0.2.0`, Auth `0.1.1`, and Provider `0.2.0`. The archive includes the source commit, image IDs, checksum, and integration log. [amd64 artifact](https://github.com/sagehou/dsh-workstation/actions/runs/44688814854/artifacts/14607841816)
- Archive SHA-256 `1213fd422aeac235081e6ed1180a3021db26d10b69281a85982e8e7f71d3afc8`.
- The artifact expires `2027-02-18T06:34:57Z`.

## Original standalone topology

### Auth and DSH integration

- Traefik terminates TLS. Go Auth issues its session cookie, trusts Traefik on the original dedicated bridge, checks the public origin on writes, and enforces the same SQLite session lifetime on HTTP and upgraded connections. It denies unauthenticated API and WebSocket requests separately from document navigation.
- Official TLS flags enable **Secure DSH cookies**. The gateway exchanges the launch URL over verified internal TLS, preserves the exact public Host, relays the cookie, and redirects to a validated relative path. [official `dsh web` TLS flags](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/web-app/src/startup.ts)
- Official Plugin Manager links the Workstation Bundle using host peer resolution. The Bundle attaches the official MCP client in the live Agent's Cordis context. [official Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/plugin-manager/README.md) · [host peer resolution rules](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/user/develop/basic/publish.md#install-into-a-profile) · [official MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/README.md) · [Cordis context](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/core.md)
- MCP client SDK `2.2.0` probes with `server/discover`. An authenticated probe receives the legacy response and keeps the signed ticket unused. Anonymous probes get 401. Legacy `initialize` consumes the ticket once. Browser ownership requires a separate grant. Tool arguments cannot choose a peer or tab. [MCP client SDK 2.2.0](https://www.npmjs.com/package/@modelcontextprotocol/client/v/2.2.0)

### Provider and input

- The Provider alone accesses CDP. It enforces one global lease, tab binding per peer, a new generation per grant, one operation at a time, takeover drain, and a restart guard.
- Selkies gates newly submitted input and keeps video live. A previously held input can remain pressed. The separate control page is used until native Sidebar support is available. [secure mode and token table](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/docs/secure-mode.md)
- The Provider uses a read-only root filesystem and a bounded temporary filesystem for Playwright's attach artifacts. Health requires a live Chromium attachment. [Playwright's CDP attachment artifacts](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/chromium/chromium.ts#L118)

### Pins

| Layer | Versions |
| --- | --- |
| Runtime | DSH and official MCP client `0.2.2-rc.1`, Node `24.22.3`, pnpm `11.28.5`. |
| Auth | Go `1.27.3`, go-webauthn `0.18.2`, go-sqlite3 `1.14.53`. |
| Edge and browser | Traefik `3.7.19`, LinuxServer Chromium `075b0b99-ls64`, Selkies `2.2.1`. |
| Provider | MCP server SDK `1.31.0`, Playwright `1.61.1`. |

Image digests are in the Compose and Dockerfiles. Module hashes are in the lockfiles.

### Reproduce the original run

The GitHub-hosted Ubuntu 24.04 job ran `go test -race -v ./...` and `bash deploy/public/ci.sh`. A disposable CA and deterministic Messages fixture drove the actual routes, official DSH executable, and official MCP client. Public ACME HTTP-01 requires public DNS and TCP port 80 at deployment. [Public Compose workflow](https://github.com/sagehou/dsh-workstation/blob/de823f9d850ae5a8bc001a67613413220ff4fd7e/.github/workflows/public-compose.yml)

### Original results

The original standalone Compose passed at `de823f9`. [GitHub-hosted run 44488230831](https://github.com/sagehou/dsh-workstation/actions/runs/44488230831/job/135436965916) · [`de823f9`](https://github.com/sagehou/dsh-workstation/commit/de823f9d850ae5a8bc001a67613413220ff4fd7e)

| Check | Observed result |
| --- | --- |
| `go test -race -v ./...` | `TestTwoStepLoginAndReplay` and `TestForwardAuthAndRevocation` passed. The tests exercise TOTP replay, one-use recovery, trusted proxy checks, session expiry and revocation. |
| HTTPS and network separation | HTTP redirected to HTTPS. Unauthenticated API and WebSocket requests got 401. The Selkies token administration route was not exposed. DSH could not reach CDP, Provider control, or ForwardAuth. An anonymous MCP version probe got 401. |
| Browser login and restore | Password and TOTP were separate screens. The browser received two Secure, HttpOnly cookies and booted DSH without a launch token in its URL. A browser authenticator registered a passkey. After restoring the Auth backup into a fresh volume, the existing session still worked. Password with TOTP and the separate Passkey login both worked again. Revocation closed established DSH and Selkies WebSockets. |
| Browser Provider through DSH Web | Authenticated `/browser/` streamed Selkies video. Real DSH Web RPC created two sessions. Both returned `NO_LEASE` before grant. Denied calls returned `NOT_OWNER` across sessions, `ORIGIN_NOT_ALLOWED` for other origins, and `STALE_GENERATION` for old leases. A read `WTAB_ALPHA`, B read `WTAB_BETA`, and after switching back A still read `WTAB_ALPHA`. |

### Original image archive

- Runtime `0.2.0`, Auth `0.1.0`, and Provider `0.1.0`, with the source commit, image IDs, SHA-256 file, and log. [public-compose-linux-amd64 artifact](https://github.com/sagehou/dsh-workstation/actions/runs/44488230831/artifacts/14512006785) · [deployment guide](https://github.com/sagehou/dsh-workstation/blob/de823f9d850ae5a8bc001a67613413220ff4fd7e/deploy/public/README.md)
- Archive SHA-256 `8e06e50bd7bfaf184fa91f797800f1ac151acd318edaa3690fe0d87f3d1a9044`. Expiry `2027-02-17T08:30:48Z`.
- While the run is eligible for replay, use `gh run rerun 44488230831 --repo sagehou/dsh-workstation`. A change under `deploy/public/` on a `public/**` branch from the tested commit can run a fresh build.

### Test scope

- Both full-stack runs used GitHub Actions and temporary certificates. Issuance by a public CA and an operator-host deployment remain outside the evidence.
- Tab ownership follows a live MCP connection. A new connection requires a fresh grant. The independent M0 run covers drain, expiry, concurrency, disconnect, and restart. [M0 Provider results](M0-provider-evidence.md)
