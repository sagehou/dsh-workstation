# M0 evidence and decision

English · [简体中文](M0-evidence.zh-CN.md)

[Issue #1](https://github.com/sagehou/dsh-workstation/issues/1) · [Acceptance criteria](M0.md) · [Experiment design](M0-design.md)

**Proceed with [M1 Runtime and private bring-up](M1.md).** The Runtime and Profile persistence experiment and the shared Chromium experiment passed. The owner approved starting Runtime work while carrying the browser limitations forward. The held mouse button failure in Selkies and the missing native Sidebar operations remain unresolved; this decision does not turn either result into a pass.

| Gate | Status | Evidence |
| --- | --- | --- |
| A — Runtime and Profile | Pass for the tested packages and upgrade pair | [Runtime job](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353929974), [native job](https://github.com/sagehou/dsh-workstation/actions/runs/44460118655/job/135344573520) |
| B — Shared Chromium | Pass for the pinned stack and fixture | [Shared tabs, same-origin routing and profile restart](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353930294) |
| C — Exclusive | Agent lease and drain passed in the fixture; Human-to-Agent handover blocked on held input | [Independent Provider evidence](M0-provider-evidence.md#observed-result) |
| D — DSH plugin API | Browser tool calls were gated through official MCP in ACP; native floating maximize/restore remains blocked | [Sidebar lifecycle job](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353930328) |

## Exact upstream versions

- The official [npm metadata](https://registry.npmjs.org/@deepseek-ai%2fdsh) reports `latest=0.2.2-rc.1`, `next=0.2.2-rc.5`, and `alpha=0.2.2-alpha.3`. `latest` is still a release candidate. Both tested packages declare Node `>=24.9.0` and the `dsh` bin at `lib/bin.js`. Exact source: [`dsh-v0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db), [`dsh-v0.2.2-rc.5`](https://github.com/deepseek-ai/deepseek-harness/tree/9c2670d3bce5275e0d1610272958121af87787bb).
- Runtime base: `node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54`, pnpm `11.28.5`, Git `2.39.5` in the observed Runtime build, UID `1000`. Native fixture: `node-pty@1.2.0-beta.15`, `node-gyp@11.5.0`, using the Node headers shipped with the base.
- Browser: `lscr.io/linuxserver/chromium:075b0b99-ls64@sha256:6d2a8da6a45d4083a7287211a619ca29fdb518ebea0ef562c27392ba2f6698d2`, Chromium `156.0.8078.79` and CDP protocol `1.3`. The official registry's `linux/amd64` manifest is `sha256:995fa4a4278d8ee90a13c33e983c45606aec8bd69bf6236b7c68cf07c89d16f4`. Its config labels identify [the Chromium scripts](https://github.com/linuxserver/docker-chromium/tree/4ec00555069627093b9110daff841d363f9a95f8/root), and its build history identifies [baseimage-selkies `debiantrixie-60ce2ea6-ls152`](https://github.com/linuxserver/docker-baseimage-selkies/releases/tag/debiantrixie-60ce2ea6-ls152) with [Selkies `2.2.1`](https://github.com/selkies-project/selkies/tree/d6b9351421bd503ffa89bdee78e2bce758b1ffe5), Pixelflux `2.2.3`, and PCMFlux `2.2.1`.
- Edge and driver: `traefik:v3.7.19@sha256:a6c0194dda77bcb804824580f36fa7edc56e315b1acfe933366c8b52844a78a4`, `mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48`, `playwright@1.61.1`. This Playwright package is the test driver; the DSH Browser Use provider is a separate `0.2.2-rc.1` package using `@playwright/mcp@0.0.80`.

Read-only commands to recheck release metadata:

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

Use a disposable remote Docker host with a fresh checkout and no existing DSH or Chromium volumes. The [workflow](../../.github/workflows/m0.yml) runs on GitHub Actions `ubuntu-24.04` for pushes to `m0/issue-1` that change an experiment or the workflow. The runs above report Docker `28.0.4` and Compose `2.38.2`. The scripts use isolated Compose project names and remove their test volumes. Keep DSH startup URLs, tokens and cookies out of logs.

The [final run at `93a31de`](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576) passed all four experiment jobs below. The separate native build was skipped. The run verifies the assertions implemented in the probes; the remaining C and D acceptance criteria are still blocked.

```sh
# Gate A — Runtime and Profile.
bash prototypes/m0/runtime/run.sh

# Gate B and the human input part of Gate C.
bash prototypes/m0/browser/run.sh
bash prototypes/m0/browser/run.sh --exclusive

# Gate D — Sidebar fixture.
bash prototypes/m0/browser/sidebar/run.sh
```

The separate native job was explicitly approved for one remote build. Its recorded command at [`058e789`](https://github.com/sagehou/dsh-workstation/commit/058e789) was:

```sh
docker compose -f prototypes/m0/runtime/compose.yml run --build --rm --no-deps -T runtime bash /m0/native.sh
```

Any repeat of that native build requires separate approval. The job installed dependencies with `--ignore-scripts`, removed the `node-pty` prebuilds, then ran the pinned `node-gyp` rebuild as UID `1000`. Output: `gyp info ok` and `source-built node-pty emitted expected PTY output as uid 1000`. The assertion checks that the loaded module is `build/Release/pty.node`. This was a standalone PTY check, not a general plugin lifecycle approval or a test of DSH's Web terminal.

## A — Runtime and Profile

The official [CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/apps/cli/reference/README.md) and [Plugin Manager reference](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/plugin-manager/README.md) describe the contract exercised here. `dsh web --no-open --port 0` initializes the shipped Web Profile as needed. It announces a launch URL after startup; the probe exchanges that URL for a cookie and asserts an authenticated HTTP 200 boot page. `--host 0.0.0.0` is rejected by these releases; the intentional failure uses that real startup path. For later reverse proxy work consult the [Web app bind, Host/Origin and session rules](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/web-app/README.md#public-deployments).

`dsh plugin --profile web add` calls the official package operations with pnpm; the PoC uses `--save-exact --ignore-scripts --ignore-workspace-root-check`. The npm fixture was `@deepseek-ai/dsh-experimental-badge-skill-bundle@0.2.2-rc.1`. The Git HTTPS fixture was `git+https://github.com/sagehou/dsh-workstation.git#8a1d8c03ff3e2f94abc82792ed0771bc82b6fb63&path:/prototypes/m0/runtime/fixture`. Saved dependencies are distinct from enabled `dsh.profile.bundles`, and enabled is distinct from a successfully loaded bundle. The Git fixture writes a fresh startup marker in each health run so the test does not infer activation from installation alone. Bundle layers load before the Profile patch, the home patch and CLI overlays, in that order. The in-box bundles resolve from the selected DSH install; external bundles resolve from the Profile when not provided by the installation.

The Plugin Manager service supplies the Web Plugins page and the `plugin_manager` tool. Its documented `inspect`, `installBundle`, and `listBundles` operations distinguish source metadata, package installation and activation. With Profile HMR, changes can apply live; startup-only profiles can require restart. The [compatibility contract](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/plugin-manager/README.md#version-compatibility-and-exemptions) checks declared `engines.dsh` and DSH peer ranges. Git metadata is checked after fetching; a rejected operation can leave downloaded files in the store. Exact-version exemptions live in the Profile's `compatibility.json`, separate from dependency script approval. The recorded tests exercised the CLI, with no exemptions or script grants.

| Path in the Runtime container | Owner and evidence |
| --- | --- |
| `/dsh-home/runtime/versions/<version>` and `/dsh-home/runtime/current` | PoC only. Staging and atomic symlink updates under `flock`; `current` is the active pointer. |
| `/dsh-home/profiles/web/package.json`, `cordis.patch.yml`, `compatibility.json` | Upstream dependency and ordered bundle manifest; Profile overlays; optional exact compatibility exemptions. Manifest and patch digests matched before/after recreation and in both directions of the version switch. |
| `/dsh-home/profiles/web/pnpm-lock.yaml`, `pnpm-workspace.yaml`, `node_modules/.pnpm` | Plugin lock, PoC store and script policy, and resolved package links. Both fixture package manifests/patches and link destinations matched. |
| `/dsh-home/pnpm/store/v11` | Chosen store path, not an upstream default. pnpm reported content-addressable store hardlinks; store membership fingerprint matched across recreation. |
| `/dsh-home/cordis.patch.yml`, `.credentials.yaml`, `sessions/`, `storages/` | Upstream home overlay and data from the [base profile](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/base/cordis.patch.yml). Kept on the same volume; actual credentials, saved conversation migration and restore were not exercised. |
| `/workspace`, `/backup` | Separate volumes. The PoC snapshots DSH_HOME before Profile dependency changes or version switches. |

The [passing Runtime job at `5686d9e`](https://github.com/sagehou/dsh-workstation/actions/runs/44460212791/job/135344880883) shows:

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

The store and locked plugin dependencies are preserved without reinstalling after recreation. The two releases both booted this Profile and loaded the Git fixture without dependency edits. Pointer rollback cannot reverse a data migration. The tests do not establish compatibility for every plugin, prove native builds inside Plugin Manager, approve Git `prepare` scripts, or cover plugins with extra system libraries. In the official manager, reviewed dependency scripts can be approved by exact pending `allowBuilds` keys per Profile; broad approval is outside this test.

## B — One browser process and profile

LinuxServer's [`autostart_wayland`](https://github.com/linuxserver/docker-chromium/blob/4ec00555069627093b9110daff841d363f9a95f8/root/defaults/autostart_wayland) passes `CHROME_CLI` to [`wrapped-chromium`](https://github.com/linuxserver/docker-chromium/blob/4ec00555069627093b9110daff841d363f9a95f8/root/usr/bin/wrapped-chromium). The probe uses `/config/m0-chromium` and CDP port `9222`. A relay in the same network namespace forwards to the loopback listener from an isolated Docker bridge only. There are no published host ports. The browser job tests host access and uses `/json/version` and `/json/list` from a peer.

At [`d71856d`](https://github.com/sagehou/dsh-workstation/actions/runs/44461308475/job/135348481161), a keystroke through the human Selkies UI opened a tab discovered over CDP and set a persistent test cookie in Playwright's existing default context. A Playwright-created tab then accepted Selkies input and saw the same cookie. The job counted one Chromium main process, verified the command line and profile path, and checked for the cookie on disk before restart. The test uses a separate headless viewer to drive Selkies; only the managed desktop Chromium is the target of both users. The passing job reported:

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

Earlier runs failed on the post-restart cookie assertion ([`496a285`](https://github.com/sagehou/dsh-workstation/actions/runs/44459609588/job/135342898428)) and on UI keyboard navigation before persistence was reached ([`5686d9e`](https://github.com/sagehou/dsh-workstation/actions/runs/44460212791/job/135344880671)). The passing probe waits for an actual video frame and uses a focused link in the initial Chromium tab so the proof does not depend on the viewer forwarding several browser shortcuts in sequence.

Traefik kept `/browser/` unchanged using LinuxServer `SUBFOLDER=/browser/`; the [bundled Nginx template](https://github.com/linuxserver/docker-baseimage-selkies/blob/6379480bcbd4ba42c1f5d4ab5eca49304fdedf83/root/defaults/default.conf) expects the prefix and proxies its API to Selkies. The same fixture ForwardAuth denied unauthenticated app and `/browser/` API requests, and the authenticated same-origin iframe streamed over WebSocket. Traefik explicitly sets `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`; a second HTTPS origin on the same site was refused by the browser's frame policy. The app route used a fixture, so this does not establish single sign-on with DSH's own launch-token exchange or production Auth behavior.

The attachment uses `browser.contexts()[0]`, not a newly isolated context. The successful probes disconnected and returned to the running desktop. Do not grant Agent operations that shut down the external browser/context. Full CDP parity, download persistence and recovery after a provider disconnect are outside the observed results.

## C — Exclusive control

Selkies `2.2.1` documents [`SELKIES_MASTER_TOKEN` and `POST /api/tokens`](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/docs/secure-mode.md). Its [input authority rule](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/src/selkies/sessions.py#L62) is used by both transports. This experiment forces WebSocket transport. It sends keyboard and mouse frames directly and checks event counts in the CDP target; the server verdict alone is insufficient. The same connected socket delivered input before and after the lock. During the lock, event counts stayed unchanged while new video arrived. The passing run at `d71856d` reported:

```text
Selkies server denied raw keyboard and mouse frames while the same socket received new video
restoring the token table re-enabled keyboard and mouse on the existing socket
```

At [`5686d9e`](https://github.com/sagehou/dsh-workstation/actions/runs/44460212791/job/135344880925), the job stopped with `Selkies secure-mode control plane unavailable`. The passing fixture uses a one-line Compose secret with no trailing newline and adds status-only diagnostics. It keeps the token administration route off the Traefik browser router. WebRTC, alternate input/device paths, held key/button state across handover, and fail-closed behavior across Selkies restart still need evidence as applicable to the final integration.

The unsecured CDP relay in Gate B is for the experiment only. The official DSH [Browser Use Playwright MCP provider](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/experimental/browser-use-playwright-mcp/README.md) documents `mode: attach` and `endpoint`. Its Session reservation is local to the provider instance. The shared `ctx.browserUse` service only registers a provider; there is no shared action interception API. DSH's public [`ctx.tools.guard`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/tools.md#ctxtools--tools) can veto tool admission; the [pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/pipeline.ts#L213) checks it before dispatch. A guard in DSH does not enforce a lease on direct CDP reachable from the Agent's execution environment.

The approved [independent Provider experiment](M0-provider-evidence.md) used DSH's documented [Streamable HTTP MCP integration](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/mcp.md) in its ACP profile. Only the Provider could reach private CDP. Lease admission, takeover drain, expiry, concurrency, stale generations and DSH, Chromium and Provider process loss/restart passed in the fixture. The job failed the held pointer assertion: a mouse-down before the grant remained in effect until input authority returned to HUMAN. Gate C needs a supported way to quiesce and release already accepted input before granting Agent control.

## D — Native Sidebar lifecycle

The exact [Sidebar docs](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/sidebar-right.md) and [client module contract](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/client-modules.md) identify `dsh.client`, the `./client` bundle export, `ctx.sidebarRightTabs.register`, the `sidebar.right.pane.tab` slot, and `keepMounted`. The probe installs a local Bundle through Plugin Manager and uses those public services. Its tiny client artifact uses the documented bundled format produced by the [pinned upstream preset](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/tsdown.client.ts#L1-L12). The frame is a same-origin response fixture, not the live Selkies UI. It uses a load count and a value inside the iframe as witnesses of its browsing context, rather than only checking that an iframe element still exists.

The [public service](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/service.ts#L249-L298) has `float` and `dock`. The floating [header and resize handle](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-dockkit/src/components/FloatLayer.tsx#L311-L345) provide native drag, resize and dock UI, without a floating maximize/restore operation. Fullscreen applies to the [docked column](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx#L273-L292). The documented [`hide` implementation](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/service.ts#L577-L585) closes a floating tab. `keepMounted` does not make a closed tab survive. Closing an iframe is distinct from stopping the separate Chromium container. The corresponding service and float header in [`0.2.2-rc.5`](https://github.com/deepseek-ai/deepseek-harness/tree/9c2670d3bce5275e0d1610272958121af87787bb/packages/client) have the same limits.

The diagnostic run [`f4cd89a`](https://github.com/sagehou/dsh-workstation/actions/runs/44462375518/job/135351996893) reported `web boot: 1 entry did not activate` (`dsh-m0-sidebar-probe: failed`). The subsystem summary presents a `guide` entry's fields; the published [`SidebarRightTabDefinition`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/tab-registry.ts#L61-L137) requires `guide?: readonly SidebarRightGuideEntry[]` with an `id` per entry. Both the npm `./client` declaration and the registry implementation confirm the array form. After that correction and a fix to the conversation locator, the [remote Sidebar job at `93a31de`](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353930328) ran the fixture against the actual npm Web app. A loopback model fixture settled the session with no DeepSeek account:

```text
npm DSH loaded the external client plugin through its Profile bundle
iframe retained across tab selection and docked hide/show
iframe retained across native float, resize and dock
iframe retained across docked fullscreen and restore
upstream floating hide closes the tab; its iframe does not survive
```

The agreed native floating lifecycle waits for upstream support. The standalone Provider demonstrated gated browser tool calls through official MCP in ACP without DSH core changes. Neither the official Playwright MCP Browser Use package nor credential binding to Web Profile sessions was validated under a lease.

Evidence collected 2026-11-19 UTC. These experiments are disposable and are not production deployments.
