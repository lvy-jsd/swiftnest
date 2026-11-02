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

## Persona configuration

`ServerConfig.persona` / YAML `persona` is a string, overridden by `SWIFTNEST_PERSONA`. Its default is
a Chinese assistant persona by default, or `You are a helpful assistant in Swiftnest, powered by the {{model}} model.` with `lang: en`. DSH expands `{{model}}`
at runtime. The generated profile owns both `system-prompt.config.personaPrefix` and preset persona
prefixes; the static Swiftnest bundle has no separate persona text.

Changing only `system-prompt` is insufficient: DSH Web's agent presets mount their own
`@deepseek-ai/dsh-persona` plugins, whose prefixes otherwise identify a coding agent. Because a Cordis
patch replaces the target row's **whole config**, `server/src/profile.ts` resolves
`@deepseek-ai/dsh-web-app/package.json` from the installed, pinned `@deepseek-ai/dsh` package and reads
its `presets/*.patch.yml` on each start. It emits an override for each preset with a persona, retaining
the complete original row and changing only `config.plugins[].config.prefix` on the persona plugin.
Rows with no persona and unrecognized shapes produce no override.

The pinned presets use the custom scalar tag `!!js` for deferred runtime expressions (platform checks,
profile context and skill paths). The generator registers this tag with `yaml` as an inert string,
uses the AST to locate prefix scalars, and copies the original row source with just those spans
replaced and the insert wrapper's indentation removed. It never evaluates expressions or serializes
them as ordinary strings; tags, expressions, comments and all other fields survive unchanged.
`user.patch.yml` is still applied last and never overwritten. Real preset fixture tests check byte
preservation, and real-kernel fake-model chat tests check the received system prompt with both the
default and a configured persona.

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
   are `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` and our `@swiftnest/server-bundle`, writes our patch layer
   (model config from the Swiftnest config file), and boots it in a child process. DSH's own Web UI keeps working on
   the same port, which is the compatibility promise.
2. **Built-in modules are Cordis plugins in `@swiftnest/server-bundle`.** Phase 0 ships one: `swiftnest-core`,
   which registers `GET /swiftnest/health` (version, DSH version, model reachability) on `ctx.webServer`.
3. **`@swiftnest/api` first tries DSH's published clients** for sessions and events, plus typed helpers for
   Swiftnest's own `/swiftnest/*` routes. The verified B1 spike below required the minimal native-wire
   fallback; no façade is needed.
4. **Phase 0 pairing is a URL.** The server prints `http://<lan-ip>:<port>/connect?token=…`; the client accepts it
   pasted or scanned. Long-lived per-device credentials come with the gateway module in phase 2.


## @swiftnest/api

Verified on 2026-11-01 against **exactly 0.2.1-rc.5**, using published MIT package declarations and bundled
sources in `node_modules`, followed by the real-kernel acceptance test. The wrapper is Apache-2.0 and
keeps every DSH type private; App code imports only `@swiftnest/api`.

### Published-client spike and decision

- `@deepseek-ai/dsh-client-connection/client` has a genuine `client.node.js` ESM entry.
  `installConnection(ctx, {transport: {fetch, createWebSocket, streamBaseUrl}})` can use non-page carriers;
  `window.__DSH_BOOT__` is not required by that explicit installation path. A direct Node import succeeds.
- Its browser export, `client.browser.js`, is **a ModuleLoader registration**, beginning with
  `window.__ModuleLoader__.load(...)`, not a standalone ESM client.
- `@deepseek-ai/dsh-api-session-controller/client` has only that same ModuleLoader form in `lib/client.js`.
  Direct Node import fails with `ReferenceError: window is not defined`. The `/remote` export is ordinary
  ESM containing generated endpoint descriptors and schemas, not a standalone transport/session runtime.
  The lower-level gateway has Node ESM, but its browser entry uses
  the same page loader. Thus injecting WebSocket alone does not make the published stack portable to an
  independent App build. Installing fake page globals or transplanting DSH's loader is unnecessary scope.
