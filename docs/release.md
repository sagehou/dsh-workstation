# Releasing images

English · [简体中文](release.zh-CN.md)

The four images this repository builds are published to GHCR as **public**
packages: `dsh-workstation-runtime`, `dsh-workstation-auth`,
`dsh-workstation-provider` and `dsh-workstation-browser-gate` (built from
`browser-gate/`).

A deployment never references a tag alone. `deploy/public/images.env` records a
manifest-list digest per image, and `deploy/public/images.sh` turns those into
`ghcr.io/sagehou/<name>:<version>@sha256:...` references. A missing digest is an
error, so there is no code path from that file to a floating tag.

## What guarantees the chain

| Property | How |
| --- | --- |
| Fork PRs cannot publish | The workflow has no `pull_request` trigger. Only `push: tags` and `workflow_dispatch` run it, and neither is reachable from a fork. |
| Untrusted input never meets a credential | The `plan` job holds no registry credential and only reads the tracked image list. `publish` receives its matrix from `plan` and validates image names against `deploy/public/images.sh`. |
| A tag cannot be republished with different content | If `images.env` already records a digest for that version, publishing a different one fails instead of overwriting a reference a deployment may already run. |
| A release is gated on approval | `publish` targets the `ghcr-release` environment. Add required reviewers there and every publish waits for a person, including a tag push. |
| Provenance travels with the image | `provenance: mode=max` and `sbom: true` attach attestations to the digest, not to the Actions run. |
| The published tag is the one a deployment reads | The resolver supplies the image name in both the workflow and the initializer. |
| `latest` cannot be deployed | The resolver only accepts `X.Y.Z`, and no workflow produces a `latest` tag. |
| The images really are public | The `record` job pulls every recorded digest with no login. A package accidentally left private fails the run. |

## One-time setup (repository administrator)

1. Create the `ghcr-release` environment under **Settings → Environments** and
   add at least one required reviewer. Without this, a tag push publishes
   immediately.
2. After the first publish, confirm each package's visibility is **Public**
   under the package settings (they inherit public visibility from a public
   repository, but a package created by a private run may not).
3. Protect `v*` tags so only a maintainer can create one.

No repository secret is required: the workflow uses the automatic
`GITHUB_TOKEN`, restricted to `packages: write` in the `publish` job only.

## Publishing

1. Bump the version for each image you are changing in
   `deploy/public/images.env`. Clear its digest — the release is what fills it
   in. Versions are independent: the Runtime image changes with Node or the
   launch script, the gate on its own schedule.
2. Merge that change.
3. Run **Publish images** from `main` (`image: all`), or create a tag
   `v<version>` — for example `v0.2.0` — to mark the release point.
4. Approve the `ghcr-release` environment when prompted.
5. Download the `published-images` artifact, verify the digests against
   `docker buildx imagetools inspect`, and commit the updated
   `deploy/public/images.env`.

Step 5 is deliberate: the workflow cannot commit, so a person confirms the
digests before they become what deployments pin. The run summary lists the
references ready to paste.

## Verifying a published image

```bash
# The digest the resolver will deploy.
bash deploy/public/images.sh --field digest runtime

# What the registry reports for that tag. The two must match exactly.
docker buildx imagetools inspect \
  ghcr.io/sagehou/dsh-workstation-runtime:0.2.0 --format '{{json .Manifest.Digest}}'

# An anonymous pull, which is what a deployment host does.
docker pull ghcr.io/sagehou/dsh-workstation-runtime:0.2.0@sha256:...
```

## Platform

`linux/amd64` only. The Runtime image installs official DSH at container start
rather than baking it in, so the image version and the DSH version are
independent: updating the image does not change which DSH version runs.

## Relationship to the Actions artifacts

**Public Compose** still uploads an image archive. That is audit evidence of
what a run executed and is retained for 90 days; it is not a distribution
channel and the install guide no longer uses it.

## Not yet verified

- The four images have not yet been published to GHCR from this repository. The
  workflow, the resolver and the initializer's `--release` mode are tested
  locally and in CI, but the first real publish is what proves the GHCR
  round-trip, the anonymous pull, and the upgrade/rollback drill on a host.
- Upgrade and rollback by digest across two real releases has not been executed;
  there is only one release to date.
