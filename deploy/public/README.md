# Public Compose

English · [简体中文](README.zh-CN.md)

Use this stack for one trusted operator on Linux x86-64 with rootful Docker Engine 28+ and Compose v2. It reuses a Traefik container on the same Docker host with an HTTPS entrypoint and a directory watched by the file provider. GitHub Actions uses Traefik `3.7.19`. Traefik continues to publish ports 80 and 443 and manage public certificates. Point the domain's DNS record at that Traefik host. The two subnets in [compose.yml](../../compose.yml) must be free on the host.

Run the commands as a non-root Docker operator with GitHub CLI access to the repository. Set the domain, a trusted Docker network connected to Traefik, the Traefik container, and the host directory watched by its file provider. Use the entrypoint and certificate resolver names configured in Traefik. Set `WORKSTATION_TRAEFIK_RESOLVER=''` to use an HTTPS entrypoint that already provides the certificate. The script reads Traefik's IPv4 address from the selected network, and Auth uses that exact address. The [GitHub Actions artifact](https://github.com/sagehou/dsh-workstation/actions/runs/44688814854/artifacts/14607841816) contains the images built from the stated commit.

```bash
(
  set -e
  domain='workstation.example.net'
  proxy='proxy'
  traefik='traefik'
  traefik_dynamic='/srv/traefik/dynamic'

  gh repo clone sagehou/dsh-workstation
  cd dsh-workstation

  images_dir="$(mktemp -d)"
  gh run download 44688814854 --repo sagehou/dsh-workstation \
    --name public-compose-linux-amd64 --dir "$images_dir"
  release_commit='333e6f332ad054723ca32c8b9436c8109bb62ad4'
  test "$(cat "$images_dir/source-commit")" = "$release_commit"
  git switch --detach "$release_commit"
  (
    cd "$images_dir"
    sha256sum -c workstation-images-linux-amd64.sha256
    docker load -i workstation-images-linux-amd64.tar.gz
  )

  WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
    bash deploy/public/init.sh "$domain" "$proxy" "$traefik"

  docker compose --env-file .env.public run --rm --no-deps auth-admin bootstrap admin
  docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 360
  docker network connect dsh-workstation_workstation "$traefik"
  docker network connect dsh-workstation_browser "$traefik"
  install -m 0644 .workstation/edge/routes.yml "$traefik_dynamic/.dsh-workstation.tmp"
  mv "$traefik_dynamic/.dsh-workstation.tmp" "$traefik_dynamic/dsh-workstation.yml"
  docker compose --env-file .env.public ps
)
```

Join the two workstation networks in Traefik's own Compose configuration as external networks if you regularly recreate that container. If its IP on the proxy network changes, rerun `init.sh` with the same domain and arguments and run `docker compose --env-file .env.public up -d --no-build auth` to refresh the trusted peer. Keep the existing TLS entrypoint and resolver settings when rerunning the initializer.