- **Decision:** implement the small observed JSON RPC + mux protocol within `packages/api`. No runtime DSH
  dependency, copied client bundle, or `/swiftnest/v0` façade. The connection, session-controller and
  gateway packages remain exact-pinned **development dependencies** to type-check the internal adapter
  and record the upstream version. Public declarations expose only Swiftnest-owned types. Sources were
  inspected at `lib/types/client/*.d.ts`, session `lib/types/types.d.ts`, `lib/typert.remote-client.*`,
  connection `lib/client.node.js` / `lib/index.js`, and gateway `lib/client.node.js` / stream declarations.

### Observed native protocol

1. `GET <root>/connect?token=…&interactions=answer`, with redirects disabled, exchanges the token for a
   signed HttpOnly API cookie and returns `302 ./api/remote.mux`. Browser fetch exposes an opaque redirect
   (status 0) and hides Set-Cookie; the browser jar processes it. Successful socket + `$events` readiness
   proves browser authentication. Node extracts cookie name/value pairs and sends them on RPC and socket
   requests. Pairing URLs/cookies are never logged by the client.
2. Unary calls go to **`POST <root>/api/<endpoint>`**, not the bare `/api` path (which was verified to return
   404 after authentication). JSON is `{type:"client-request", rpcId, method:endpoint, payload:{args}}`;
   the response is `{type:"server-response", rpcId, result:{ok:true,value}}` or a typed error branch.
   Correlation is checked. `session/list` uses `{_request:{}}`; create/prompt/follow use `{request:…}`.
3. One cookie's Peer owns **one** `/api/remote.mux` socket. Multiple followers share it. Open a logical
   stream with `{type:"open",streamId,endpoint,payload:{args}}`; downlink frames are `item` (`value`),
   `end`, or `error`. `{type:"cancel",streamId}` releases an individual subscription.
4. Connect opens `$events` with `{args:{}}` and waits for `{type:"ready",clientId,host}`. Follow opens
   `session/follow` with `{request:{address:{kind:"session",sessionId},assistantStream:true}}`, waits for
   its `snapshot`, queues history and then maps durable `event` and transient `assistant-stream` frames.
   This establishes the subscription before `sendMessage`, avoiding a send/follow race.
5. `session/prompt` takes `{request:{sessionId,requestId,mode:"queue",content:[{type:"text",text}]}}` and
   returns `{accepted:true}` immediately. It is admission, not completed inference. Human user messages
   carry `source.kind="user"` and `source.rpcId=requestId`; runtime/time contexts also use the user role
   but are filtered out. Assistant text deltas carry an attempt id and index; the final durable message
   is authoritative and replaces accumulated partial text. Assistant start/end events delimit attempts;
   the end event links the attempt to the final message sequence or marks it abandoned. Tool ids are retained. Failed
   `turn/end` emits an error and a turn end; successful completion has `reason.kind="completed"`.
6. Opening snapshots include compact active-attempt records (`text-chunks` runs / `chunk` records), which
   are replayed as accumulated partial text before future deltas. Durable history messages are replayed
   as final messages, not fabricated live deltas. Phase 0 exposes the native recent history window;
   older-page navigation and general surface-replacement editing are future work.

### Approvals and questions

Both are reachable through `$events`: Agent-scoped `waterfall` items name `approval/request` or
`user-questions/request`. `agentId` identifies the session. The wrapper publishes a typed request only
for followed sessions; otherwise it returns `{kind:"next"}` to the Host's answerer chain. Replies use
`$events/result` with `{args:{clientId,eventId,outcome:{kind:"result",value}}}`. Approval values are the
closed outcomes `allowed-once`, `rejected`, `cancelled`, `unavailable`; questions carry structured answers.
Host `cancel` invalidates the request id and emits `interaction-cancelled`.

Timed foreground questions also claim `userQuestions/attachWait` using `{agentId,callId}`; the stream is
released on answer/cancellation. Continued questions use unary `userQuestions/answer` with
`{agentId,callId,answer}` (exposed via the object-target overload of `answerQuestion`). Historical pending
question projection/card restoration is not exposed in this phase. Approval/question transport is covered
by deterministic carrier tests; the real-model acceptance test covers text chat, not live tool approval.

