# Public Compose

English · [简体中文](README.zh-CN.md)

[Network addresses](#network-addresses) · [Install](#install) · [Use the browser](#use-the-browser) · [Maintain](#maintain) · [Back up and restore](#back-up-and-restore)

## Before you start

- Use a **Linux amd64** host with rootful Docker Engine 28+ and Compose v2. Use a non-root user with Docker access. No registry credential is needed: the workstation images are public.
- The release publishes `linux/amd64` only. Do not run it on another architecture.
- Point **DNS** at the Traefik host. Traefik serves public ports 80 and 443 and manages the certificates.
- Use **Traefik** already running on the same Docker host. Identify its trusted Docker network, HTTPS entrypoint, certificate resolver, and the directory watched by its file provider. You do **not** have to upgrade Traefik: CI pins and exercises `v3.7.14` and `v3.7.19` through the same full stack. [Compatibility matrix](../../docs/roadmap/public-compose.md#traefik-compatibility-matrix) records which versions have a passing run.
- Check that neither **Docker subnet** overlaps your host routes. `bash deploy/network.sh check` does this and refuses to continue on a conflict. See [Network addresses](#network-addresses).

## Network addresses

The two Compose networks and every address inside them come from one place:
`deploy/network.sh`. Nothing has to be edited by hand, and the initializer
refuses to run when the plan conflicts with the host.

| Setting | Default | Used for |
| --- | --- | --- |
| `WORKSTATION_SUBNET` | `172.30.241.0/24` | Runtime, Provider and Gateway on the internal network. |
| `BROWSER_SUBNET` | `172.30.233.0/24` | Chromium and the Provider's control listener. |

Static addresses are derived from each subnet: `.2` is the Runtime on the
workstation network and the Provider on the browser network, and `.3` is the
Provider on the workstation network. Dynamic allocation is confined to the
upper half, so a container that starts first can never take a static address.

Check the plan against the host before starting anything:

```bash
bash deploy/network.sh check
```

It reports three things, and creates or changes nothing:

- a subnet that overlaps a **host route** (a VPN route is the common case);
- a subnet that overlaps an **existing Docker network**;
- an invalid CIDR, a prefix outside `/16`..`/28`, or a CIDR with host bits set.

If it fails, pick two unused RFC1918 ranges and pass them to the initializer:

```bash
WORKSTATION_SUBNET=10.71.241.0/24 BROWSER_SUBNET=10.71.233.0/24 \
  bash deploy/public/init.sh <domain> <proxy> <traefik>
```

The Runtime certificate is issued for the derived address, so re-running the
initializer with different subnets is refused rather than silently reissuing
the internal CA that every service trusts. `--reissue` performs that change
deliberately; it replaces the CA and the Runtime certificate, keeps the other
secrets, and requires recreating the containers so they take their new
addresses.

## Install

Run these steps in order on the deployment host, in the same shell.

### 1. Check out the release and confirm the pinned images

The four images this repository builds are published to GHCR as **public**
packages, so a deployment needs no `docker login` and no credential on the host.

`deploy/public/images.env` records the manifest-list digest for each image.
`deploy/public/images.sh` resolves those digests into
`name:version@sha256:...` references and refuses to run if a digest is missing,
so there is no path from this file to a floating tag.

```bash
gh repo clone sagehou/dsh-workstation && cd dsh-workstation
release_tag='v0.2.0'
git switch --detach "$release_tag"

# Print the references this release deploys. Every line must end in @sha256:.
bash deploy/public/images.sh
```

To satisfy yourself that a digest still names the same image, compare it
against what the registry reports. The value must match exactly:

```bash
docker buildx imagetools inspect ghcr.io/sagehou/dsh-workstation-runtime:0.2.1 \
  --format '{{json .Manifest.Digest}}'
```

Pulling happens when Compose starts: each image is already referenced by digest
in `.env.public` after step 2. Provenance and SBOM attestations are attached to
those digests, so they travel with the image rather than depending on a workflow
run staying available.

> A tag without a digest is a mutable reference and is never written by the
> initializer. If you need a one-off build from source, omit `--release` in step
> 2 and Compose builds locally instead — the two modes are explicit.

### 2. Set the domain and Traefik values

Replace the example values below. The initializer records Traefik's IPv4 address on the chosen network and generates the routes file. Set `WORKSTATION_TRAEFIK_RESOLVER=''` if the HTTPS entrypoint already provides a certificate.

```bash
domain='workstation.example.net'
proxy='proxy'
traefik='traefik'
traefik_dynamic='/srv/traefik/dynamic'

WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
  bash deploy/public/init.sh "$domain" "$proxy" "$traefik" --release
```

`--release` makes the initializer resolve the published digests and write them
into `.env.public` as `WORKSTATION_RUNTIME_IMAGE`, `WORKSTATION_GATEWAY_IMAGE`,
`WORKSTATION_PROVIDER_IMAGE` and `WORKSTATION_GATE_IMAGE`. Without it, the same
keys are written as local build tags. Either way the file names exactly what
runs, and re-running the initializer replaces the keys rather than appending a
second copy.

#### Existing deployment

Before this change the subnets were fixed in `compose.yml`, so an existing
`.env.public` has no `WORKSTATION_SUBNET` or `BROWSER_SUBNET`. The defaults are
the same addresses, so re-running the initializer with no overrides keeps the
existing certificate valid and only records the derived keys:

```bash
WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
  bash deploy/public/init.sh "$domain" "$proxy" "$traefik" --release
docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 360
```

Nothing is reissued and no container is recreated with a different address. The
images do change: an existing deployment that loaded a local archive switches to
the digest-pinned GHCR references on the next `up`. If
you *do* want different addresses, that is a migration: back up, re-run with
`--reissue`, recreate every service, and reconnect Traefik to the (recreated)
`dsh-workstation_workstation` and `dsh-workstation_browser` networks.

### 3. Create the administrator

```bash
docker compose --env-file .env.public run --rm --no-deps gateway-admin bootstrap admin
```

1. Set the password.
2. Add the displayed TOTP key to your authenticator and enter the current code.
3. Save the displayed recovery codes offline. Bootstrap closes after the first account is created.

## Choose a deployment shape

Two shapes run from the same `compose.yml`. Pick one before step 3.

| Shape | Services | Use it when |
| --- | --- | --- |
| **full** (default) | `gateway`, `runtime`, `browser-gate`, `chromium`, `cdp-relay`, `provider` | You need the shared browser: the operator's `/browser/` page, or Agent browser tools. |
| **core** | `gateway`, `runtime` | The host cannot carry the browser stack, or Agent browser control is not approved yet. |

`core` is a deliberate restriction, not an equivalent substitute. With it you
have **no `/browser/` page and no Agent browser tools**. DSH itself — chat,
sessions, terminal, plugins, file editing — is unaffected, because it is served
by the Runtime, not by Chromium.

### Why the browser stack is expensive

`chromium` reserves `shm_size: 1gb` (`compose.yml:162`), which is tmpfs and comes
straight out of host memory. Add the Chromium process tree, Selkies, the Provider
and the input gate and the browser stack is roughly 2 GiB of resident memory and
one to two cores while a video stream is being encoded. A 2 GiB host cannot run
it alongside the rest.

### Running core

```bash
docker compose --env-file .env.public \
  -f compose.yml -f deploy/public/compose.core.yml \
  up -d --no-build --wait --wait-timeout 420
```

The override file assigns every browser service the `browser` profile, so
Compose does not start them, and sets `WORKSTATION_BROWSER_MCP=0` so the Runtime
does not install the browser Bundle into the Web Profile. It also sets
`GATEWAY_BROWSER_ENABLED=0`, which makes `/browser/` and `/_auth/browser` answer
`503 The browser is not part of this deployment` rather than proxying to an
address nothing listens on.

Use the same `-f` pair for every later `compose` command in this guide,
including `down`, `logs` and `run`. A plain `docker compose up` after a core
deployment will try to start the full stack on a host that cannot hold it.

### What core does not verify

`core-shape` in CI proves only that `gateway` and `runtime` start, that the browser
Bundle is absent, and that `/browser/` refuses through the core path. It does not
prove the full stack works on your host, and it is not a substitute for the
`full` legs. Neither shape has been run on a 2 GiB machine; the memory figures
above are an estimate from the configured limits, not a measurement.

### 4. Start Compose and add the routes

Connect Traefik once to each workstation network. The routes file goes in the host directory watched by Traefik.

```bash
docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 360 &&
  docker network connect dsh-workstation_workstation "$traefik" &&
  docker network connect dsh-workstation_browser "$traefik" &&
  install -m 0644 .workstation/edge/routes.yml "$traefik_dynamic/.dsh-workstation.tmp" &&
  mv "$traefik_dynamic/.dsh-workstation.tmp" "$traefik_dynamic/dsh-workstation.yml" &&
  docker compose --env-file .env.public ps
```

### 5. Sign in

1. Open `https://<domain>/`.
2. Sign in as `admin` with the password and a fresh TOTP code. The enrollment code has already been used.
3. Set the DeepSeek API key in DSH **Settings → Models**.
4. Optionally register a Passkey at `/_auth/account`. You can then use the separate Passkey login.

## Use the browser

> **Release gate:** The standalone browser/control page is the supported first-release UI. Do not enable Agent browser control in a production deployment until [#4](https://github.com/sagehou/dsh-workstation/issues/4) passes the held-input release and exclusive-handoff acceptance tests. Keep broad browsing of untrusted sites disabled until [#11](https://github.com/sagehou/dsh-workstation/issues/11) passes the independent egress-policy tests. `BROWSER_TOOL_ORIGINS` alone is not an egress firewall or complete SSRF protection.


| To | Open or choose |
| --- | --- |
| Open the shared Chromium desktop | `/_auth/browser` opens same-origin `/browser/` through the workstation login. |
| Let an Agent use a tab | An Agent can acquire an available lease through `lease_status`. You can also grant a lease in `/mgmt/browser` for up to 120 seconds. Before granting control, `browser-gate` confirms it released held input. |
| Take over | Choose **接管浏览器**. The Provider stops new calls, lets the current call finish, and returns control. |
| Allow specific websites | Set `BROWSER_TOOL_ORIGINS` in `.env.public` to comma-separated exact HTTPS origins such as `https://www.example.org,https://docs.example.com`. Recreate the Provider. |

The Agent gets its generation with `mcp__browser__lease_status` before calling `navigate`, `read`, or `click`. Another DSH session cannot change that lease by calling tools. A configured allowlist limits those tools and the page text they return. Chromium still handles scripts and redirects normally, and tabs share cookies. Use trusted origins.

For a lost connection or tab, create a new DSH session and grant it a lease. To keep the conversation, restart Runtime, resume the conversation, and grant a new tab in the same Chromium profile.

### The input gate

`browser-gate` sits between the login proxy and the Chromium data socket, and it is the only path that carries input. The pinned Selkies decides input authority per frame against its live token table and installs a new table *before* announcing the change, so a release frame sent after a revocation is dropped. That is why a mouse button held at handoff used to stay down for the whole Agent lease. The gate releases held input with Selkies' own `reset_keyboard()` and `release_mouse_buttons()` primitives *before* the Provider takes authority, and waits for the upstream to acknowledge the frames. If it cannot, it closes that socket while it still holds authority so Selkies releases on the departure path, and the lease is refused.

Check it without touching the browser:

```sh
docker compose exec -T provider node --input-type=module -e '
  const s = require("node:fs").readFileSync("/run/secrets/gate_control", "utf8").trim()
  const r = await fetch("http://dsh-workstation-browser-gate:8082/status", {
    headers: { Authorization: "Bearer " + s },
  })
  console.log(await r.json())
'
```

`state` is `OPEN` only while you hold authority, and `RELEASING` while a handover is proving its release. A `POST /handover` returns `released: true` only after the upstream acknowledged the release. [ADR-0005](../adr/0005-release-held-input-at-selkies.md) records the ordering evidence.

## Maintain

Open `/mgmt` to check Runtime status and versions, create or verify a DSH_HOME backup, manage the single account, and hand off browser control. Backups and archive checks require verification within the last five minutes. Stop Runtime to upgrade, roll back, restore, or make a quiescent migration backup. [Runtime maintenance](../README.md#upgrade-and-rollback)

### Traefik

- To retain the two workstation networks across Traefik recreation, declare them as external networks in Traefik's Compose.
- If Traefik's IP on the proxy network changes, rerun the initializer with the same domain, entrypoint, and resolver. Then run `docker compose --env-file .env.public up -d --no-build gateway`.

### Browser recovery

If the Provider cannot confirm that a pending browser operation ended, it rejects new grants to that Chromium process. Recreate Chromium and the relay on the same profile volume and keep the configured hostname.

```bash
docker compose --env-file .env.public up -d --no-build --force-recreate chromium cdp-relay
```

The Provider tries to reconnect automatically. If the control page still shows `DISCONNECTED` after Chromium is ready, choose **连接浏览器**.

### Account and sessions

| Setting in `.env.public` | Default |
| --- | --- |
| `GATEWAY_IDLE` | 30 minutes |
| `GATEWAY_ABSOLUTE` | 12 hours |
| `GATEWAY_MAX_SESSIONS` | 8 |

- HTTP requests and new WebSocket handshakes refresh the idle timer. Open DSH and Selkies WebSockets check the session every two seconds and close on expiry or revocation.
- Revoke one or all sessions at `/mgmt/account`. After five minutes, use a fresh TOTP code to authorize sensitive changes.
- To disable or enable the account from the host, replace `bootstrap admin` in the administrator command with `disable` or `enable`. Both commands invalidate current sessions.

### DSH versions

On first start, Runtime installs official DSH `0.2.2-rc.1`. The official Plugin Manager adds the Workstation Bundle to the persistent Web Profile. Package lifecycle scripts stay disabled during Runtime and Profile installation. The Bundle uses the verified DSH version.

Back up DSH_HOME before changing a Profile or version. Run the Runtime maintenance commands against the public Compose with `--env-file .env.public`. A version rollback changes the selected install. Restoring migrated data requires a matching backup. [Runtime maintenance](../README.md#upgrade-and-rollback)

### Replace the original standalone stack

1. Use `down` from the old checkout. Keep the named volumes, `.env.public`, and `.workstation/`.
2. Load the new images and rerun the initializer with the same domain.
3. Skip admin bootstrap and start the new Compose.

### Migrate from the `auth` service

1. Confirm the destination release resolves all four digests with `bash deploy/public/images.sh`. Back up the stopped `auth-data` volume and `.workstation/`, then run `docker compose --env-file .env.public down` with the old Compose files and the same project name. Omit `-v`.
2. Switch to the destination release in the same deployment. Run the initializer with the saved domain, state path, external proxy network and Traefik options. Install the regenerated `routes.yml` over Traefik's existing Workstation route file so it points to `dsh-workstation-gateway-edge`.
3. Start the stack with `up -d --no-build --wait`. `gateway` opens the existing `auth-data` SQLite volume with the saved `auth-key`. Confirm your existing login, `/mgmt`, and `/browser/` in a full deployment.

`GATEWAY_IDLE`, `GATEWAY_ABSOLUTE`, and `GATEWAY_MAX_SESSIONS` take precedence over their `AUTH_*` predecessors. For rollback, stop the new stack, return to the old checkout, and regenerate the old image references and Traefik routes with that checkout's initializer. The old published `dsh-workstation-auth` image remains available for that release.

If the old hostname left a browser profile lock, confirm that the old Chromium has stopped before removing the `SingletonLock`, `SingletonSocket`, and `SingletonCookie` symlinks in `/config/chromium` on the profile volume. [Chromium profile locking](https://github.com/chromium/chromium/blob/156.0.8078.79/chrome/browser/process_singleton_posix.cc)

### Upgrading and rolling back

An upgrade is a change of digests. Back up first, then switch the references and
recreate the affected services; Compose pulls the new digests on `up`:

```bash
git switch --detach v0.3.0
WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
  bash deploy/public/init.sh "$domain" "$proxy" "$traefik" --release
docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 360
```

A rollback is the same operation with the older tag: check out `v0.2.0`, re-run
the initializer to restore the older digests, and `up` again. Because the
references are digests, the earlier images are still exactly what that tag
published — an upstream tag cannot have moved under you.

Runtime version rollback is separate and does not touch these images: see
[Runtime maintenance](../README.md#upgrade-and-rollback). Image rollback and data
rollback are different operations, and a DSH_HOME migration needs a matching
backup.

The Actions artifacts the Public Compose workflow uploads remain available for
90 days as audit evidence of what CI ran. They are no longer the distribution
channel. [Workflow](../../.github/workflows/public-compose.yml)

## Back up and restore

| Keep | Why |
| --- | --- |
| `.workstation/`, backed up separately from SQLite | TOTP encryption key, service credentials, and internal TLS keys. Keep the existing directory when reinstalling. |
| Named volumes `dsh-home`, `workspace`, `browser-profile`, `auth-data`, and `provider-state` | DSH, Chromium, Gateway SQLite, and Provider state. Stop Compose before taking snapshots. |

To back up Gateway's SQLite data, archive the stopped `auth-data` volume to a private location.

```bash
docker compose --env-file .env.public stop && (
  umask 077
  # Use the image reference the deployment itself is pinned to.
  set -a; . ./.env.public; set +a
  docker run --rm --network none --user 0:0 --entrypoint tar \
    -v dsh-workstation_auth-data:/data:ro "$WORKSTATION_PROVIDER_IMAGE" \
    --numeric-owner -C /data -cf - . > auth-data.tar
)
```

Restore into an empty `auth-data` volume with the stack stopped. Use the matching `.workstation/secrets/auth-key`, preserve numeric owners and modes, and keep the public domain for Passkeys. The Runtime generates fresh launch URLs.

Only Traefik publishes ports. The desktop opens in its own tab while native Sidebar and release of held input during handoff are tracked in [#1](https://github.com/sagehou/dsh-workstation/issues/1). [Test evidence](../../docs/roadmap/public-compose.md)
