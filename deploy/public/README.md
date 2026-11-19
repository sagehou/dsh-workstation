# Public Compose

English · [简体中文](README.zh-CN.md)

Use this stack for one trusted operator on Linux x86-64 with rootful Docker Engine 28+ and Compose v2. Point the DNS `A` record at the host's public IPv4 address and allow inbound TCP 80 and 443 in the cloud and host firewalls. Port 80 serves the ACME HTTP-01 challenge and redirects other traffic to HTTPS. Traefik requests and renews the certificate. If you publish an `AAAA` record, make sure it reaches the same host and both ports over IPv6. The Docker subnets in [compose.yml](../../compose.yml) must not overlap the host's routes.

On the deployment host, use a non-root Docker operator. Sign in to the GitHub CLI with repository access (`gh auth login`) and replace the domain and email below. The commands download the [verified GitHub Actions images](https://github.com/sagehou/dsh-workstation/actions/runs/44488230831/artifacts/14512006785), check the SHA-256, and check out the matching source.

```bash
(
  set -e
  domain='workstation.example.net'
  acme_email='admin@example.net'

  gh repo clone sagehou/dsh-workstation
  cd dsh-workstation

  images_dir="$(mktemp -d)"
  gh run download 44488230831 --repo sagehou/dsh-workstation \
    --name public-compose-linux-amd64 --dir "$images_dir"
  release_commit='de823f9d850ae5a8bc001a67613413220ff4fd7e'
  test "$(cat "$images_dir/source-commit")" = "$release_commit"
  git switch --detach "$release_commit"
  (
    cd "$images_dir"
    sha256sum -c workstation-images-linux-amd64.sha256
    docker load -i workstation-images-linux-amd64.tar.gz
  )

  bash deploy/public/init.sh "$domain" "$acme_email"
)
```

To allow the Agent to use websites, set `BROWSER_TOOL_ORIGINS` in `dsh-workstation/.env.public` before starting. Use comma-separated HTTPS origins, such as `https://www.example.org,https://docs.example.com`. An empty list allows only human browsing. If the archive expires, run the [Public Compose workflow](../../.github/workflows/public-compose.yml) on the intended revision and substitute the new run ID and the new artifact's `source-commit`.

```bash
(
  set -e
  cd dsh-workstation
  docker compose --env-file .env.public run --rm --no-deps auth-admin bootstrap admin
  docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 360
  docker compose --env-file .env.public ps
)
```

Bootstrap prompts for a new password and displays an enrollment key. Add the key in a TOTP authenticator, enter its current code and save the printed recovery codes offline. The bootstrap is disabled after the first account is created. The enrollment code itself cannot be used again; wait for the authenticator to show a new code before signing in at `https://<domain>/`. Supply the DeepSeek key in official DSH **Settings → Models**. Login and credential management are at `/_auth/account`; a separate Passkey login is available after registering one there. Password-based security changes require a fresh two-step login after the five-minute step-up window expires.

The first Runtime start installs official DSH `0.2.2-rc.1` and the workstation Bundle into the persistent Web Profile through the official Plugin Manager. Runtime and Profile installation keep package lifecycle scripts disabled. The Bundle is verified with this DSH version; leave it pinned until another version is validated against it.

The desktop opens through `/_auth/browser` and streams at `/browser/` on the same origin. The workstation passes the desktop credential without requiring a separate login. Use `/_auth/control` to grant a live DSH session a lease of up to 120 seconds. The first grant creates a tab in the same Chromium profile; later grants to that live session reuse its tab. Release the mouse and keys before granting. Use **接管浏览器** to stop admission of new Agent calls, drain the pending call and return control.

Recreate the Provider after changing `BROWSER_TOOL_ORIGINS`. An empty list allows humans to browse but admits no Agent navigation, reads or clicks. The Agent uses `mcp__browser__lease_status` to get the current generation before calling `navigate`, `read` or `click`. The origin list bounds commands and returned page text. The Chromium profile keeps normal browser networking, including page scripts and redirects; use trusted origins. Tabs share cookies, so this is a workflow boundary for one operator.

If the Agent's connection or tab is lost, create a new DSH session and grant again. To keep using an existing conversation, restart the Runtime and resume that conversation before granting. The new connection gets a new tab in the same persistent Chromium profile. If the Provider cannot establish that an in-flight operation ended, it refuses a new grant to that Chromium process. Recreate Chromium and its relay together, preserving the profile volume:

```sh
docker compose --env-file .env.public up -d --no-build --force-recreate chromium cdp-relay
```

The Provider attempts to recover its attachment automatically after browser process loss. If the control page still reports DISCONNECTED, use **连接浏览器** after the replacement Chromium is ready.

The session defaults are 30 minutes idle, 12 hours absolute and eight sessions. Optional `AUTH_IDLE`, `AUTH_ABSOLUTE` and `AUTH_MAX_SESSIONS` settings go in `.env.public`. HTTP requests and a new WebSocket handshake update idle time. Established DSH and Selkies WebSockets check the session every two seconds and close on expiry or revocation. The account page can revoke one or all sessions. The host operator can disable or re-enable the account with the same bootstrap service command, replacing `bootstrap admin` with `disable` or `enable`; both invalidate existing sessions.

Keep `.workstation/` private and back it up separately from the database; do not regenerate it over a live installation. It contains the TOTP encryption key, service credentials, internal TLS keys and the ACME state. Keep the public domain the same when restoring Passkeys. Stop the stack before snapshotting its named volumes. Keep `dsh-home`, `workspace`, `browser-profile`, `auth-data` and `provider-state`. Session launch URLs are regenerated. Do not use `down -v` on a deployment you want to preserve. For example, after `docker compose --env-file .env.public stop`, archive Auth's volume from the deployed provider image to a private location:

```sh
umask 077
docker run --rm --network none --user 0:0 --entrypoint tar \
  -v dsh-workstation_auth-data:/data:ro dsh-workstation-provider:0.1.0 \
  --numeric-owner -C /data -cf - . > auth-data.tar
```

Restore with the stack stopped into an empty `auth-data` volume using the matching archive and `.workstation/secrets/auth-key`. Preserve the tar file's numeric owners and modes. Back up DSH_HOME before changing any Profile or version. Use [the Runtime maintenance commands](../README.md#upgrade-and-rollback) with `--env-file .env.public` and the public Compose. Runtime rollback changes the selected npm installation; a data migration requires a matching backup.

Only Traefik has published ports. The full held-input handoff and the native DSH Sidebar are deferred. The browser remains usable in a separate tab now. See [test evidence and remaining limits](../../docs/roadmap/public-compose.md).
