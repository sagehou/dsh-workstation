# Public Compose

English · [简体中文](README.zh-CN.md)

[Install](#install) · [Use the browser](#use-the-browser) · [Maintain](#maintain) · [Back up and restore](#back-up-and-restore)

## Before you start

- Use a **Linux amd64** host with rootful Docker Engine 28+ and Compose v2. Use a non-root user with Docker access and an authenticated GitHub CLI.
- Point **DNS** at the Traefik host. Traefik serves public ports 80 and 443 and manages the certificates.
- Use **Traefik** already running on the same Docker host. Identify its trusted Docker network, HTTPS entrypoint, certificate resolver, and the directory watched by its file provider. You do **not** have to upgrade Traefik: CI pins and exercises `v3.7.14` and `v3.7.19` through the same full stack. [Compatibility matrix](../../docs/roadmap/public-compose.md#traefik-compatibility-matrix) records which versions have a passing run.
- Check that neither **Docker subnet** overlaps your host routes. [Compose](../../compose.yml)

## Install

Run these steps in order on the deployment host, in the same shell.

### 1. Load the verified images

```bash
gh repo clone sagehou/dsh-workstation && cd dsh-workstation

images_dir="$(mktemp -d)"
release_commit='333e6f332ad054723ca32c8b9436c8109bb62ad4'
gh run download 44688814854 --repo sagehou/dsh-workstation \
  --name public-compose-linux-amd64 --dir "$images_dir" &&
  test "$(cat "$images_dir/source-commit")" = "$release_commit" &&
  git switch --detach "$release_commit" &&
  (
    cd "$images_dir" &&
    sha256sum -c workstation-images-linux-amd64.sha256 &&
    docker load -i workstation-images-linux-amd64.tar.gz
  )
```

[Image archive](https://github.com/sagehou/dsh-workstation/actions/runs/44688814854/artifacts/14607841816)

### 2. Set the domain and Traefik values

Replace the example values below. The initializer records Traefik's IPv4 address on the chosen network and generates the routes file. Set `WORKSTATION_TRAEFIK_RESOLVER=''` if the HTTPS entrypoint already provides a certificate.

```bash
domain='workstation.example.net'
proxy='proxy'
traefik='traefik'
traefik_dynamic='/srv/traefik/dynamic'

WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
  bash deploy/public/init.sh "$domain" "$proxy" "$traefik"
```

### 3. Create the administrator

```bash
docker compose --env-file .env.public run --rm --no-deps auth-admin bootstrap admin
```

1. Set the password.
2. Add the displayed TOTP key to your authenticator and enter the current code.
3. Save the displayed recovery codes offline. Bootstrap closes after the first account is created.

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
| Let an Agent use a tab | Open `/_auth/control`, select a live DSH session, and grant a lease for up to 120 seconds. Release the mouse buttons and keys first. The first grant creates a tab, and later grants reuse the tab for that live session. |
| Take over | Choose **接管浏览器**. The Provider stops new calls, lets the current call finish, and returns control. |
| Allow specific websites | Set `BROWSER_TOOL_ORIGINS` in `.env.public` to comma-separated exact HTTPS origins such as `https://www.example.org,https://docs.example.com`. Recreate the Provider. An empty list leaves browsing to the operator. |

The Agent gets the current generation with `mcp__browser__lease_status` before calling `navigate`, `read`, or `click`. The allowlist limits those tools and the page text they return. Chromium still handles scripts and redirects normally, and tabs share cookies. Use trusted origins.

For a lost connection or tab, create a new DSH session and grant it a lease. To keep the conversation, restart Runtime, resume the conversation, and grant a new tab in the same Chromium profile.

## Maintain

### Traefik

- To retain the two workstation networks across Traefik recreation, declare them as external networks in Traefik's Compose.
- If Traefik's IP on the proxy network changes, rerun the initializer with the same domain, entrypoint, and resolver. Then run `docker compose --env-file .env.public up -d --no-build auth`.

### Browser recovery

If the Provider cannot confirm that a pending browser operation ended, it rejects new grants to that Chromium process. Recreate Chromium and the relay on the same profile volume and keep the configured hostname.

```bash
docker compose --env-file .env.public up -d --no-build --force-recreate chromium cdp-relay
```

The Provider tries to reconnect automatically. If the control page still shows `DISCONNECTED` after Chromium is ready, choose **连接浏览器**.

### Account and sessions

| Setting in `.env.public` | Default |
| --- | --- |
| `AUTH_IDLE` | 30 minutes |
| `AUTH_ABSOLUTE` | 12 hours |
| `AUTH_MAX_SESSIONS` | 8 |

- HTTP requests and new WebSocket handshakes refresh the idle timer. Open DSH and Selkies WebSockets check the session every two seconds and close on expiry or revocation.
- Revoke one or all sessions at `/_auth/account`. For password-based security changes, repeat password and TOTP if the five-minute step-up window has passed.
- To disable or enable the account from the host, replace `bootstrap admin` in the administrator command with `disable` or `enable`. Both commands invalidate current sessions.

### DSH versions

On first start, Runtime installs official DSH `0.2.2-rc.1`. The official Plugin Manager adds the Workstation Bundle to the persistent Web Profile. Package lifecycle scripts stay disabled during Runtime and Profile installation. The Bundle uses the verified DSH version.

Back up DSH_HOME before changing a Profile or version. Run the Runtime maintenance commands against the public Compose with `--env-file .env.public`. A version rollback changes the selected install. Restoring migrated data requires a matching backup. [Runtime maintenance](../README.md#upgrade-and-rollback)

### Replace the original standalone stack

1. Use `down` from the old checkout. Keep the named volumes, `.env.public`, and `.workstation/`.
2. Load the new images and rerun the initializer with the same domain.
3. Skip admin bootstrap and start the new Compose.

If the old hostname left a browser profile lock, confirm that the old Chromium has stopped before removing the `SingletonLock`, `SingletonSocket`, and `SingletonCookie` symlinks in `/config/chromium` on the profile volume. [Chromium profile locking](https://github.com/chromium/chromium/blob/156.0.8078.79/chrome/browser/process_singleton_posix.cc)

### Refresh an expired image archive

Run **Public Compose** for the intended revision on GitHub Actions. Use the successful run ID and its `source-commit` in step 1. Each Traefik version in the matrix uploads its own artifact: the default version keeps the unsuffixed `public-compose-linux-amd64` name, and the other legs add `-<version>`. Pick one leg; the workstation images are identical across legs because only the edge proxy differs. [Workflow](../../.github/workflows/public-compose.yml)

## Back up and restore

| Keep | Why |
| --- | --- |
| `.workstation/`, backed up separately from SQLite | TOTP encryption key, service credentials, and internal TLS keys. Keep the existing directory when reinstalling. |
| Named volumes `dsh-home`, `workspace`, `browser-profile`, `auth-data`, and `provider-state` | DSH and browser state, Auth, and Provider state. Stop Compose before taking snapshots and avoid `down -v` on volumes you need. |

For an Auth backup, archive the stopped volume to a private location.

```bash
docker compose --env-file .env.public stop && (
  umask 077
  docker run --rm --network none --user 0:0 --entrypoint tar \
    -v dsh-workstation_auth-data:/data:ro dsh-workstation-provider:0.2.0 \
    --numeric-owner -C /data -cf - . > auth-data.tar
)
```

Restore into an empty `auth-data` volume with the stack stopped. Use the matching `.workstation/secrets/auth-key`, preserve numeric owners and modes, and keep the public domain for Passkeys. The Runtime generates fresh launch URLs.

Only Traefik publishes ports. The desktop opens in its own tab while native Sidebar and release of held input during handoff are tracked in [#1](https://github.com/sagehou/dsh-workstation/issues/1). [Test evidence](../../docs/roadmap/public-compose.md)
