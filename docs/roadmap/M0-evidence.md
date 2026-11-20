# M0 evidence and decision

English · [简体中文](M0-evidence.zh-CN.md)

[Issue #1](https://github.com/sagehou/dsh-workstation/issues/1) · [Acceptance criteria](M0.md) · [Experiment design](M0-design.md)

Gates A and B passed for the tested releases. The owner approved proceeding with Runtime while C and D remained open. [M1 Runtime and private bring-up](M1.md)

| Gate | Status | Evidence |
| --- | --- | --- |
| A — Runtime and Profile | Pass for the tested packages and upgrade pair | [Runtime job](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353929974), [native job](https://github.com/sagehou/dsh-workstation/actions/runs/44460118655/job/135344573520) |
| B — Shared Chromium | Pass for the pinned stack and fixture | [Shared tabs, same-origin routing and profile restart](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353930294) |
| C — Exclusive | Agent lease and drain passed in the fixture. Held input blocked Human-to-Agent handover. | [Independent Provider evidence](M0-provider-evidence.md#observed-result) |
| D — DSH plugin API | Browser tool calls were gated through official MCP in ACP. Native floating maximize and restore remain blocked. | [Sidebar lifecycle job](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353930328) |

## Exact upstream versions

| Component | Recorded version and sources |
| --- | --- |
| DSH | `latest=0.2.2-rc.1`, `next=0.2.2-rc.5`, and `alpha=0.2.2-alpha.3` at verification time. Both tested releases declare Node `>=24.9.0` and the `dsh` bin at `lib/bin.js`. [npm metadata](https://registry.npmjs.org/@deepseek-ai%2fdsh) · [`dsh-v0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db) · [`dsh-v0.2.2-rc.5`](https://github.com/deepseek-ai/deepseek-harness/tree/9c2670d3bce5275e0d1610272958121af87787bb) |
| Runtime | Node `24.22.3` Bookworm slim, pnpm `11.28.5`, observed Git `2.39.5`, UID `1000`. |
| Native probe | `node-pty@1.2.0-beta.15` and `node-gyp@11.5.0`, using the base image's Node headers. |
| Browser | Chromium `156.0.8078.79`, CDP `1.3`, Selkies `2.2.1`, Pixelflux `2.2.3`, PCMFlux `2.2.1`. [the Chromium scripts](https://github.com/linuxserver/docker-chromium/tree/4ec00555069627093b9110daff841d363f9a95f8/root) · [baseimage-selkies `debiantrixie-60ce2ea6-ls152`](https://github.com/linuxserver/docker-baseimage-selkies/releases/tag/debiantrixie-60ce2ea6-ls152) · [Selkies `2.2.1`](https://github.com/selkies-project/selkies/tree/d6b9351421bd503ffa89bdee78e2bce758b1ffe5) |
| Proxy and test driver | Traefik `3.7.19` and `playwright@1.61.1`. The separate official DSH Browser Use package `0.2.2-rc.1` uses `@playwright/mcp@0.0.80`. |

### Image digests

- Runtime `node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54`
- Browser `lscr.io/linuxserver/chromium:075b0b99-ls64@sha256:6d2a8da6a45d4083a7287211a619ca29fdb518ebea0ef562c27392ba2f6698d2`
- Browser `linux/amd64` registry manifest `sha256:995fa4a4278d8ee90a13c33e983c45606aec8bd69bf6236b7c68cf07c89d16f4`
- Proxy `traefik:v3.7.19@sha256:a6c0194dda77bcb804824580f36fa7edc56e315b1acfe933366c8b52844a78a4`
- Driver `mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48`

### Check upstream metadata

```sh
curl -fsS 'https://registry.npmjs.org/@deepseek-ai%2fdsh' | jq '."dist-tags"'
curl -fsS 'https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.2-rc.1' | jq '{version, engines, bin, dist: .dist.integrity}'
curl -fsS 'https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.2-rc.5' | jq '{version, engines, bin, dist: .dist.integrity}'
curl -fsS 'https://api.github.com/repos/deepseek-ai/deepseek-harness/tags' | jq '.[] | {name, sha: .commit.sha}'
curl -fsS 'https://registry.npmjs.org/@deepseek-ai/dsh-client-ui-sidebar-right/-/dsh-client-ui-sidebar-right-0.2.2-rc.1.tgz' \
  | tar -xzOf - package/lib/types/client/tab-registry.d.ts
docker buildx imagetools inspect 'lscr.io/linuxserver/chromium:075b0b99-ls64'
```

## Remote reproduction

- Use GitHub Actions `ubuntu-24.04` with fresh state, Docker `28.0.4`, and Compose `2.38.2`. Pushes to `m0/issue-1` that change probes or the workflow trigger the jobs. [workflow](../../.github/workflows/m0.yml)
- The scripts use isolated Compose project names and remove the test volumes. Keep DSH launch URLs, tokens, and cookies out of logs.

The four probe jobs at `93a31de` passed their assertions. The separate native job was skipped. The outstanding C and D criteria remain open. [final run at `93a31de`](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576)

```sh
# Gate A — Runtime and Profile.
bash prototypes/m0/runtime/run.sh

# Gate B and the human input part of Gate C.
bash prototypes/m0/browser/run.sh
bash prototypes/m0/browser/run.sh --exclusive

# Gate D — Sidebar fixture.
bash prototypes/m0/browser/sidebar/run.sh
```

### One approved native build

The recorded command for the separate build at `058e789` ran once with explicit approval. [`058e789`](https://github.com/sagehou/dsh-workstation/commit/058e789)

```sh
docker compose -f prototypes/m0/runtime/compose.yml run --build --rm --no-deps -T runtime bash /m0/native.sh
```

- The job installed with `--ignore-scripts`, removed the `node-pty` prebuilds, and ran the pinned `node-gyp` rebuild as UID `1000`.
- The loaded module was `build/Release/pty.node`. The output included `gyp info ok` and `source-built node-pty emitted expected PTY output as uid 1000`.
- Repeating the build requires separate approval. The check covered a standalone PTY. Plugin lifecycle scripts and the DSH Web terminal were outside its scope.

## A — Runtime and Profile

### Web startup

- `dsh web --no-open --port 0` initializes the bundled Web Profile as needed. The probe exchanges the startup URL for a cookie and checks for an authenticated HTTP 200 boot page. [CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/apps/cli/reference/README.md)
- The tested versions reject `--host 0.0.0.0`. The intentionally failed readiness check uses that path. [Web app bind, Host/Origin and session rules](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/web-app/README.md#public-deployments)

### Plugin installation and activation

[Plugin Manager reference](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/plugin-manager/README.md)

- `dsh plugin --profile web add` invokes the official pnpm operations. The probe uses `--save-exact --ignore-scripts --ignore-workspace-root-check`.
- The npm fixture is `@deepseek-ai/dsh-experimental-badge-skill-bundle@0.2.2-rc.1`.
- The Git HTTPS fixture is `git+https://github.com/sagehou/dsh-workstation.git#8a1d8c03ff3e2f94abc82792ed0771bc82b6fb63&path:/prototypes/m0/runtime/fixture`.
- A saved dependency, an enabled entry in `dsh.profile.bundles`, and a successfully loaded Bundle are distinct states. The Git fixture writes a fresh marker during each health run.
- Load order is Bundle layers → Profile patch → home patch → CLI overlays. Resolve built-in Bundles from the selected DSH install and other Bundles from the Profile.

- Plugin Manager serves the Web Plugins page and the `plugin_manager` tool. `inspect`, `installBundle`, and `listBundles` distinguish source metadata, package installation, and activation. Profile HMR can apply changes live. Startup-only profiles may need a restart.
- Compatibility checks use declared `engines.dsh` and DSH peer ranges. Git metadata is checked after fetch, so rejected operations can leave files in the store. Exact exemptions live in the Profile's `compatibility.json`, separate from script approval. The CLI test used neither. [compatibility contract](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/plugin-manager/README.md#version-compatibility-and-exemptions)

### Persistence map

| Path in the Runtime container | Owner and evidence |
| --- | --- |
| `/dsh-home/runtime/versions/<version>` and `/dsh-home/runtime/current` | PoC only. Staging and atomic symlink updates under `flock`. `current` is the active pointer. |
| `/dsh-home/profiles/web/package.json`, `cordis.patch.yml`, `compatibility.json` | Upstream dependency and ordered Bundle manifest, Profile overlays, and optional exact compatibility exemptions. Manifest and patch digests matched before/after recreation and in both directions of the version switch. |
| `/dsh-home/profiles/web/pnpm-lock.yaml`, `pnpm-workspace.yaml`, `node_modules/.pnpm` | Plugin lock, PoC store and script policy, and resolved package links. Both fixture package manifests/patches and link destinations matched. |
| `/dsh-home/pnpm/store/v11` | Chosen store path, not an upstream default. pnpm reported content-addressable store hardlinks. The store membership fingerprint matched across recreation. |
| `/dsh-home/cordis.patch.yml`, `.credentials.yaml`, `sessions/`, `storages/` | The home overlay and base Profile data stay on one volume. The probe did not exercise real credentials or saved conversation migration and restore. [Base Profile](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/base/cordis.patch.yml) |
| `/workspace`, `/backup` | Separate volumes. The PoC snapshots DSH_HOME before Profile dependency changes or version switches. |

### Observed switch and rollback

[passing Runtime job at `5686d9e`](https://github.com/sagehou/dsh-workstation/actions/runs/44460212791/job/135344880883)

```text
installed DSH 0.2.2-rc.1 in /dsh-home/runtime/versions/0.2.2-rc.1
authenticated Web boot OK; Git bundle apply: observed
container recreated: image unchanged
installed DSH 0.2.2-rc.5 in /dsh-home/runtime/versions/0.2.2-rc.5
readiness rejected DSH 0.2.2-rc.5; pointer restored to versions/0.2.2-rc.1
[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @deepseek-ai/dsh@0.0.0
active DSH 0.2.2-rc.5
active DSH 0.2.2-rc.1
runtime/plugins: tested both DSH versions, recreation and two rollback paths on one image
```

- Both releases booted the Profile, loaded the Git fixture without dependency edits, and preserved the Store and locked plugin dependencies after recreation.
- Pointer rollback cannot undo data migration. Plugin Manager builds, Git `prepare` scripts, extra system libraries, and compatibility with other plugins were outside this test.
- The official manager supports approval of reviewed scripts by exact pending `allowBuilds` keys per Profile.

## B — One browser process and profile

### Setup

- LinuxServer passes `CHROME_CLI` through to Chromium. The probe uses `/config/m0-chromium` and CDP port `9222`. [`autostart_wayland`](https://github.com/linuxserver/docker-chromium/blob/4ec00555069627093b9110daff841d363f9a95f8/root/defaults/autostart_wayland) · [`wrapped-chromium`](https://github.com/linuxserver/docker-chromium/blob/4ec00555069627093b9110daff841d363f9a95f8/root/usr/bin/wrapped-chromium)
- A relay in Chromium's network namespace reaches its loopback listener from one isolated Docker bridge. The probe checks that the host cannot connect and checks `/json/version` and `/json/list` from a peer.

### Observed sharing and restart

- Selkies input opened a CDP-visible tab and set a persistent cookie. A tab created through Playwright accepted Selkies input and read the same cookie in the default context.
- The job counted one desktop Chromium main process, checked its command line and profile path, and confirmed the cookie on disk before restart. A separate headless viewer only drove Selkies. [`d71856d`](https://github.com/sagehou/dsh-workstation/actions/runs/44461308475/job/135348481161)

```text
no host ports published; host CDP probes denied
private peer CDP: Chrome/156.0.8078.79; protocol 1.3
same-origin HTTPS iframe received Selkies WebSocket video through the unchanged /browser/ prefix
human-side Selkies keyboard opened a tab visible in CDP and set a cookie in the default context
agent-created tab accepted Selkies input and shared the human-set cookie
Chromium reported an enforced frame-ancestors denial for the cross-origin iframe
test cookie committed to the persistent Chromium profile
persistent cookie still present in the default context after Chromium restart
```

Earlier runs failed to find the cookie after restart or stopped before persistence at the keyboard navigation step. The passing probe waits for a video frame, then activates a focused link in the first Chromium tab. [`496a285`](https://github.com/sagehou/dsh-workstation/actions/runs/44459609588/job/135342898428) · [`5686d9e`](https://github.com/sagehou/dsh-workstation/actions/runs/44460212791/job/135344880671)

### Routing and limits

- Set LinuxServer `SUBFOLDER=/browser/` and preserve the prefix at Traefik. The bundled Nginx expects that path and proxies the API to Selkies. [bundled Nginx template](https://github.com/linuxserver/docker-baseimage-selkies/blob/6379480bcbd4ba42c1f5d4ab5eca49304fdedf83/root/defaults/default.conf)
- Fixture ForwardAuth denied unauthenticated app and `/browser/` API requests. The authenticated same-origin iframe streamed over WebSocket.
- Traefik applied `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. The browser rejected an iframe on a second HTTPS origin on the same site.
- The app route used a fixture. The experiment did not exercise official DSH launch-token exchange or production Auth.

- The probe attaches to `browser.contexts()[0]`, disconnects, and leaves the desktop running. Agent operations must not shut down the shared browser or context.
- Full CDP parity, download persistence, and recovery after a Provider disconnect were outside this probe.

## C — Exclusive control

### Selkies input path

- Selkies `2.2.1` uses its secure-mode input authority rule across both transports. This probe forces WebSockets. [`SELKIES_MASTER_TOKEN` and `POST /api/tokens`](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/docs/secure-mode.md) · [input authority rule](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/src/selkies/sessions.py#L62)
- Send raw keyboard and mouse frames and count actual events in the CDP target. Input arrived before and after the lock on the same connection. While locked, the count stayed flat and fresh video arrived.

Observed at `d71856d`.

```text
Selkies server denied raw keyboard and mouse frames while the same socket received new video
restoring the token table re-enabled keyboard and mouse on the existing socket
```

- The first secure-mode run at `5686d9e` stopped at `Selkies secure-mode control plane unavailable`. The passing probe uses a one-line Compose secret with no trailing newline, reports status only, and keeps token administration off the public browser route. [`5686d9e`](https://github.com/sagehou/dsh-workstation/actions/runs/44460212791/job/135344880925)
- WebRTC, alternate input and device paths, held keys or buttons at handover, and fail-closed behavior after a Selkies restart need evidence where applicable.

### DSH tool and CDP paths

- Gate B's CDP relay belongs to the experiment.
- The official Browser Use Playwright MCP provider documents `mode: attach` and `endpoint`. Its Session reservations are local to each provider. `ctx.browserUse` registers providers and supplies no shared action hook. [Browser Use Playwright MCP provider](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/experimental/browser-use-playwright-mcp/README.md)
- `ctx.tools.guard` can reject admission before dispatch. Direct CDP from the Agent environment bypasses that guard, so keep CDP outside its network. [`ctx.tools.guard`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/tools.md#ctxtools--tools) · [pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/pipeline.ts#L213)

- The separately approved Provider used official Streamable HTTP MCP in the ACP profile. Its fixture passed leases, takeover drain, expiry, concurrency, stale generations, and DSH, Chromium, and Provider disconnect or restart. Only the Provider had access to private CDP. [independent Provider experiment](M0-provider-evidence.md) · [Streamable HTTP MCP integration](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/mcp.md)
- **The held-pointer case failed.** If the user held a mouse button before the grant, it stayed pressed until control returned to HUMAN. A supported handoff must stop and release already accepted input before granting Agent control.

## D — Native Sidebar lifecycle

### Public API and fixture

- The public surface exposes `dsh.client`, the `./client` Bundle export, `ctx.sidebarRightTabs.register`, the `sidebar.right.pane.tab` slot, and `keepMounted`. [Sidebar docs](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/sidebar-right.md) · [client module contract](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/client-modules.md)
- The probe installs a local Bundle via Plugin Manager, with the client bundled by the pinned upstream preset. The frame loads a same-origin fixture. Load count and a value inside the frame prove whether its browsing context survives. [pinned upstream preset](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/tsdown.client.ts#L1-L12)

| Capability | Upstream behavior |
| --- | --- |
| Float and dock | The public service exposes `float` and `dock`. The floating header supports drag, resize, and dock. [public service](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/service.ts#L249-L298) · [header and resize handle](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-dockkit/src/components/FloatLayer.tsx#L311-L345) |
| Maximize and restore | Fullscreen and restore apply to the docked column. Floating maximize and restore are unavailable. [docked column](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx#L273-L292) |
| Hide | The public `hide` closes a floating tab. `keepMounted` cannot preserve the closed iframe. The separate Chromium container keeps running. [`hide` implementation](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/service.ts#L577-L585) |
| Second tested release | `0.2.2-rc.5` has the same service and floating header limits. [`0.2.2-rc.5`](https://github.com/deepseek-ai/deepseek-harness/tree/9c2670d3bce5275e0d1610272958121af87787bb/packages/client) |

### Observed lifecycle

- The first probe reported `web boot: 1 entry did not activate` (`dsh-m0-sidebar-probe: failed`). The published `SidebarRightTabDefinition` requires `guide?: readonly SidebarRightGuideEntry[]`, with an `id` per entry. The npm `./client` declaration and registry implementation confirm the array. [`f4cd89a`](https://github.com/sagehou/dsh-workstation/actions/runs/44462375518/job/135351996893) · [`SidebarRightTabDefinition`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/tab-registry.ts#L61-L137)
- After correcting the entry and conversation locator, the npm Web app ran the probe with a loopback model fixture and no DeepSeek account. [remote Sidebar job at `93a31de`](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353930328)

```text
npm DSH loaded the external client plugin through its Profile bundle
iframe retained across tab selection and docked hide/show
iframe retained across native float, resize and dock
iframe retained across docked fullscreen and restore
upstream floating hide closes the tab; its iframe does not survive
```

- Native floating behavior waits for upstream support.
- The standalone ACP Provider gated browser calls through official MCP without changes to DSH core. The official Playwright MCP Browser Use package and Web Profile credential binding under a lease were outside this experiment.

M0 evidence collected 2026-11-19 UTC on disposable test environments.
