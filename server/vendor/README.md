# Tool Ultra build lock

`tool-ultra.package-lock.json` locks the npm workspace dependencies for
`https://github.com/lvy-jsd/dsh-tool-ultra` at commit
`4c593acee080dc615b651348e70c4ae6ec5217a5` (Apache-2.0). That source deliberately
omits a lockfile. Swiftnest copies this file into its isolated checkout before
`npm ci`; no Tool Ultra package is fetched from npm. DSH peers are linked from
the Server's pinned host, using upstream's `postinstall` script.

`tool-ultra-overrides.json` is merged into the checkout root's npm `overrides`
before installation. It pins mathjs to 15.2.0 because the source's `^14.0.0`
range is affected by [GHSA-29qv-4j9f-fjw5](https://github.com/josdejong/mathjs/security/advisories/GHSA-29qv-4j9f-fjw5)
and [GHSA-jvff-x2qm-6286](https://github.com/josdejong/mathjs/security/advisories/GHSA-jvff-x2qm-6286).
The upstream source is unchanged. Media limits come from its patch; Swiftnest narrows its file folders and sets the speech cache and download mirror in the generated profile.

A root `overrides` entry is not enough on its own: npm resolves a workspace's
**own** dependency range, so the calculator workspace kept declaring `^14.0.0`
and npm installed 14.9.1 — the version the advisories apply to — while the root
override said 15.2.0. The host therefore applies the override in both places:
the root manifest, and the range inside every workspace that declares the
package. `npm ci` also refuses to run while the two disagree, which is how the
mismatch surfaced.

When changing the pin, generate a fresh lock in a scratch checkout of the new
commit. First merge `tool-ultra-overrides.json` into its root manifest's `overrides`
**and** into the range of each workspace that declares the package,
then generate the lock with `npm install --package-lock-only --package-lock=true --ignore-scripts`,
then run the opt-in installation/kernel/device/approval e2e test. Never edit
package defaults here: they are read from the pinned source's patch files.

The existing lock is reused for this pin: `4e5c418`..`4c593ac` reserves every classifier batch key before its first model request, preventing catalog refreshes from queueing duplicate requests. Only classifier code and regression tests changed; no manifest or dependency graph changed. Regenerate the lock whenever a future pin changes a manifest.

The media pack now uses `sherpa-onnx-node` with its platform-specific CPU
binaries. Transformers.js, `onnxruntime-node` and `onnxruntime-web` are no longer
in this lock; `ONNXRUNTIME_NODE_INSTALL=skip` is therefore removed. Keep npm
lifecycle scripts and optional dependencies enabled: the sherpa native binding
and its platform libraries must be available. The existing mathjs override
remains necessary for the upstream calculator's dependency range.
