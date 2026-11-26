# Public Compose

English · [简体中文](README.zh-CN.md)

[Network addresses](#network-addresses) · [Deployment shapes](#choose-a-deployment-shape) · [Install](#install) · [Use the browser](#use-the-browser) · [Maintain](#maintain) · [Back up and restore](#back-up-and-restore)

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
| `BROWSER_SUBNET` | `172.30.233.0/24` | Chromium, the input gate and the Provider's control listener. |

Static addresses are derived from each subnet. The Runtime uses `.2` and the
Provider uses `.3` on the workstation network. The Provider and input gate use
`.2` and `.4` on the browser network. Docker assigns dynamic addresses from the
upper half so it cannot allocate a static service address while starting containers.

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
  bash deploy/public/init.sh workstation.example.net proxy traefik
```

The Runtime certificate is issued for the derived address, so re-running the
initializer with different subnets is refused rather than silently reissuing
the internal CA that every service trusts. `--reissue` performs that change
deliberately; it replaces the CA and the Runtime certificate, keeps the other
secrets, and requires recreating the containers so they take their new
addresses.

## Choose a deployment shape

| Shape | Workstation containers | Services |
| --- | ---: | --- |
| **core** | **2** | `gateway`, `runtime` |
| **full** (default) | **6** | `gateway`, `runtime`, `chromium`, `provider`, `cdp-relay`, `browser-gate` |

Both shapes reuse the existing Traefik. Including that container brings the totals to 3 and 7. Run `gateway-admin` and `maintenance` on demand with `docker compose run --rm --no-deps`.

Core serves DSH and Gateway with `WORKSTATION_BROWSER_MCP=0` and `GATEWAY_BROWSER_ENABLED=0`. With a valid session, `/browser/` and `/_auth/browser` return 503. Full adds the shared browser. Chromium's `shm_size: 1gb` sets the shared-memory limit. The memory use of either shape on a 2 GiB host still needs a measurement. [Core integration check](../../docs/roadmap/public-compose.md#gateway-candidate-verification)

Set `COMPOSE_FILE` from the checkout root and keep it for every Compose command in this deployment. Full uses the base file.

```bash
export COMPOSE_FILE=compose.yml
```

Core adds the override file.

```bash
export COMPOSE_FILE=compose.yml:deploy/public/compose.core.yml
```

When moving an existing full deployment to core, run `down` with the full configuration first and keep the named volumes.

## Install

Run these steps in order on the deployment host, in the same shell.

### 1. Select a deployment commit

For a published install, use the deployment commit recorded in `deploy/public/release-commit`. The current commit is `81feffd`, where the service is `auth` and its one-off administrator command uses `auth-admin`. In your clone, check it out and verify that all four references resolve.

```bash
git switch --detach 81feffdb5607a28062d03f443d6ff47aeb206665 &&
  bash deploy/public/images.sh
```

Continue from step 2 in that commit's guide. [Published deployment instructions](https://github.com/sagehou/dsh-workstation/blob/81feffdb5607a28062d03f443d6ff47aeb206665/deploy/public/README.md#2-set-the-domain-and-traefik-values)

The remaining steps here are for Gateway checkouts. From a checkout with published Gateway digests, run `bash deploy/public/images.sh` to verify all four references before using `--release`. This Gateway candidate has local build references available through `bash deploy/public/images.sh --local`. [Release status](../../docs/release.md#current-deployment)

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

`--release` writes the four digest-pinned references to `.env.public`. For a
source build, omit `--release` to select local image names, then build the images
before bootstrapping the account.

```bash
docker compose --env-file .env.public build
```

#### Existing deployment

Re-run the initializer with the original domain, state directory and subnets to
preserve credentials and certificates. Skip account bootstrap for an existing
administrator. [Auth migration](#migrate-from-the-auth-service)

### 3. Create the administrator

```bash
docker compose --env-file .env.public run --rm --no-deps gateway-admin bootstrap admin
```

1. Set the password.
2. Add the displayed TOTP key to your authenticator and enter the current code.
3. Save the displayed recovery codes offline. Bootstrap closes after the first account is created.

### 4. Start Compose and add the routes

Connect Traefik once to the workstation network after the services start.

```bash
docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 420 &&
  docker network connect dsh-workstation_workstation "$traefik"
```

For full, also connect Traefik once to the browser network.

```bash
docker network connect dsh-workstation_browser "$traefik"
```

Install the routes in the directory Traefik watches. Use `ps` to check the running services.

```bash
install -m 0644 "${WORKSTATION_STATE:-.workstation}/edge/routes.yml" "$traefik_dynamic/.dsh-workstation.tmp" &&
  mv "$traefik_dynamic/.dsh-workstation.tmp" "$traefik_dynamic/dsh-workstation.yml" &&
  docker compose --env-file .env.public ps
```

### 5. Sign in

1. Open `https://<domain>/`.
2. Sign in as `admin` with the password and a fresh TOTP code. The enrollment code has already been used.
3. Set the DeepSeek API key in DSH **Settings → Models**.
4. To use the separate Passkey login, add a Passkey at `/mgmt/account`.

## Use the browser

> **Release gate:** The standalone browser/control page is the supported first-release UI. Do not enable Agent browser control in a production deployment until [#4](https://github.com/sagehou/dsh-workstation/issues/4) passes the held-input release and exclusive-handoff acceptance tests. Keep broad browsing of untrusted sites disabled until [#11](https://github.com/sagehou/dsh-workstation/issues/11) passes the independent egress-policy tests. `BROWSER_TOOL_ORIGINS` alone is not an egress firewall or complete SSRF protection.


| To | Open or choose |
| --- | --- |
| Open the shared Chromium desktop | `/_auth/browser` opens same-origin `/browser/` through the workstation login. |
| Let an Agent use a tab | An Agent can acquire an available lease through `lease_status`. You can also grant a lease in `/mgmt/browser` for up to 120 seconds. Before granting control, `browser-gate` confirms it released held input. |
| Take over | Choose **接管浏览器**. The Provider stops new calls, lets the current call finish, and returns control. |
| Allow specific websites | Set `BROWSER_TOOL_ORIGINS` in `.env.public` to comma-separated exact HTTPS origins such as `https://www.example.org,https://docs.example.com`. Recreate the Provider. |

In the Gateway candidate, the Agent gets its generation with `mcp__browser__lease_status` before calling `navigate`, `read`, or `click`. Another DSH session cannot change an active lease by calling tools. An empty `BROWSER_TOOL_ORIGINS` or `*` permits all HTTPS origins at the tool layer. A configured list limits the tool calls and returned page text. Chromium still handles page scripts and redirects, and tabs share cookies. [Candidate behavior](../../docs/adr/0006-agent-first-browser-and-default-open-origins.md)

For a lost connection or tab, create a new DSH session and grant it a lease. To keep the conversation, restart Runtime, resume the conversation, and grant a new tab in the same Chromium profile.

### The input gate

`browser-gate` sits between the login proxy and the Chromium data socket, and it is the only path that carries input. The pinned Selkies decides input authority per frame against its live token table and installs a new table *before* announcing the change, so a release frame sent after a revocation is dropped. That is why a mouse button held at handoff used to stay down for the whole Agent lease. The gate releases held input with Selkies' own `reset_keyboard()` and `release_mouse_buttons()` primitives *before* the Provider takes authority, and waits for the upstream to acknowledge the frames. If it cannot, it closes that socket while it still holds authority so Selkies releases on the departure path, and the lease is refused.

Check it without touching the browser:

```sh
docker compose --env-file .env.public exec -T provider node --input-type=module -e '
  import { readFileSync } from "node:fs"
  const s = readFileSync("/run/secrets/gate_control", "utf8").trim()
  const r = await fetch("http://dsh-workstation-browser-gate:8082/status", {
    headers: { Authorization: "Bearer " + s },
  })
  console.log(await r.json())
'
```

`state` is `OPEN` only while you hold authority, and `RELEASING` while a handover is proving its release. A `POST /handover` returns `released: true` only after the upstream acknowledged the release. [ADR-0005](../../docs/adr/0005-release-held-input-at-selkies.md)

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

On first start, Runtime installs official DSH `0.2.2-rc.1`. In full, the official Plugin Manager adds the Workstation browser Bundle to the persistent Web Profile. Package lifecycle scripts stay disabled during Runtime and Profile installation. The Bundle uses the verified DSH version.

Back up DSH_HOME before changing a Profile or version. Run the Runtime maintenance commands against the public Compose with `--env-file .env.public`. A version rollback changes the selected install. Restoring migrated data requires a matching backup. [Runtime maintenance](../README.md#upgrade-and-rollback)

### Replace the original standalone stack

1. Use `down` from the old checkout. Keep the named volumes, `.env.public`, and `.workstation/`.
2. Load the new images and rerun the initializer with the same domain.
3. Skip admin bootstrap and start the new Compose.

### Migrate from the `auth` service

1. Confirm the destination release resolves all four digests with `bash deploy/public/images.sh`. Stop the old stack and back up `auth-data` and `.workstation/`. Then run `docker compose --env-file .env.public down` with the old Compose files and the same project name. Keep the volumes.
2. Switch to the destination release in the same deployment. Run the initializer with the saved domain, state path, external proxy network and Traefik options. Install the regenerated `routes.yml` over Traefik's existing Workstation route file so it points to `dsh-workstation-gateway-edge`.
3. Start the stack with `up -d --no-build --wait`. `gateway` opens the existing `auth-data` SQLite volume with the saved `auth-key`. Confirm your existing login, `/mgmt`, and `/browser/` in a full deployment.

`GATEWAY_IDLE`, `GATEWAY_ABSOLUTE`, and `GATEWAY_MAX_SESSIONS` take precedence over their `AUTH_*` predecessors. For rollback, stop the new stack, return to the old checkout, and regenerate the old image references and Traefik routes with that checkout's initializer. The old published `dsh-workstation-auth` image remains available for that release.

If the old hostname left a browser profile lock, confirm that the old Chromium has stopped before removing the `SingletonLock`, `SingletonSocket`, and `SingletonCookie` symlinks in `/config/chromium` on the profile volume. [Chromium profile locking](https://github.com/chromium/chromium/blob/156.0.8078.79/chrome/browser/process_singleton_posix.cc)

### Upgrading and rolling back

An upgrade is a change of digests. Back up first, then switch the references and
recreate the affected services; Compose pulls the new digests on `up`:

```bash
# Set deployment_ref to the commit whose images.env records the destination digests.
git switch --detach "$deployment_ref" &&
  bash deploy/public/images.sh &&
  WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
    bash deploy/public/init.sh "$domain" "$proxy" "$traefik" --release &&
  docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 420
```

Install the regenerated routes as in step 4. For a rollback, repeat the
procedure with the older deployment commit.

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
    -v dsh-workstation_auth-data:/data:ro "$WORKSTATION_RUNTIME_IMAGE" \
    --numeric-owner -C /data -cf - . > auth-data.tar
)
```

Restore into an empty `auth-data` volume with the stack stopped. Use the matching `.workstation/secrets/auth-key`, preserve numeric owners and modes, and keep the public domain for Passkeys. The Runtime generates fresh launch URLs.

Only Traefik publishes ports. The shared desktop opens in its own tab. [Test evidence](../../docs/roadmap/public-compose.md)
