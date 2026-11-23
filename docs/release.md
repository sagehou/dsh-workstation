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

   A `v*` tag names the **repository's** release point, not a shared image
   version. The four images are versioned independently, so a tag `v0.2.0` may
   publish `runtime:0.2.0`, `auth:0.1.1`, `provider:0.2.0` and
   `browser-gate:0.1.0`. That is intentional: forcing one number would couple
   unrelated changes. The tag is useful because it marks which source commit a
   set of digests came from, and the generated release notes list all four.
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
  ghcr.io/sagehou/dsh-workstation-runtime:0.2.1 --format '{{json .Manifest.Digest}}'

# An anonymous pull, which is what a deployment host does.
docker pull ghcr.io/sagehou/dsh-workstation-runtime:0.2.1@sha256:...
```

## Platform

`linux/amd64` only. The Runtime image installs official DSH at container start
rather than baking it in, so the image version and the DSH version are
independent: updating the image does not change which DSH version runs.

## Relationship to the Actions artifacts

**Public Compose** still uploads an image archive. That is audit evidence of
what a run executed and is retained for 90 days; it is not a distribution
channel and the install guide no longer uses it.

## What is measured

| Check | Evidence |
| --- | --- |
| A digest reference pulls and runs | CI publishes a build to a loopback registry, resolves `localhost:<port>/name:version@sha256:...` through the real resolver, removes the local tags and pulls it back, then inspects the image ID. The `release-compose` job also pulls the four real GHCR digests with no credential, builds nothing, and passes the same stack checks. |
| Upgrade follows a new digest | A second build under a new version produces a distinct digest, and the resolver follows it. |
| Rollback restores exactly the earlier image | Restoring the first digest pulls back an image whose ID equals the original pull. |
| A missing digest fails rather than drifting to a tag | The resolver, its 18 shell checks and the initializer all fail. Verified by temporarily making the resolver fall back to a tag, which made three resolver checks and the `--release` initializer check fail. |
| The override cannot redirect a deployment | A registry other than `ghcr.io/sagehou` or a loopback test registry is refused. |
| `compose.yml` and the resolver agree | Both directions asserted: every published image is consumed through its override key, and no override key exists without a published image. |

The loopback registry is deliberate: `WORKSTATION_IMAGE_REGISTRY` accepts only
GHCR or a loopback address, so this test cannot masquerade as a publish.

### The first release, 2026-11-23

Tag `v0.2.0` published four images:

| Image | Version | Manifest list digest |
| --- | --- | --- |
| `dsh-workstation-runtime` | 0.2.0 | `sha256:61dddb88c65ac8ee9cd891317b1b6f675384266c87f6ef428ba1b13e5cc33cff` (broken; superseded by 0.2.1) |
| `dsh-workstation-auth` | 0.1.1 | `sha256:7a25eb333de2091ec1d1a622864cfa83b1aed5b22c42522a741e6fd946e1a2f6` |
| `dsh-workstation-provider` | 0.2.0 | `sha256:240c662037662cd3719eb50a572f972f5d8b1434df90e90448ce21658412393f` |
| `dsh-workstation-browser-gate` | 0.1.0 | `sha256:fc265c6f36806def3401c86925588671721f6cade13070c55aaf7284d3606c5f` |

Checked against the registry independently of the workflow: each tag's
`Docker-Content-Digest` equals the recorded value, each manifest list carries a
`linux/amd64` target, and each digest resolves with an **anonymous** pull token,
which is what shows the packages are public rather than merely present.

The first attempt failed, and the failures were real:

1. The build job ran `${reference%%:*}` on the resolver's whole
   `name=reference` line, producing the tag
   `ghcr.io/sagehou/runtime=dsh-workstation-runtime:0.2.1`. Two further call
   sites in the `record` job had the same bug. Fixed, and `images.test.sh` now
   asserts every workflow assignment from the resolver is followed by the
   prefix strip.
2. `public-compose.yml` did not watch `.github/workflows/publish-images.yml`, so
   the guard that would have caught (1) never ran on the change that broke it.
3. The `record` job failed **after** all four pushes succeeded, on its own test:
   two tests had assumed the checked-in matrix was unpublished, so filling in
   real digests broke them. Pulls and visibility were then verified by hand.
   The tests now construct the unpublished state instead of reading it.

Then `runtime:0.2.0` turned out to be unusable, and the release leg added in the
same branch is what found it:

```
runtime-1 | dsh-runtime: cannot locate compat.mjs and state.mjs
```

The published layer had `usr/local/lib/dsh-runtime/` at mode **0644**. `COPY
--chmod` applies to the directories it creates, not only to the file named, so
the module directory lost its execute bit; the container runs as `node`, could
not enter it, and the helper lookup failed. A locally built image happened to be
unaffected, so every stack test passed while the published artifact was broken.
Naming each file's full path was not enough — the parent is still created by
COPY. Creating the directory with `install -d -m 0755` before any COPY is what
fixes it; the published layers now show `0000755 DIR`.

`publish` now smoke-tests the image **before** pushing, so this class of defect
cannot reach a tag at all: a version that fails the check is never published, and
an already-published version is refused rather than overwritten. Runtime is
therefore `0.2.1`, and `0.2.0` remains published and broken. That is deliberate:
retracting a digest someone may have pinned is worse than leaving it visibly
superseded.

| `dsh-workstation-runtime` | 0.2.1 | `sha256:8fabc8a912436e85f17e83166ef2584f19110cd7428a1ce3ca8434a64926fc6a` |

## Not yet verified

- Approval gating requires an administrator to add required reviewers to the
  `ghcr-release` environment. Until that is done a tag push publishes without a
  gate, which is what happened for `v0.2.0`. This cannot be asserted from code.
- Upgrade and rollback across two real releases on a deployment host has not
  been run; there is only one release. The digest mechanism itself is proven,
  but not the operator procedure on a real host.
- Only `linux/amd64` is published. There is no multi-architecture claim.
