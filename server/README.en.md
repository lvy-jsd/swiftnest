# Swiftnest Server

English | [中文](README.md)

Swiftnest Server runs on an always-on machine and holds your conversations, bots and memory. It embeds a pinned
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH, MIT) as its kernel and adds Swiftnest's
built-in modules as a DSH bundle (`server/bundle`). DSH's own Web UI keeps working on the same port, and third-party
DSH plugins still install into it.

The server hosts the Nest and a pinned DSH kernel, serves the App at `/app/` and health at
`/swiftnest/health`, and routes agent tools to paired Perches. The App handles device pairing, fingerprint
confirmation, revocation and risky-call approvals. Device-side desktop/Android integration comes separately.
See [Devices](../docs/en/guide/devices.md) for pairing, approvals and the typed API.

## Run it

Requirements: Node 24 **from nodejs.org** (DSH's native addon does not recognize distro or Nix builds of Node;
on NixOS use `nix develop` from the repo root) and an OpenAI-compatible model server such as Ollama.

```sh
pnpm install && pnpm build
pnpm --filter @swiftnest/app build:web
SWIFTNEST_MODEL_BASE_URL=http://127.0.0.1:11434/v1 SWIFTNEST_MODEL_ID=qwen3 \
  node server/dist/cli.js start
```

It prints three links valid until restart: DSH Web UI, the pairing URL to paste into the desktop App,
and **App (web)** (`<root>/app/#/pair?url=<encoded pairing URL>`). Open the latter for one-click pairing,
then choose **New chat** and send a message. The App removes the pairing URL from its address bar and
remembers only the server root; browser authentication stays in the cookie jar. Pair again after a
reload, disconnect or server restart in phase 0. Treat launch-token links as secrets.

For other devices on the same Wi-Fi, set `SWIFTNEST_HOST` to the server's concrete LAN IP (not a wildcard)
and open its App (web) link. Plain HTTP is for trusted networks. The web App must share the API origin;
the desktop App instead injects native HTTP/WebSocket transports without weakening the kernel's trust
fence. See [client setup and permissions](../client/README.md).

`@swiftnest/server` resolves `dist` from the installed optional `@swiftnest/app` package. An explicit
`appDist` / `SWIFTNEST_APP_DIST` overrides that location; for a source checkout you can set
`SWIFTNEST_APP_DIST="$PWD/client/dist"`. Missing packages/builds return a clear 404 at `/app/` without
preventing the kernel or DSH UI from starting. The public shell needs no DSH authentication; API access
still requires pairing. Static routes reject traversal and escaping symlinks, set MIME types, use SPA
fallback for page routes, and cache hashed assets immutably (index responses are revalidated).

## Tool Ultra

