# Swiftnest Server

English | [中文](README.zh-CN.md)

Swiftnest Server runs on an always-on machine and holds your conversations, bots and memory. It embeds a pinned
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH, MIT) as its kernel and adds Swiftnest's
built-in modules as a DSH bundle (`server/bundle`). DSH's own Web UI keeps working on the same port, and third-party
DSH plugins still install into it.

Status: phase 0 chat. It boots the kernel, configures one OpenAI-compatible model, serves
`GET /swiftnest/health` and the Swiftnest web App at `/app/`, and supports URL pairing for web and desktop.
Teams, memory, per-device credentials and Android packaging come later.

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

## Configure

Optional YAML file (`swiftnest-server start --config swiftnest.yaml`); environment variables override it.

| Field | Env | Default |
|---|---|---|
| `home` | `SWIFTNEST_HOME` | `$XDG_DATA_HOME/swiftnest` |
| `host` (one concrete IP, never `0.0.0.0`) | `SWIFTNEST_HOST` | `127.0.0.1` |
| `port` | `SWIFTNEST_PORT` | `3077` |
| `appDist` | `SWIFTNEST_APP_DIST` | installed `@swiftnest/app/dist`, otherwise unavailable |
| `model.baseUrl` | `SWIFTNEST_MODEL_BASE_URL` | `http://127.0.0.1:11434/v1` |
| `model.id` | `SWIFTNEST_MODEL_ID` | `qwen3` |
| `model.name`, `model.contextWindow`, `model.maxTokens` | | `Local model`, `32768`, `8192` |
| `model.apiKeyEnv` (name of the key variable) | | `SWIFTNEST_MODEL_API_KEY` |
| Node binary for the kernel | `SWIFTNEST_KERNEL_NODE` | the Node running Swiftnest |

DSH's data lives in `<home>/dsh`. Swiftnest regenerates the `swiftnest` profile on every start; put your own DSH
patch rows in `<home>/dsh/profiles/swiftnest/user.patch.yml`, which is applied last and never overwritten.

## Test

```sh
pnpm vitest run server                       # unit tests
SWIFTNEST_E2E=1 pnpm vitest run packages/api server # real kernel + fake model chat
SWIFTNEST_WEB_E2E=1 pnpm vitest run client/test/web.e2e.test.ts # optional Chromium App flow
```

Build the web App before the Chromium test. It skips cleanly when no browser can launch; set
`SWIFTNEST_CHROMIUM=/path/to/chrome` to use a system browser. No external model credentials are needed.

How the embedding works and why: [docs/en/dev/dsh-integration.md](../docs/en/dev/dsh-integration.md).