For an existing installation, stop the previous Compose with `down` before switching commits. Keep `.env.public`, `.workstation/` and the named volumes, run the new initializer with the same domain, then skip the admin bootstrap. Existing DSH and Chromium data stay on their original volumes. If Chromium sees a stale lock from the old container hostname, confirm the old Chromium has stopped and remove only the `SingletonLock`, `SingletonSocket` and `SingletonCookie` symlinks in `/config/chromium` on the browser profile volume before starting the new container. [Chromium profile locking](https://github.com/chromium/chromium/blob/156.0.8078.79/chrome/browser/process_singleton_posix.cc)

If the image artifact expires, run [Public Compose](../../.github/workflows/public-compose.yml) on the intended revision and use the successful run ID and the matching `source-commit` in the example.

Bootstrap prompts for a new password and displays an enrollment key. Add the key in a TOTP authenticator, enter its current code and save the printed recovery codes offline. The bootstrap is disabled after the first account is created. The enrollment code itself cannot be used again; wait for the authenticator to show a new code before signing in at `https://<domain>/`. Supply the DeepSeek key in official DSH **Settings → Models**. Login and credential management are at `/_auth/account`; a separate Passkey login is available after registering one there. Password-based security changes require a fresh two-step login after the five-minute step-up window expires.

The first Runtime start installs official DSH `0.2.2-rc.1` and the workstation Bundle into the persistent Web Profile through the official Plugin Manager. Runtime and Profile installation keep package lifecycle scripts disabled. The Bundle is verified with this DSH version; leave it pinned until another version is validated against it.

The desktop opens through `/_auth/browser` and streams at `/browser/` on the same origin. The workstation passes the desktop credential without requiring a separate login. Use `/_auth/control` to grant a live DSH session a lease of up to 120 seconds. The first grant creates a tab in the same Chromium profile; later grants to that live session reuse its tab. Release the mouse and keys before granting. Use **接管浏览器** to stop admission of new Agent calls, drain the pending call and return control.

Set `BROWSER_TOOL_ORIGINS` in `.env.public` to comma-separated exact HTTPS origins, for example `https://www.example.org,https://docs.example.com`. Recreate the Provider after changing it. An empty list allows humans to browse but admits no Agent navigation, reads or clicks. The Agent uses `mcp__browser__lease_status` to get the current generation before calling `navigate`, `read` or `click`. The origin list bounds commands and returned page text. The Chromium profile keeps normal browser networking, including page scripts and redirects; use trusted origins. Tabs share cookies, so this is a workflow boundary for one operator.

If the Agent's connection or tab is lost, create a new DSH session and grant again. To keep using an existing conversation, restart the Runtime and resume that conversation before granting. The new connection gets a new tab in the same persistent Chromium profile. If the Provider cannot establish that an in-flight operation ended, it refuses a new grant to that Chromium process. Recreate Chromium and its relay together, preserving the profile volume and Chromium hostname:

```sh
docker compose --env-file .env.public up -d --no-build --force-recreate chromium cdp-relay
```

The Provider attempts to recover its attachment automatically after browser process loss. If the control page still reports DISCONNECTED, use **连接浏览器** after the replacement Chromium is ready.

The session defaults are 30 minutes idle, 12 hours absolute and eight sessions. Optional `AUTH_IDLE`, `AUTH_ABSOLUTE` and `AUTH_MAX_SESSIONS` settings go in `.env.public`. HTTP requests and a new WebSocket handshake update idle time. Established DSH and Selkies WebSockets check the session every two seconds and close on expiry or revocation. The account page can revoke one or all sessions. The host operator can disable or re-enable the account with the same bootstrap service command, replacing `bootstrap admin` with `disable` or `enable`; both invalidate existing sessions.

Keep `.workstation/` private and back it up separately from the database; do not regenerate it over a live installation. It contains the TOTP encryption key, service credentials, and internal TLS keys. Keep the public domain the same when restoring Passkeys. Stop the stack before snapshotting its named volumes. Keep `dsh-home`, `workspace`, `browser-profile`, `auth-data` and `provider-state`. Session launch URLs are regenerated. Do not use `down -v` on a deployment you want to preserve. For example, after `docker compose --env-file .env.public stop`, archive Auth's volume from the deployed provider image to a private location:

```sh
umask 077
docker run --rm --network none --user 0:0 --entrypoint tar \
  -v dsh-workstation_auth-data:/data:ro dsh-workstation-provider:0.2.0 \
  --numeric-owner -C /data -cf - . > auth-data.tar
```

Restore with the stack stopped into an empty `auth-data` volume using the matching archive and `.workstation/secrets/auth-key`. Preserve the tar file's numeric owners and modes. Back up DSH_HOME before changing any Profile or version. Use [the Runtime maintenance commands](../README.md#upgrade-and-rollback) with `--env-file .env.public` and the public Compose. Runtime rollback changes the selected npm installation; a data migration requires a matching backup.

Only Traefik has published ports. The full held-input handoff and the native DSH Sidebar are deferred. The browser remains usable in a separate tab now. See [test evidence and remaining limits](../../docs/roadmap/public-compose.md).
