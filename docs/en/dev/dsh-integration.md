# How Swiftnest Server embeds DSH

Status: verified by hand on 2026-11-01 against `@deepseek-ai/dsh@0.2.1-rc.5` (MIT). Sections marked
*to verify* are read from the package READMEs and still need a test.

## Pinned kernel

- `@deepseek-ai/dsh` is pinned to an **exact** version (`0.2.1-rc.5`) in `server/package.json`. DSH is a
  developer preview with breaking changes between releases; upgrading is a deliberate PR that runs the full
  e2e suite.
- The package is a launcher over *profiles*. A profile is a directory under `$DSH_HOME/profiles/<name>` with a
  `package.json` (`dsh.profile.bundles`, an ordered list of bundle packages) and a `cordis.patch.yml`. The tree
  is composed as: each bundle's patch in order → the profile's `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`
  → `--patch` overlays.
- Programmatic entry: `@deepseek-ai/dsh/profile-boot` (exports `initializeProfileFromDefault`, profile loading,
  `homePatchPath`, `INSTALL_ANCHOR`) and the CLI's `runCli()` in `lib/bin.js`. Shipped bundles:
  `dsh-base`, `dsh-web-app`, `dsh-headless`, `dsh-sdk-app`, `dsh-sdk-minimal`, `dsh-acp-app`.

## Node runtime requirement (important)

DSH loads the native addon `node-addon-require-builtin`, which pattern-matches machine code inside the `node`
binary. It **fails on Node built by Nix** (`Unsupported/no-getter` at host preparation) and works on the official
nodejs.org build of the same version (24.21.0). Consequences:

- The Docker image uses the official `node:24` image.
- The NixOS module and the dev shell must run the official Node binary (on NixOS via `nix-ld`, or a
  `fetchurl` of the nodejs.org tarball, checked by SHA-256), not `pkgs.nodejs_24`.
- `swiftnest-server doctor` should detect this failure and print a clear message.

## Model configuration (verified)

An OpenAI-compatible endpoint (Ollama, TabbyAPI, LiteLLM, vLLM…) is a provider of the `llm-pi-ai` row; the default
model is the `agent-default-model` row:

```yaml
- id: llm-pi-ai
  config:
    providers:
      local:
        displayName: Local model
        api: openai-completions
        apiKeyEnv: SWIFTNEST_LOCAL_API_KEY   # required even if the server ignores keys; any value works
        baseURL: http://127.0.0.1:11434/v1
        models:
          - { id: qwen3, name: Qwen 3, contextWindow: 131072, maxTokens: 8192, input: [text] }
- id: agent-default-model
  config:
    provider: local
    model: qwen3
```

Without `apiKeyEnv` (and the variable set) a turn fails with `PI_AI_ERROR: No API key for provider: local`.
Overriding `session-title-llm` requires all of its fields (`targetWords`, …); leave it alone unless needed.

With that patch as `$DSH_HOME/cordis.patch.yml`, `dsh --profile headless "<prompt>"` answered through a local
27B model in one turn.

## Web host and native API (verified)

- `dsh --profile web --no-open --port <p>` serves the DSH Web UI and its native API on loopback and prints a
  `dsh web:` URL carrying a per-process launch token.
- Non-browser clients authenticate with `GET /connect?token=<launch token>&interactions=answer|none`, which
  answers `302 ./api/remote.mux` and sets a signed API cookie. Unauthenticated `/api` answers `401`.
- Transport: unary RPC is `POST /api` (JSON, multipart for byte attachments); streams run over the
  `/api/remote.mux` WebSocket. One API socket owns its Peer; a second attachment is `409`.
- `--host <one concrete IP>` exposes it on the LAN (plain HTTP warns); `--tls-cert/--tls-key` serve HTTPS;
  `--trusted-host` adds accepted authorities.
- DSH ships its own client stack: `@deepseek-ai/dsh-client-connection` (`./client` export: Node ESM bundle and
  browser loader), `dsh-api-session-controller` (sessions: list, create, follow/page history, prompt, queue),
  `dsh-user-approval`, `dsh-user-questions`. *To verify*: that these run outside a DSH-served page (Node and a
  Tauri WebView) with `ClientTransportHooks.createWebSocket`.

## Decisions for phase 0

1. **Server = profile, not fork.** `@swiftnest/server` creates/updates a profile named `swiftnest` whose bundles
   are `@deepseek-ai/dsh-web-app` and our `@swiftnest/server-bundle`, writes our patch layer (model config from
   the Swiftnest config file), and boots it in-process through `profile-boot`. DSH's own Web UI keeps working on
   the same port, which is the compatibility promise.
2. **Built-in modules are Cordis plugins in `@swiftnest/server-bundle`.** Phase 0 ships one: `swiftnest-core`,
   which registers `GET /swiftnest/health` (version, DSH version, model reachability) on `ctx.webServer`.
3. **`@swiftnest/api` wraps DSH's published client packages** for sessions and events instead of re-implementing
   the wire protocol, plus small typed helpers for Swiftnest's own `/swiftnest/*` routes. If the spike shows the
   DSH client cannot run in a WebView, fall back to a thin `/swiftnest/v0/*` HTTP + SSE façade served by
   `swiftnest-core` and record the decision here.
4. **Phase 0 pairing is a URL.** The server prints `http://<lan-ip>:<port>/connect?token=…`; the client accepts it
   pasted or scanned. Long-lived per-device credentials come with the gateway module in phase 2.
