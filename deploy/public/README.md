# Public Compose

Use this stack for one trusted operator on Linux x86-64 with rootful Docker Engine 28+ and Compose v2. Point a public DNS name at the host and allow inbound TCP 80 and 443. Port 80 serves the ACME HTTP-01 challenge and redirects other traffic to HTTPS. Traefik requests and renews the certificate. If you publish an AAAA record, make sure it reaches the same host. The Docker subnets in [compose.yml](../../compose.yml) must not overlap the host's routes.

Download the verified [public-compose-linux-amd64](https://github.com/sagehou/dsh-workstation/actions/runs/44488230831/artifacts/14512006785) archive and use the repository commit listed in its `source-commit` file ([`de823f9`](https://github.com/sagehou/dsh-workstation/commit/de823f9d850ae5a8bc001a67613413220ff4fd7e)). The [Public Compose workflow](../../.github/workflows/public-compose.yml) builds the images and verifies the stack.

```sh
# In the extracted Actions artifact directory
sha256sum -c workstation-images-linux-amd64.sha256
docker load -i workstation-images-linux-amd64.tar.gz
```

```sh
# In that commit's checkout on the deployment host, as a non-root Docker operator
bash deploy/public/init.sh workstation.example.net admin@example.net
docker compose --env-file .env.public run --rm --no-deps auth-admin bootstrap admin
docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 360
```

Bootstrap prompts for a new password and displays an enrollment key. Add the key in a TOTP authenticator, enter its current code and save the printed recovery codes offline. The bootstrap is disabled after the first account is created. The enrollment code itself cannot be used again; wait for the authenticator to show a new code for the first password login. Supply the DeepSeek key in official DSH **Settings → Models**. Login and credential management are at `/_auth/account`; a separate Passkey login is available after registering one there. Password-based security changes require a fresh two-step login after the five-minute step-up window expires.

The first Runtime start installs official DSH `0.2.2-rc.1` and the workstation Bundle into the persistent Web Profile through the official Plugin Manager. Runtime and Profile installation keep package lifecycle scripts disabled. The Bundle is verified with this DSH version; leave it pinned until another version is validated against it.

The desktop opens through `/_auth/browser` and streams at `/browser/` on the same origin. The workstation passes the desktop credential without requiring a separate login. Use `/_auth/control` to grant a live DSH session a lease of up to 120 seconds. The first grant creates a tab in the same Chromium profile; later grants to that live session reuse its tab. Release the mouse and keys before granting. Use **接管浏览器** to stop admission of new Agent calls, drain the pending call and return control.

Set `BROWSER_TOOL_ORIGINS` in `.env.public` to a comma-separated list of exact HTTPS origins that the Agent may operate on, for example `https://www.example.org,https://docs.example.com`. Recreate the Provider after changing it. An empty list allows humans to browse but admits no Agent navigation, reads or clicks. The Agent uses `mcp__browser__lease_status` to get the current generation before calling `navigate`, `read` or `click`. The origin list bounds commands and returned page text. The Chromium profile keeps normal browser networking, including page scripts and redirects; use trusted origins. Tabs share cookies, so this is a workflow boundary for one operator.

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
