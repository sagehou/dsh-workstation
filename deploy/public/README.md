# Public Compose

English · [简体中文](README.zh-CN.md)

[Network addresses](#network-addresses) · [Deployment shapes](#choose-a-deployment-shape) · [Install](#install) · [Use the browser](#use-the-browser) · [Maintain](#maintain) · [Back up and restore](#back-up-and-restore)

## Before you start

- Use a **Linux amd64** host with rootful Docker Engine 28+ and Compose v2. Use a non-root user with Docker access. No registry credential is needed: the workstation images are public.
- The release publishes `linux/amd64` only. Do not run it on another architecture.
- Point **DNS** at the Traefik host. Traefik serves public ports 80 and 443 and manages the certificates.
- Use **Traefik** already running on the same Docker host. Identify its trusted Docker network, HTTPS entrypoint, certificate resolver, and the directory watched by its file provider. CI pins and exercises `v3.7.14` and `v3.7.19` through the full stack. [Compatibility matrix](../../docs/roadmap/public-compose.md#traefik-compatibility-matrix)
- Check the workstation subnet against host routes and Docker networks. [Network addresses](#network-addresses)

## Network addresses

Runtime, Gateway and Browser share `workstation`. Traefik joins it to reach DSH
and Selkies, and uses its existing proxy network for Gateway and ForwardAuth.

`WORKSTATION_SUBNET` defaults to `172.30.241.0/24`. `deploy/network.sh` derives
Runtime and Gateway MCP addresses at offsets `.2` and `.3`. Docker assigns
dynamic addresses from the upper half of the subnet.

Check the plan against the host before starting anything:

```bash
bash deploy/network.sh check
```

It reports three things, and creates or changes nothing:

- a subnet that overlaps a **host route** (a VPN route is the common case);
- a subnet that overlaps an **existing Docker network**;
- an invalid CIDR, a prefix outside `/16`..`/28`, or a CIDR with host bits set.

If it fails, pass an unused RFC1918 subnet to the initializer:

```bash
WORKSTATION_SUBNET=10.71.241.0/24 \
  bash deploy/public/init.sh workstation.example.net proxy traefik
```

Changing `WORKSTATION_SUBNET` requires `--reissue` to replace the CA and Runtime
certificate. It preserves the other secrets. Recreate the containers to use the
new addresses.

## Choose a deployment shape

| Shape | Workstation containers | Services |
| --- | ---: | --- |
| **core** | **2** | `gateway`, `runtime` |
| **full** (default) | **3** | `gateway`, `runtime`, `browser` |

Both shapes reuse the existing Traefik. Including that container brings the totals to 3 and 4. Run `gateway-admin` and `maintenance` on demand with `docker compose run --rm --no-deps`.

Core runs DSH and Gateway with its browser workers stopped. With a valid session, `/_auth/browser` and the browser data WebSocket return 503. Full starts Provider and the input gate inside Gateway. Browser runs Chromium, Selkies and the CDP relay. Keep `browser/cdp-relay` and `browser/selkies-guard.sh` executable and use them from the same checkout as Compose. [Three-service topology](../../docs/roadmap/public-compose.md#three-service-deployment)

Set `COMPOSE_FILE` from the checkout root and keep it for every Compose command in this deployment. Full uses the base file.

```bash
export COMPOSE_FILE=compose.yml
```

Core adds the override file.

```bash
export COMPOSE_FILE=compose.yml:deploy/public/compose.core.yml
```

When moving an existing full deployment to core, detach Traefik from `dsh-workstation_workstation`, run `down` with the full configuration, and keep the named volumes. Reconnect Traefik in step 4.

## Install

Run these steps in order on the deployment host, in the same shell.

### 1. Select a deployment commit

For a published install, read `deploy/public/release-commit` from `main`, check out that commit, and resolve the two pinned GHCR images.

```bash
git fetch origin main &&
  deployment_ref="$(git show FETCH_HEAD:deploy/public/release-commit)" &&
  git switch --detach "$deployment_ref" &&
  bash deploy/public/images.sh
```

Use the Compose files and initializer from that checkout. For a source build, use your chosen source checkout and resolve local tags with `bash deploy/public/images.sh --local`. [Release status](../../docs/release.md#current-deployment)

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

`--release` writes the two digest-pinned references to `.env.public`. For a
source build, omit `--release` to select local image names, then build the images
before bootstrapping the account.

```bash
docker compose --env-file .env.public build
```

#### Existing deployment

Keep the original domain, state directory and workstation subnet. Skip account
bootstrap for an existing administrator. [Existing deployment migration](#migrate-from-the-auth-service)

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

Full deployment serves the standalone browser/control page. Agent MCP is disabled by default; set `WORKSTATION_BROWSER_MCP=1` to enable it. The Agent then owns the browser by default and may reach any HTTPS origin, which is the accepted baseline in [ADR-0006](../../docs/adr/0006-agent-first-browser-and-default-open-origins.md). The Agent can reach anything the Chromium container can reach; that is accepted for a single-operator deployment.


| To | Open or choose |
| --- | --- |
| Open the shared Chromium desktop | Open **浏览器** in a DSH conversation’s right sidebar, or open `/_auth/browser` for the standalone desktop. Both use the workstation login. |
| Let an Agent use a tab | An Agent can acquire an available lease through `lease_status`. You can also grant a lease in `/mgmt/browser` for up to 120 seconds. Before granting control, `browser-gate` confirms it released held input. |
| Take over | Choose **接管浏览器**. The Provider stops new calls, lets the current call finish, and returns control. |
| Allow specific websites | `BROWSER_TOOL_ORIGINS` is optional. Leave it empty in `.env.public` to allow every HTTPS origin, or set comma-separated exact HTTPS origins such as `https://www.example.org,https://docs.example.com` to restrict the Agent to exactly those. Recreate Gateway after changing it. |

When MCP is enabled, the Agent gets its generation with `mcp__browser__lease_status` before calling `navigate`, `read`, or `click`. A configured allowlist constrains tool calls and returned page text; leaving it empty does not. Chromium still applies normal certificate checks, so an origin with a self-signed certificate fails to load — use a publicly trusted origin such as `https://example.com` to confirm the tool path end to end. [Candidate lease behavior](../../docs/adr/0006-agent-first-browser-and-default-open-origins.md)

The sidebar entry requires a Runtime with the Browser Bundle client and a Gateway with browser access enabled. Collapsing the docked sidebar preserves its iframe. Hiding a floating pane closes its tab in DSH. The standalone desktop remains available from `/mgmt/browser`. [Sidebar #5](https://github.com/sagehou/dsh-workstation/issues/5) · [Upstream sidebar evidence](../../docs/roadmap/M0-evidence.md)

For a lost connection or tab, create a new DSH session and grant it a lease. To keep the conversation, restart Runtime, resume the conversation, and grant a new tab in the same Chromium profile.

### The input gate

`browser-gate` forwards operator input to Selkies. Browser's Nginx accepts the data WebSocket and token administration only from Gateway on `workstation`. The gate releases held input and waits for Selkies to acknowledge it before Provider changes authority. If it cannot confirm release, it closes the socket while it still holds authority so Selkies releases held input on disconnect, and the lease is refused.

Check it without touching the browser:

```sh
docker compose --env-file .env.public exec -T gateway node --input-type=module -e '
  import { readFileSync } from "node:fs"
  const s = readFileSync("/run/secrets/gate_control", "utf8").trim()
  const r = await fetch(process.env.GATEWAY_BROWSER_UPSTREAM + "/status", {
    headers: { Authorization: "Bearer " + s },
  })
  console.log(await r.json())
'
```

`state` is `OPEN` only while you hold authority, and `RELEASING` while a handover is proving its release. A `POST /handover` returns `released: true` only after the upstream acknowledged the release. [ADR-0005](../../docs/adr/0005-release-held-input-at-selkies.md)

## Maintain

Open `/mgmt` to check Runtime status and versions, create or verify a DSH_HOME backup, manage the single account, and hand off browser control. Backups and archive checks require verification within the last five minutes. Stop Runtime for CLI upgrades, manual rollback, restore, or a quiescent migration backup. [Runtime maintenance](../README.md#upgrade-and-rollback)

### DSH upgrade and recovery

With Web upgrade support in both images, choose **升级 DSH** in `/mgmt`, supply an exact npm version, and complete TOTP when prompted. The overview shows the phase, any compatibility blockers, the selected version, and the matching backup ID. DSH Web pauses during the operation. Runtime checks the candidate on copied state, takes the backup, switches versions, restarts DSH, and verifies Profile state. If the selected candidate fails to start, Runtime restores the matching backup and restarts the previous version. [Web upgrades #48](https://github.com/sagehou/dsh-workstation/issues/48)

For a CLI upgrade, stop Runtime while Gateway stays up. Use the deployment’s Compose files and `--env-file .env.public` to run `docker compose --env-file .env.public run --rm --no-deps maintenance upgrade <version>`. Start Runtime and check DSH Web, then stop it to run `maintenance verify` and restart it. [Upgrade progress #39](https://github.com/sagehou/dsh-workstation/issues/39)

The Browser Bundle uses the official MCP client that comes with the selected DSH. Its configuration is checked when the Profile starts, including during the candidate readiness probe. The deployment links to Bundle files in the Runtime image, so recreating Runtime supplies the updated client to existing linked Profiles. With the sidebar client present, `WORKSTATION_BROWSER_MCP=0` suppresses Agent connections and the full deployment still loads the human browser entry. [Compatibility and recovery](../README.md#upgrade-and-rollback) · [Bundle verification #44](https://github.com/sagehou/dsh-workstation/issues/44)

### Workspace and skills

The DSH_HOME archive covers settings, credentials, sessions, Profile plugins and their lockfiles, `$DSH_HOME/skills`, and shared skills stored in `$DSH_HOME/.agents/skills`. Back up `/workspace` separately to retain project files and project skills. Back up or mount external targets for linked plugins and skills.

Before replacing an older Runtime container, export any files in its `/home/node/.agents` with `docker compose --env-file .env.public cp runtime:/home/node/.agents/. ./agents-export`. Copy them into `/dsh-home/.agents` in the persistent volume using the updated Runtime, keeping any existing files.

### Traefik

- For Runtime 0.2.4 and Gateway 0.1.2, use their matching deployment checkout. Rerun `deploy/public/init.sh --release` with the saved domain, proxy, Traefik container and subnet, then load its generated route file. Use `http://gateway:8080/mcp` in any custom DSH MCP configuration that references the Workstation provider.
- To retain the attachment across Traefik recreation, declare `dsh-workstation_workstation` as an external network in Traefik's Compose.
- If Traefik's IP on the proxy network changes, use the teardown in [Existing deployment migration](#migrate-from-the-auth-service), rerun the initializer with the saved settings, and follow step 4 to reconnect Traefik and reload the routes.

### Browser recovery

If the Provider cannot confirm that a pending browser operation ended, it rejects new grants to that Chromium process. Recreate Browser with the current hostname and profile volume.

```bash
docker compose --env-file .env.public up -d --no-build --force-recreate browser
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

On first start, Runtime installs official DSH `0.2.2-rc.1`. In a full deployment, the official Plugin Manager adds the Workstation browser Bundle to the persistent Web Profile. Package lifecycle scripts stay disabled during Runtime and Profile installation. The Bundle uses the verified DSH version.

Back up DSH_HOME before changing a Profile or version. Run the Runtime maintenance commands against the public Compose with `--env-file .env.public`. A version rollback changes the selected install. Restoring migrated data requires a matching backup. [Runtime maintenance](../README.md#upgrade-and-rollback)

### Replace the original standalone stack

1. Use `down` from the old checkout. Keep the named volumes, `.env.public`, and `.workstation/`.
2. Load the new images and rerun the initializer with the same domain.
3. Skip admin bootstrap and start the new Compose.

### Migrate from the `auth` service

These steps also apply to a Gateway checkout that still has a separate Browser network.

1. For a published destination, confirm `bash deploy/public/images.sh` resolves both digests. Stop the old stack and back up `.env.public`, `.workstation/`, and the named volumes. Disconnect Traefik from `dsh-workstation_workstation` and `dsh-workstation_browser` where attached. Run `docker compose --env-file .env.public down` with the old Compose files and same project name. Keep the named volumes.
2. Switch to the destination checkout. Follow [step 2](#2-set-the-domain-and-traefik-values) with the saved domain, state path and Traefik settings. Pass the saved `WORKSTATION_SUBNET` if it is customized. The initializer drops `BROWSER_SUBNET` and `BROWSER_IP_RANGE` and preserves the Runtime CA and certificate for the same workstation subnet.
3. Follow [step 4](#4-start-compose-and-add-the-routes) to start Compose, attach Traefik once to `dsh-workstation_workstation`, and replace its Workstation route file. Confirm your existing login, `/mgmt`, and `/browser/` in a full deployment.

`GATEWAY_IDLE`, `GATEWAY_ABSOLUTE`, and `GATEWAY_MAX_SESSIONS` take precedence over their `AUTH_*` predecessors. For rollback, follow the same teardown, return to the old checkout, restore the saved `.env.public`, and use that checkout's initializer and network attachment commands.

If the old hostname left a browser profile lock, confirm that the old Chromium has stopped before removing the `SingletonLock`, `SingletonSocket`, and `SingletonCookie` symlinks in `/config/chromium` on the profile volume. [Chromium profile locking](https://github.com/chromium/chromium/blob/156.0.8078.79/chrome/browser/process_singleton_posix.cc)

### Upgrading and rolling back

Back up and tear down the running stack as in the migration above so the subnet
preflight can run. Then switch to the new digests and reuse the saved subnet.

```bash
# Set deployment_ref to the commit whose images.env records the destination digests.
workstation_subnet="$(sed -n 's/^WORKSTATION_SUBNET=//p' .env.public)"
git switch --detach "$deployment_ref" &&
  bash deploy/public/images.sh &&
  WORKSTATION_SUBNET="${workstation_subnet:-172.30.241.0/24}" \
  WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
    bash deploy/public/init.sh "$domain" "$proxy" "$traefik" --release
```

Start Compose, reconnect Traefik and install the routes as in step 4. For a
rollback, use the older deployment commit and its network attachment commands.

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
