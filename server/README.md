# Swiftnest Server

English | [中文](README.zh-CN.md)

Swiftnest Server runs on an always-on machine and holds your conversations, bots and memory. It embeds a pinned
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH, MIT) as its kernel and adds Swiftnest's
built-in modules as a DSH bundle (`server/bundle`). DSH's own Web UI keeps working on the same port, and third-party
DSH plugins still install into it.

Status: phase 0 skeleton. It boots the kernel, configures one OpenAI-compatible model and serves
`GET /swiftnest/health`. Teams, memory, pairing and devices come in later phases.

## Run it

Requirements: Node 24 **from nodejs.org** (DSH's native addon does not recognize distro or Nix builds of Node;
on NixOS use `nix develop` from the repo root) and an OpenAI-compatible model server such as Ollama.

```sh
pnpm install && pnpm build
SWIFTNEST_MODEL_BASE_URL=http://127.0.0.1:11434/v1 SWIFTNEST_MODEL_ID=qwen3 \
  node server/dist/cli.js start
```

It prints two links that stay valid until restart: one for the DSH Web UI in a browser, and one for the
Swiftnest App.

## Configure

Optional YAML file (`swiftnest-server start --config swiftnest.yaml`); environment variables override it.

| Field | Env | Default |
|---|---|---|
| `home` | `SWIFTNEST_HOME` | `$XDG_DATA_HOME/swiftnest` |
| `host` (one concrete IP, never `0.0.0.0`) | `SWIFTNEST_HOST` | `127.0.0.1` |
| `port` | `SWIFTNEST_PORT` | `3077` |
| `model.baseUrl` | `SWIFTNEST_MODEL_BASE_URL` | `http://127.0.0.1:11434/v1` |
| `model.id` | `SWIFTNEST_MODEL_ID` | `qwen3` |
| `model.name`, `model.contextWindow`, `model.maxTokens` | | `Local model`, `32768`, `8192` |
| `model.apiKeyEnv` (name of the key variable) | | `SWIFTNEST_MODEL_API_KEY` |

DSH's data lives in `<home>/dsh`. Swiftnest regenerates the `swiftnest` profile on every start; put your own DSH
patch rows in `<home>/dsh/profiles/swiftnest/user.patch.yml`, which is applied last and never overwritten.

## Test

```sh
pnpm vitest run server                       # unit tests
SWIFTNEST_E2E=1 pnpm vitest run server       # also boots the real kernel
```

How the embedding works and why: [docs/en/dev/dsh-integration.md](../docs/en/dev/dsh-integration.md).
