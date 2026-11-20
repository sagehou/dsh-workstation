# Public Compose: design and evidence

English · [简体中文](public-compose.zh-CN.md)

The owner authorized continuing with a public single-user Compose and deferring the held-input handoff and native Sidebar. This builds on [M0](M0-evidence.md), the [Provider results](M0-provider-evidence.md), and the [M1 Runtime results](M1.md). It does not mark the open M0 acceptance criteria as passed.

## Existing Traefik and three Docker networks

The five workstation containers use the existing trusted proxy network and two Compose bridges. Go Auth binds its listeners only to its proxy-network alias and checks the exact Traefik source IP. Runtime and the MCP listener share `workstation`. Chromium and the Provider management listener share `browser`. Traefik joins both bridges for DSH and Selkies, and Auth uses both for WebSocket forwarding. Provider management still requires the Auth service's credential. [Deployment guide](../../deploy/public/README.md)

The relay shares Chromium's network namespace and forwards its loopback CDP to a Unix socket. A dedicated volume gives the relay write access and the Provider read-only access. Playwright attaches via a Provider-local loopback listener backed by that socket. The browser and Runtime bridges keep their normal outbound routes. The topology keeps CDP off both bridges and requires no custom host firewall rules.

Run `bash deploy/public/ci.sh` through [Public Compose](../../.github/workflows/public-compose.yml) on GitHub Actions. It uses an independently started Traefik with a temporary HTTPS certificate, verifies the socket mount and network boundaries, recreates a killed relay and Chromium on the same volumes, and exercises the full login and DSH-to-Provider flow.