[Tool Ultra](https://github.com/lvy-jsd/dsh-tool-ultra) (Apache-2.0) is enabled by default and provides on-demand tool loading, a tool catalog, a risk gate, native packs and device namespaces. Until the finished product is released, it is built from pinned commit `8ccfefa1a922ad407e57ecbe6ea8b68e24adcbd9` instead of being published to npm.

```sh
swiftnest-server tools install --config swiftnest.yaml
swiftnest-server start --config swiftnest.yaml
```

In a source checkout, substitute `node server/dist/cli.js` for `swiftnest-server`. Installation needs Git, npm, Node 24 and network access. Use the same config or `SWIFTNEST_HOME` for installation and startup. The checkout lives at `<home>/vendor/dsh-tool-ultra-8ccfefa1a922`; a successful build is reused and a failed install is cleaned up. Startup never downloads it: a missing build produces a hint and the server starts normally.

Disable it with YAML `toolUltra: false` or `SWIFTNEST_TOOL_ULTRA=false`. Defaults come from each package's `cordis.patch.yml`; the operator's `user.patch.yml` applies last. Risk-gate prompts for `tools_load` appear in App chat; device execution still passes the Nest's permission checks. See the [guide](../docs/en/guide/tool-ultra.md).

## Configure

Optional YAML file (`swiftnest-server start --config swiftnest.yaml`); environment variables override it.

| Field                                                  | Env                        | Default                                                                     |
| ------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------- |
| `toolUltra`                                            | `SWIFTNEST_TOOL_ULTRA`     | `true` (`false` disables)                                                   |
| `home`                                                 | `SWIFTNEST_HOME`           | `$XDG_DATA_HOME/swiftnest`                                                  |
| `host` (one concrete IP, never `0.0.0.0`)              | `SWIFTNEST_HOST`           | `127.0.0.1`                                                                 |
| `port`                                                 | `SWIFTNEST_PORT`           | `3077`                                                                      |
| `devices.host`                                         | `SWIFTNEST_DEVICES_HOST`   | server `host`                                                               |
| `devices.port`                                         | `SWIFTNEST_DEVICES_PORT`   | `7711`                                                                      |
| `devices.mdns`                                         | `SWIFTNEST_DEVICES_MDNS`   | `true` (`false` disables)                                                   |
| `appDist`                                              | `SWIFTNEST_APP_DIST`       | installed `@swiftnest/app/dist`, otherwise unavailable                      |
| `persona` (string)                                     | `SWIFTNEST_PERSONA`        | `You are a helpful assistant in Swiftnest, powered by the {{model}} model.` |
| `assistantName` (string)                               | `SWIFTNEST_ASSISTANT_NAME` | unset (Apps show "Assistant")                                               |
| `model.baseUrl`                                        | `SWIFTNEST_MODEL_BASE_URL` | `http://127.0.0.1:11434/v1`                                                 |
| `model.id`                                             | `SWIFTNEST_MODEL_ID`       | `qwen3`                                                                     |
| `model.name`, `model.contextWindow`, `model.maxTokens` |                            | `Local model`, `32768`, `8192`                                              |
| `model.apiKeyEnv` (name of the key variable)           |                            | `SWIFTNEST_MODEL_API_KEY`                                                   |
| Node binary for the kernel                             | `SWIFTNEST_KERNEL_NODE`    | the Node running Swiftnest                                                  |

The persistent Nest identity, paired devices, last-seen metadata and raw-argument audit live in
`<home>/devices/`. The loopback admin and MCP listeners have separate random per-process credentials,
passed to DSH through environment variables; generated patches contain no bearer value.

DSH's data lives in `<home>/dsh`. Swiftnest regenerates the `swiftnest` profile on every start; put your own DSH
patch rows in `<home>/dsh/profiles/swiftnest/user.patch.yml`, which is applied last and never overwritten.

`persona` sets both the shared system-prompt prefix and the persona in every shipped DSH agent preset;
DSH expands `{{model}}` to the model identity at runtime. For example:

```yaml
persona: "You are Robin, a helpful assistant in Swiftnest, powered by the {{model}} model."
```

On each start, the server derives preset overrides from the web bundle installed with the pinned DSH
kernel. It changes only persona prefixes, retaining the rest of each preset and its unevaluated `!!js`
expressions. Presets without a persona are left alone. Operator patches still take precedence; a DSH
patch replaces a row's whole `config`, so overriding a preset manually requires its complete config.

## Test

```sh
pnpm vitest run server                       # unit tests
SWIFTNEST_E2E=1 pnpm vitest run packages/api server # real kernel + fake model chat
SWIFTNEST_WEB_E2E=1 pnpm vitest run client/test/web.e2e.test.ts # optional Chromium App flow
```

Build the web App before the Chromium test. It skips cleanly when no browser can launch; set
`SWIFTNEST_CHROMIUM=/path/to/chrome` to use a system browser. No external model credentials are needed.

How the embedding works and why: [docs/en/dev/dsh-integration.md](../docs/en/dev/dsh-integration.md).

## Memory

Central memory is enabled by default. Open **Memory** in any App to edit facts and topics; the assistant uses `remember`, `forget` and `recall`. Data, the recovery journal and per-session frozen snapshots live under `<home>/memory/`. Existing sessions use `recall` to see later saves. Set `memory: { enabled: false }` or `SWIFTNEST_MEMORY=false` to disable it. See the [Memory guide](../docs/en/guide/memory.md) for limits, recovery and API details.
