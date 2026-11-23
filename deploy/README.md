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

Maintenance requires a stopped Runtime. `upgrade` is the recommended path because it records a matched backup and an audit trail; `select` remains available for a deliberate manual switch.

```sh
preview() { docker compose -f compose.preview.yml "$@"; }
preview exec -T runtime dsh-runtime status
preview run --rm --no-deps maintenance versions   # list installable versions
preview stop runtime
preview run --rm --no-deps maintenance upgrade 0.2.2-rc.5
```

Before the pointer moves, `upgrade` checks four things and stops on any failure:

| Check | Why it blocks |
| --- | --- |
| Image Node.js against the candidate `engines.node` | A candidate that rejects Node `24.22.3` cannot boot. |
| Installed Profile bundles against the candidate | A Bundle declaring `engines.dsh` pins the DSH version. The shipped browser Bundle declares `0.2.2-rc.1`, so DSH cannot move while it is installed. |
| Profile dependencies with lifecycle scripts | Installs use `--ignore-scripts`, so such a script never ran. Approve only an exact `package@version`. |
| Candidate readiness on a copy of DSH_HOME | Startup and Profile activation must succeed away from live state. |

A blocked upgrade leaves the active pointer and the data untouched; the candidate stays installed beside it. Approve a specific package and retry:

```sh
preview run --rm --no-deps maintenance upgrade 0.2.2-rc.5   # prints the blocking package
preview run --rm --no-deps maintenance approve native-thing@2.0.0
preview run --rm --no-deps maintenance upgrade 0.2.2-rc.5
```

Approvals are recorded in `DSH_HOME/approved-scripts.txt`, so they apply to later transactions, including a rollback. They name an exact version; a range or a bare package name is refused.

After restarting on the new version, record whether the upgrade migrated Profile state:

```sh
preview up -d --no-build --wait --wait-timeout 360 runtime
preview stop runtime
preview run --rm --no-deps maintenance verify
```

`verify` compares Profile manifests, lockfiles and installed package versions against the state recorded before the switch and prints `unchanged` or `MIGRATED`. **A pointer rollback only changes the executable.** When state migrated, restore the matching backup instead.

```sh
preview run --rm --no-deps maintenance restore 20260101T120000Z.a1b2c3d4e5f6
preview up -d --no-build --wait --wait-timeout 360 runtime
```

Restore refuses an archive that fails its checksum, a backup without a manifest, and a backup whose DSH version is not installed — restoring data into a version it never ran under would be a mismatch, not a recovery.

## Back up

Stop Runtime, then take a snapshot. Each backup writes an archive plus a manifest carrying the Runtime image, the DSH selection, the archive checksum, and digests of the Runtime's own files.

The archive holds restorable state: Profiles, plugin dependencies, credentials and sessions. It excludes `runtime` (the installed DSH versions) and `pnpm` (the content-addressable store), both reinstallable from the registry. Measured on a real install those were 962 MB and 869 MB, which turned a 40 KB Profile backup into a 223 MB archive.

```sh
preview stop runtime
preview run --rm --no-deps maintenance backup
preview run --rm --no-deps maintenance backups   # list id, version, time, size
```

Store snapshots securely off-host. They include credentials and DSH state, and omit reinstallable Runtime packages. Back up workspace and Chromium volumes separately with their services stopped. `preview down` preserves the named DSH_HOME, workspace, Chromium profile, and backup volumes.

GitHub Actions runs `bash deploy/ci-preview.sh` for routes and recreation, `bash deploy/ci-upgrade.sh` for the full upgrade and restore drill, and `node --test "runtime/test/*.test.mjs"` for the gate and manifest logic. [Workflow](../.github/workflows/m1-preview.yml) · [Results](../docs/roadmap/M1.md)

## Recovery drill

Run this on the deployment host after the first install, and again after changing the Runtime image. It proves the recovery path on the data you actually depend on, not on a synthetic fixture.

```sh
preview() { docker compose -f compose.preview.yml "$@"; }

# 1. Read what is about to be backed up, and which Bundle pins the DSH version.
preview exec -T runtime dsh-runtime status
preview run --rm --no-deps maintenance inspect

# 2. Take a matched backup and keep the id.
preview stop runtime
preview run --rm --no-deps maintenance backup | tee /tmp/backup-id
preview run --rm --no-deps maintenance backups

# 3. Prove the archive and its manifest are intact.
preview run --rm --no-deps maintenance check 20260101T120000Z.a1b2c3d4e5f6
```

Then rehearse the two outcomes the transaction can have:

| Scenario | What to run | What must be true afterwards |
| --- | --- | --- |
| Upgrade left Profile state unchanged | `verify` prints `unchanged`, then `rollback` | The old version serves again and the data is byte-identical to the backup. |
| Upgrade migrated Profile state | `verify` prints `MIGRATED`, then `restore <id>` | The old version serves again and the Profile state matches the pre-upgrade fingerprint. |

```sh
# Rehearsal A: pointer rollback.
preview run --rm --no-deps maintenance rollback
preview up -d --no-build --wait --wait-timeout 360 runtime
docker compose -f compose.preview.yml exec -T runtime dsh-runtime status

# Rehearsal B: matched data restore.
preview stop runtime
preview run --rm --no-deps maintenance restore 20260101T120000Z.a1b2c3d4e5f6
preview up -d --no-build --wait --wait-timeout 360 runtime
```

A restore replaces every top-level entry of DSH_HOME except `runtime` and `pnpm`, so the installed versions, the pnpm store and the audit log survive it. It does not touch the workspace, Chromium profile, or Auth database: restore those from their own backups when the migration affected them.

Record the observed outcome in the deployment log. `preview run --rm --no-deps maintenance audit` prints the transaction trail (`start`, `switched`, `verified`, `pointer-rollback`, `restored`, `script-approved`) with no credentials.

The automated drill in `deploy/ci-upgrade.sh` exercises the same path on GitHub-hosted runners: a Bundle pin that blocks a switch, an unapproved lifecycle script, the approved upgrade with its manifest, `verify` before and after a synthetic migration, pointer rollback that leaves migrated data in place, a matched restore, refusal of a tampered archive and an unknown id, recreation, and a Runtime image rollback with the restored data.