### Browser, Node and Tauri carriers

Runtime source has no Node imports or DSH page globals. `fetch` and an authenticated WebSocket factory
are injectable; the Node e2e uses `ws` because Node's built-in browser-style WebSocket cannot set Cookie.
Only name/value cookie pairs are retained in memory and cleared on close. Do not use one manual-cookie
client's injected carrier for unrelated hosts. A new pairing creates a new client; disconnect emits a
typed error and ends follows. There is no automatic mutation retry or silent session resubmission.

Same-origin browser/WebView deployments use `credentials:"include"` and the browser cookie jar. The
packaged Tauri App normally has another origin: the kernel explicitly rejects cross-site fetch metadata
and differing Origin authorities, independently of CORS and cookie SameSite rules. Plain cross-origin
fetch/WebSocket therefore **does not work**. The App needs an authorized native HTTP/WebSocket carrier
(inject both, `cookieMode:"manual"`) or a same-origin hosting arrangement. Do not weaken the Host trust
fence as a workaround. Native carrier permissions/configuration belong to App integration, outside B1.

### Verification

- Event fixtures include a recorded real-kernel SSE chat plus explicitly constructed tool/failure and
  active-attempt snapshots. Tests cover mapping, cookies, mount paths, RPC correlation/errors, timeout
  cleanup, cancellation, socket loss, and forwarded approvals/questions.
- Opt-in acceptance: `SWIFTNEST_E2E=1 pnpm vitest run packages/api server`. It starts a real isolated
  Swiftnest kernel with random ports and a fake OpenAI-compatible `/v1/chat/completions` SSE model;
  pairs → creates → follows → sends `hi` → verifies live text deltas, the final message and turn end.
  Resources are disposed in teardown; no external model credentials are needed.
- An esbuild browser ESM bundle was also checked: no external runtime imports or Node dependencies.
- Workspace install explicitly permits the DSH subprocess helper's executable-bit repair, while marking
  other unused dependency scripts disabled, as required by pnpm 12. The fixed chat model needs none of
  those optional builds. `pnpm build`, `pnpm test`, and the opt-in kernel suite are the B1 checks.


## Server device hub (E1)

The Swiftnest parent owns the Nest, its persistent identity/device store/audit, the LAN link and two
loopback HTTP listeners. The generated profile inserts `@deepseek-ai/dsh-mcp-client` with
`serverName: devices`, Streamable HTTP and reconnect enabled. Its Authorization header is an unevaluated
`!!js` environment expression: neither generated configuration nor kernel persistence contains the
per-process bearer value (checked in the real-kernel test).

The bundle injects `connection` and calls `connection.admit(req)` for `/swiftnest/api/devices/*`, retaining
the native Host/Origin/session fence and requiring `peer.principal.kind === 'owner'`. It streams authorized
requests to the parent's loopback admin listener using a separate environment credential, forwarding no
browser cookies or caller-supplied authorization. Only bounded transfer and language-preference JSON bodies are forwarded. The admin endpoint owns pairing,
fingerprint decisions, revocation, task decisions, audit and SSE invalidations. MCP has no approval tool.

Verified against the pinned kernel: MCP `tools/list_changed` adds/removes tools in the same conversation,
new conversations see current tools, and the kernel is never restarted. Acceptance also pairs a real Node
Perch over link-lan with cap-files, lets the fake model read a file, waits for App approval before writing,
and checks both audit results. The Chromium flow exercises device management and approval/denial at 390 px.
See [Devices](../guide/devices.md) for configuration and the API contract.

## Owner language

The App defaults to zh-CN regardless of browser language. Settings persist locally; authenticated `/swiftnest/api/devices/preferences` GET/POST persists the owner choice on the server. Connected Apps follow it within two seconds; offline changes are retried after pairing. CLI precedence is SWIFTNEST_LANG, then YAML lang, then zh-CN. Errors retain stable codes and include localized message and hint.
