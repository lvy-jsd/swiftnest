# Tool Ultra build lock

`tool-ultra.package-lock.json` locks the npm workspace dependencies for
`https://github.com/lvy-jsd/dsh-tool-ultra` at commit
`9644ca819e302b90a781ac17b10042c63b7e9d33` (Apache-2.0). That source deliberately
omits a lockfile. Swiftnest copies this file into its isolated checkout before
`npm ci`; no Tool Ultra package is fetched from npm. DSH peers are linked from
the Server's pinned host, using upstream's `postinstall` script.

`tool-ultra-overrides.json` is merged into the checkout root's npm `overrides`
before installation. It pins mathjs to 15.2.0 because the source's `^14.0.0`
range is affected by [GHSA-29qv-4j9f-fjw5](https://github.com/josdejong/mathjs/security/advisories/GHSA-29qv-4j9f-fjw5)
and [GHSA-jvff-x2qm-6286](https://github.com/josdejong/mathjs/security/advisories/GHSA-jvff-x2qm-6286).
The upstream source is unchanged. Media limits come from its patch; Swiftnest narrows its file folders and sets the speech cache and download mirror in the generated profile.

When changing the pin, generate a fresh lock in a scratch checkout of the new
commit. First merge `tool-ultra-overrides.json` into its root manifest's `overrides`,
then generate the lock with `npm install --package-lock-only --package-lock=true --ignore-scripts`,
then run the opt-in installation/kernel/device/approval e2e test. Never edit
package defaults here: they are read from the pinned source's patch files.

The lock was regenerated for this pin with the override above; its dependency graph is unchanged from the previous media pin.

The media pack now uses `sherpa-onnx-node` with its platform-specific CPU
binaries. Transformers.js, `onnxruntime-node` and `onnxruntime-web` are no longer
in this lock; `ONNXRUNTIME_NODE_INSTALL=skip` is therefore removed. Keep npm
lifecycle scripts and optional dependencies enabled: the sherpa native binding
and its platform libraries must be available. The existing mathjs override
remains necessary for the upstream calculator's dependency range.
