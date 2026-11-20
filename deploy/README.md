# Private preview

English · [简体中文](README.zh-CN.md)

For one trusted user on a trusted host with Docker Engine 28+ and Compose v2. Traefik publishes port 3080 on host loopback. Browser interaction is manual. For a public domain, use the [authenticated HTTPS stack](public/README.md).

## 1. Load the image and start

Download `dsh-workstation-runtime.tar.gz` from the tested `fe91e89` run or from a passing build of your reviewed commit. Use the Compose and Traefik files from the image's source commit. [Tested image](https://github.com/sagehou/dsh-workstation/actions/runs/44474103563/artifacts/14505771617)

```sh
docker load -i dsh-workstation-runtime.tar.gz
docker compose -f compose.preview.yml up -d --no-build --wait --wait-timeout 360
```

A fresh DSH_HOME volume installs official DSH `0.2.2-rc.1` by default. The image supplies the Runtime. `DSH_INITIAL_VERSION` applies only to a fresh volume. An existing volume keeps its selected version.

## 2. Connect via SSH

On your workstation, open a tunnel to the deployment host.

```sh
ssh -N -L 127.0.0.1:3080:127.0.0.1:3080 user@host
```

In a private shell on the deployment host, get the official launch URL.

```sh
docker compose -f compose.preview.yml exec -T runtime dsh-runtime launch-url
```

| Open | Use |
| --- | --- |
| Official launch URL | Obtain the DSH session cookie. Keep the URL private and retrieve a new one after Runtime restarts. |
| `http://127.0.0.1:3080/browser/` | Control the Chromium desktop through Selkies. |

CDP stays private in the preview. Agent browser tools are available in the public stack.

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

Maintenance requires a stopped Runtime. Selection checks the candidate on a copy of DSH_HOME. A passing candidate triggers a live-state backup and an atomic selection. A failed readiness check leaves the old version selected.

If the new version fails on live state, roll back and restart.

```sh
preview stop runtime
preview run --rm --no-deps maintenance rollback
preview up -d --no-build --wait --wait-timeout 360 runtime
```

A data migration requires the corresponding data backup.

## Back up

Before changing plugin dependencies or versions, stop Runtime and take a snapshot.

```sh
preview stop runtime
preview run --rm --no-deps maintenance backup
```

Store snapshots securely off-host. They include credentials and DSH state and omit reinstallable Runtime packages. Back up workspace and Chromium volumes separately with their services stopped. `preview down` preserves the named DSH_HOME, workspace, Chromium profile, and backup volumes.

GitHub Actions runs `bash deploy/ci-preview.sh` to check routes, version switch and rollback, and data after container recreation. [Workflow](../.github/workflows/m1-preview.yml) · [Results](../docs/roadmap/M1.md)
