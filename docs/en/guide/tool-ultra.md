# Tool Ultra

Tool Ultra is the Swiftnest owner's DSH plugin ([source](https://github.com/lvy-jsd/dsh-tool-ultra), Apache-2.0). Models browse or search the catalog, then load native tools as needed, reducing the tool definitions sent on each turn. Until the finished product is released, Swiftnest builds commit `8ccfefa1a922ad407e57ecbe6ea8b68e24adcbd9`; Tool Ultra is not published to npm.

## Install and enable

With Git, npm, Node 24 and network access available, use the same server config and data home:

```sh
swiftnest-server tools install --config swiftnest.yaml
swiftnest-server start --config swiftnest.yaml
```

In a source checkout, use `node server/dist/cli.js tools install`. The config file is optional. If you set `SWIFTNEST_HOME`, use the same value for both commands.

Installation fetches only the pinned commit into `<home>/vendor/dsh-tool-ultra-8ccfefa1a922`, runs `npm ci` with a lockfile shipped by Swiftnest, then `npm run build`. A marker is written only after success. Repeated installation reuses it; failed installs are cleaned up and can be retried. Host dependency links resolve to the Server's own DSH. Installation neither uses nor publishes Tool Ultra packages on npm.

`toolUltra` defaults to `true`. Startup prints a hint and continues if the build is missing; it never downloads source automatically. Disable it with:

```yaml
toolUltra: false
```

Or set `SWIFTNEST_TOOL_ULTRA=false`; the environment takes precedence. Restart the Server after installation.

The build applies a dependency override to `mathjs 15.2.0` to fix the source dependency's [expression execution vulnerability](https://github.com/josdejong/mathjs/security/advisories/GHSA-29qv-4j9f-fjw5). The source commit and plugin defaults remain unchanged.

## Tools and approvals

The enabled packages are `core`, `classifier-rules`, `risk-gate`, `persist`, `pack-essentials`, `pack-web` and `devices`. Defaults come from their own `cordis.patch.yml` files, with absolute module paths in generated DSH `insert` rows. Put overrides in `<home>/dsh/profiles/swiftnest/user.patch.yml`, which applies last and is never overwritten. DSH replaces a row's whole `config`, so retain the other fields you need when overriding it.

Models use `tools_ls` to browse, `tools_find` to search and `tools_load` to load tools. For example:

```json
{ "targets": ["device:all"] }
```

This loads paired device tools, making `device__<slug>__<capability>` available on the next model step. Use `device:<slug>/files` to narrow the area. Loading does not execute tools or bypass device permissions.

High-risk tools must be loaded individually. The risk gate asks through DSH's `approval-request` interaction. App chat shows the tool and reason, with one-time approval and denial buttons. Missing answers or cancellation grant no permission. Device execution approval is a separate step, still enforced by the Nest's device policy.

## Verify

After building, developers can run:

```sh
pnpm build
SWIFTNEST_TOOL_ULTRA_E2E=1 pnpm vitest run server/test/tool-ultra.e2e.test.ts
```

The test uses a temporary home, the real DSH kernel, a scripted model and a paired Node Perch. To exercise approval and denial in the App too, build the App, prepare Chromium and also set `SWIFTNEST_WEB_E2E=1` (`SWIFTNEST_CHROMIUM` can select a browser). CI runs this complete flow.
