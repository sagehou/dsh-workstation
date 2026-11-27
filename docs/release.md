# Releasing images

English · [简体中文](release.zh-CN.md)

The current source builds `dsh-workstation-runtime` and `dsh-workstation-gateway` for public release on GHCR. Provider and the input gate ship inside Gateway. Compose pins the upstream LinuxServer Chromium image and mounts the checkout's CDP relay and Selkies access script at startup.

A deployment never references a tag alone. `deploy/public/images.env` records a
manifest-list digest per image, and `deploy/public/images.sh` turns those into
`ghcr.io/sagehou/<name>:<version>@sha256:...` references. A missing digest is an
error, so there is no code path from that file to a floating tag.

## Current deployment

The `deploy/public/release-commit` file records the commit with the
published digests, currently `81feffd`. That deployment uses Runtime 0.2.1,
Auth 0.1.1, Provider 0.2.0 and browser-gate 0.1.0. Use its Compose and initializer
together. [Published deployment verification](https://github.com/sagehou/dsh-workstation/actions/runs/45816293100/job/139896902377)

The three-service candidate builds Runtime 0.2.2 and Gateway 0.1.0. Their release digests are pending. [Image inventory](../deploy/public/images.env) · [Gateway migration](../deploy/public/README.md#migrate-from-the-auth-service) · [Tracking issue](https://github.com/sagehou/dsh-workstation/issues/36)

## What guarantees the chain

| Property | How |
| --- | --- |
| Fork PRs cannot publish | The workflow has no `pull_request` trigger. Only `push: tags` and `workflow_dispatch` run it, and neither is reachable from a fork. |
| Untrusted input never meets a credential | The `plan` job holds no registry credential and only reads the tracked image list. `publish` receives its matrix from `plan` and validates image names against `deploy/public/images.sh`. |
| A tag cannot be republished with different content | If `images.env` already records a digest for that version, publishing a different one fails instead of overwriting a reference a deployment may already run. |
| A release cannot be triggered from a fork | Publishing needs a `v*` tag or a manual dispatch by someone with write access. There is no approval prompt and none is claimed: this repository has one operator, who is also the only person who can trigger a publish, so a second reviewer would add a click rather than a control. The triggers are the gate. |
| Provenance travels with the image | `provenance: mode=max` and `sbom: true` attach attestations to the digest, not to the Actions run. |
| The published tag is the one a deployment reads | The resolver supplies the image name in both the workflow and the initializer. |
| `latest` cannot be deployed | The resolver only accepts `X.Y.Z`, and no workflow produces a `latest` tag. |
| The images really are public | The `record` job pulls each newly published digest with no login. The deployment CI checks the full set. |

## One-time setup (repository administrator)

1. After a first publish, confirm each package's visibility is **Public** under
   the package settings. A package created by a job without `packages: write`
   can end up private even in a public repository; `record` fails if that
   happens, but the visibility itself is a repository setting, not code.
2. Protect `v*` tags so only a maintainer can create one. This is the control
   that matters, because a tag is a publish trigger.

There is deliberately **no approval environment**. A `ghcr-release` environment
with no required reviewers does not gate anything, and describing it as an
approval gate would overstate what is enforced. If this ever becomes a
multi-operator repository, add required reviewers *and* re-test that the gate
actually blocks a tag push before claiming it.

No repository secret is required: the workflow uses the automatic
`GITHUB_TOKEN`, restricted to `packages: write` in the `publish` job only.

## Publishing

1. Bump the version for each image you are changing in
   `deploy/public/images.env`. Clear its digest — the release is what fills it
   in. Runtime and Gateway versions are independent.
2. Merge that change.
3. Run **Publish images** from `main` (`image: all`), or create a new
   `v<version>` tag on the release source commit.
   The `all` selection publishes the versions with empty digests.

   Each image has its own version. The tag identifies the build source, and the
   workflow records the image references by digest.
4. Download the `published-images` artifact, verify the digests against
   `docker buildx imagetools inspect`, and commit the updated
   `deploy/public/images.env`.

5. Update `deploy/public/release-commit` to the full SHA of the deployment commit
   with those digests, and check the `release-compose` job. The job uses that
   commit's Compose and probes and pulls its exact images anonymously.

The old `dsh-workstation-auth` image remains available for the older deployment.
See [the Gateway migration](../deploy/public/README.md#migrate-from-the-auth-service).

## Verifying a published image

Run the checks from the deployment commit for the release you are verifying.

```bash
resolved="$(bash deploy/public/images.sh runtime)" &&
  image="${resolved#*=}"

# The recorded digest and the registry's digest for that tag must match.
printf '%s\n' "${image#*@}"
docker buildx imagetools inspect "${image%@*}" --format '{{json .Manifest.Digest}}'

# An anonymous pull, which is what a deployment host does.
docker pull "$image"
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
| A digest reference pulls and runs | CI tests the resolver against a loopback registry. The `release-compose` artifact records the published digests, matching deployment commit and end-to-end result. |
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

- Upgrade and rollback across two real releases on a deployment host has not
  been run; there is only one release. The digest mechanism itself is proven,
  but not the operator procedure on a real host.
- Only `linux/amd64` is published. There is no multi-architecture claim.