The [GitHub Actions job at `333e6f3`](https://github.com/sagehou/dsh-workstation/actions/runs/44688814854/job/136129433239) passed with Traefik `3.7.19`, Chromium `156.0.8078.79`, Selkies `2.2.1`, DSH `0.2.2-rc.1` and Playwright `1.61.1`. The stack used Runtime `0.2.0`, Auth `0.1.1` and Provider `0.2.0`.

| Check | Observed result |
| --- | --- |
| Three networks and CDP | Only the relay and Provider mounted the socket volume. DSH could reach the credential-protected MCP listener. Direct DSH connections to Selkies, CDP, the Provider management listener and ForwardAuth failed. The host did not reach any CDP listener. |
| Login and recovery | HTTP redirected to HTTPS. Unauthenticated API and WebSocket requests returned 401. Password then TOTP and Passkey worked. A fresh Auth volume restored from SQLite backup honored the existing session. Revocation closed established DSH and Selkies sockets. |
| Chromium and relay recreation | After killing the relay, Compose recreated both containers on their original volumes. The Provider attached to a new CDP instance via the reused socket volume. |
| Session tabs | Selkies streamed on the DSH origin. Two real DSH sessions retained distinct tabs through A → B → A switching. Unleased, cross-session and stale generation operations were rejected. |

The [amd64 artifact](https://github.com/sagehou/dsh-workstation/actions/runs/44688814854/artifacts/14607841816) includes the three images, source commit, image IDs, checksum and integration log. Its archive SHA-256 is `1213fd422aeac235081e6ed1180a3021db26d10b69281a85982e8e7f71d3afc8` and GitHub lists expiration at `2027-02-18T06:34:57Z`. CI used a temporary certificate and a deterministic model response.

## Original standalone topology

- Traefik terminates public TLS and uses Go ForwardAuth on the DSH and Selkies routes. The Go service alone issues its session cookie. It trusts the proxy on a dedicated bridge, verifies the public origin on writes, and separates login documents from API and WebSocket denial. Upgraded browser and DSH connections through Auth have the same SQLite session lifetime as HTTP.
- The [official `dsh web` TLS flags](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/web-app/src/startup.ts) enable Secure DSH cookies. The gateway exchanges DSH's private launch URL over verified internal TLS using the exact public Host, forwards the official cookie and redirects to a safe relative path.
- The [official Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/plugin-manager/README.md) links the Workstation Bundle using the [host peer resolution rules](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/user/develop/basic/publish.md#install-into-a-profile). It attaches the host's [official MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/README.md) to the live Agent's [Cordis context](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/core.md).
- The pinned [MCP client SDK 2.2.0](https://www.npmjs.com/package/@modelcontextprotocol/client/v/2.2.0) probes with `server/discover`. An authenticated probe receives the legacy response without consuming the signed admission ticket. An unauthenticated probe still receives 401. The legacy `initialize` consumes the ticket once. Browser ownership requires a separate authenticated grant; model tool arguments do not select a peer or tab.
- The existing Provider enforces a global lease, per-peer tab binding, per-grant generation, single-flight operations, takeover drain and a restart fence. It alone can reach CDP. Selkies [secure mode and token table](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/docs/secure-mode.md) gate newly submitted input and keep video live. Already accepted held input is still the known limitation. The control page is separate from DSH while native Sidebar support is unavailable.
- The Provider keeps its root filesystem read-only and mounts a bounded temporary filesystem for [Playwright's CDP attachment artifacts](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/chromium/chromium.ts#L118). Its health check requires an attached browser via the private control listener.

Pins: DSH and its official MCP client `0.2.2-rc.1`, Node `24.22.3`, pnpm `11.28.5`, Go `1.27.3`, go-webauthn `0.18.2`, go-sqlite3 `1.14.53`, Traefik `3.7.19`, LinuxServer Chromium `075b0b99-ls64` with Selkies `2.2.1`, MCP server SDK `1.31.0`, Playwright `1.61.1`. See the Compose and Dockerfiles for release image digests and dependency lockfiles for module hashes.

Reproduce on a GitHub-hosted Ubuntu 24.04 runner through the [Public Compose workflow](https://github.com/sagehou/dsh-workstation/blob/de823f9d850ae5a8bc001a67613413220ff4fd7e/.github/workflows/public-compose.yml), which runs `go test -race -v ./...` in the pinned Go image and `bash deploy/public/ci.sh`. The script resolves no real domain and uses disposable certificates and a deterministic model fixture. It exercises the exact production routes, official DSH executable and MCP client. Certificate issuance by the real CA still needs public DNS and TCP port 80 when deployed.

The [GitHub-hosted run 44488230831](https://github.com/sagehou/dsh-workstation/actions/runs/44488230831/job/135436965916) passed at [`de823f9`](https://github.com/sagehou/dsh-workstation/commit/de823f9d850ae5a8bc001a67613413220ff4fd7e):

| Check | Observed result |
| --- | --- |
| `go test -race -v ./...` | `TestTwoStepLoginAndReplay` and `TestForwardAuthAndRevocation` passed. The tests exercise TOTP replay, one-use recovery, trusted proxy checks, session expiry and revocation. |
| HTTPS and network separation | HTTP redirected to HTTPS. Unauthenticated API and WebSocket requests got 401. The Selkies token administration route was not exposed. DSH could not reach CDP, Provider control, or ForwardAuth; an anonymous MCP version probe got 401. |
| Browser login and restore | Password and TOTP were separate screens. The browser received two Secure, HttpOnly cookies and booted DSH without a launch token in its URL. A browser authenticator registered a passkey. After restoring the Auth backup into a fresh volume, the existing session still worked; password/TOTP and Passkey both worked again. Revocation closed established DSH and Selkies WebSockets. |
| Browser Provider through DSH Web | Authenticated `/browser/` streamed Selkies video. Real DSH Web RPC created two sessions. Both returned `NO_LEASE` before grant; cross-session navigation returned `NOT_OWNER`; an out-of-policy origin returned `ORIGIN_NOT_ALLOWED`; an old lease generation returned `STALE_GENERATION`. A read `WTAB_ALPHA`, B read `WTAB_BETA`, and after switching back A still read `WTAB_ALPHA`. |

The [public-compose-linux-amd64 artifact](https://github.com/sagehou/dsh-workstation/actions/runs/44488230831/artifacts/14512006785) contains the Runtime `0.2.0`, Auth `0.1.0` and Provider `0.1.0` images, source commit, image IDs, SHA-256 file and test log. Follow the [deployment guide](https://github.com/sagehou/dsh-workstation/blob/de823f9d850ae5a8bc001a67613413220ff4fd7e/deploy/public/README.md) to check the archive and load it. GitHub lists archive SHA-256 `8e06e50bd7bfaf184fa91f797800f1ac151acd318edaa3690fe0d87f3d1a9044` and expiry `2027-02-17T08:30:48Z`. While the run is eligible for replay, use `gh run rerun 44488230831 --repo sagehou/dsh-workstation`; a fresh matching build can be triggered by a change under `deploy/public/` on a `public/**` branch based on the tested commit.

The full-stack check uses a disposable CA, two live DSH sessions, and the deterministic Messages fixture. It did not deploy to a server or request a public certificate. Tab ownership is scoped to a live MCP connection; a new connection needs a fresh grant. The held-input handoff and native Sidebar remain deferred. See the [M0 Provider results](M0-provider-evidence.md) for the separate drain, expiry, concurrency, disconnect and restart checks.
