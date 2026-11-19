# Private preview

English · [简体中文](README.zh-CN.md)

The preview is for one trusted user on a trusted host with Docker Engine 28 or newer and Compose v2. It runs official DSH Web at `http://127.0.0.1:3080/` and manual Selkies at `/browser/`. Only the Traefik port is published, on host loopback. Access from a different machine uses SSH. Keep that port on loopback. For direct public access, use the [public Compose](public/README.md) with authentication and HTTPS.

Build and check the preview in [M1 private preview](../.github/workflows/m1-preview.yml) on GitHub Actions. The runner executes `bash deploy/ci-preview.sh`, exercising the actual Compose routes, Runtime selection/rollback, and container recreation. Download `dsh-workstation-runtime.tar.gz` from the [passing `fe91e89` run](https://github.com/sagehou/dsh-workstation/actions/runs/44474103563/artifacts/14505771617), or a successful run of your own reviewed commit.

On the deployment host, use the Compose and Traefik files from that same commit:

```sh
docker load -i dsh-workstation-runtime.tar.gz
docker compose -f compose.preview.yml up -d --no-build --wait --wait-timeout 360
```

The first start downloads the exact official DSH npm version (`0.2.2-rc.1` by default) into the named DSH_HOME volume. The image itself contains no DSH package. Later starts use the stored selection. Pinning a different `DSH_INITIAL_VERSION` affects only a fresh volume.

Open an SSH tunnel from your workstation:

```sh
ssh -N -L 127.0.0.1:3080:127.0.0.1:3080 user@host
```

In a separate private shell on the deployment host, retrieve the official launch URL:

```sh
docker compose -f compose.preview.yml exec -T runtime dsh-runtime launch-url
```

Open that URL once in your desktop browser to obtain the DSH session cookie. Keep the launch URL private and retrieve it again after a Runtime restart. Visit `http://127.0.0.1:3080/browser/` for the browser desktop. The preview does not publish CDP or enable Agent browser tools.

## Upgrade and rollback

```sh
preview() { docker compose -f compose.preview.yml "$@"; }
preview exec -T runtime dsh-runtime status
preview run --rm --no-deps maintenance versions
preview stop runtime
preview run --rm --no-deps maintenance install 0.2.2-rc.5
preview run --rm --no-deps maintenance select 0.2.2-rc.5
preview up -d --no-build --wait --wait-timeout 360 runtime
```

The version manager locks maintenance while Web is serving. It verifies a candidate on a copy of the stopped DSH_HOME, then backs up live state and replaces the version selection atomically. It leaves the version unchanged when candidate readiness fails. If serving the selected version fails on live state, stop it and use `preview run --rm --no-deps maintenance rollback` before restarting. A Runtime rollback does not undo a DSH data migration.

The DSH_HOME, workspace, Chromium profile and backups are separate named volumes. `preview down` preserves them. Before plugin dependency changes or upgrades, use the offline `preview run --rm --no-deps maintenance backup` command and store snapshots securely off-host. The Runtime snapshots contain DSH state, including credentials, but omit reinstallable Runtime packages. Back up the workspace and Chromium profile separately while their owners are stopped.
