# Swiftnest App

English | [简体中文](README.zh-CN.md)

Apache-2.0 React 19 + TypeScript + Vite + Tauri 2 App. Components and assets are original;
Phosphor icons and TanStack Virtual are MIT licensed. No DSH Go code is used.
Follow the [design rulebook](../docs/en/dev/design-system.md).

From the repository root, inside `nix develop`:

```sh
pnpm install
pnpm build
pnpm --filter @swiftnest/app build:web
SWIFTNEST_APP_DIST="$PWD/client/dist" node server/dist/cli.js start
```

Open the server's **App (web)** link. It serves `/app/` on the API's origin and opens
`#/pair?url=<encoded pairing URL>`; the App pairs automatically, removes the URL/token from the
address bar, and shows the real chat list. Alternatively open `#/pair` and paste the server's
Swiftnest App pairing URL; `#/pair?url=…` and `/app/?url=…#/pair` both work. Choose **New chat**, type,
and send (Ctrl/Cmd+Enter also sends). The composer stays enabled during generation; further messages
queue for the next turn. Streamed assistant text grows in place and the durable final message replaces
it. Thinking has an elapsed-time pill; finished tools fold into one expandable row; errors are inline
and other events have a generic expandable card. Transcripts and lists virtualize above 50 rows.

For another device on the same Wi-Fi, start the server with `SWIFTNEST_HOST=<server's concrete LAN IP>`
and open its App (web) link there. Keep plain HTTP on a trusted network. The browser requires the
**same origin** as the server; deploying these files on an unrelated static host will not enable pairing.
`pnpm --filter @swiftnest/app dev` previews the shell at `http://127.0.0.1:1420`; use the built App served
by the server for real web chat. Assets are relative and navigation uses hash routes.

`src/connection.tsx` owns one ephemeral `@swiftnest/api` client. Only the server root is remembered in
localStorage (`swiftnest.serverRoot`). Tokens and native cookies stay in memory; browser cookies stay
in the browser jar. Reloading or losing the connection requires **Pair again** in phase 0. No automatic
mutation retry or message resubmission occurs. Recent server history is replayed when reopening a chat;
older-page navigation and interactive approval/question controls are deferred.

Desktop builds use `isTauriRuntime()` to dynamically load `src/nativeTransport.ts`; ordinary web mode
never loads Tauri modules. Official HTTP/WebSocket plugins provide manual-cookie transports. HTTP uses
`maxRedirections: 0`, `unsafe-headers`, and an empty Origin header (the plugin's explicit opt-out from
inserting the WebView Origin). Rust HTTP defaults are disabled to avoid the plugin's shared Cookie jar;
TLS verification remains enabled. WebSocket forwards the API Cookie in its native handshake. This keeps
the kernel's Origin/fetch-site fence intact. See the [integration notes](../docs/en/dev/dsh-integration.md).

The capability applies only to the local **main** window, with no remote-origin IPC access. HTTP scopes
allow HTTP(S), arbitrary user-selected hosts/ports, and only `/connect`, `/api/*`, `/swiftnest/health`.
Hosts cannot be enumerated ahead of LAN pairing. The official WebSocket plugin currently has no URL scope;
only its required `allow-connect` and `allow-send` commands are granted. The App derives the socket URL
from the paired root. No filesystem, shell, or navigation permissions are added. These HTTP scopes cover
the server's root deployment; desktop reverse-proxy path prefixes need an explicit capability adjustment.

Desktop development uses `pnpm --filter @swiftnest/app tauri dev` (not part of checks). Linux dependencies
come from Nix; Windows needs Rust/MSVC and WebView2. Android packaging and real-device measurements come later.
Preferences retain bilingual copy, system/light/dark themes, accent presets, reduced motion/transparency,
accessible sheets, two panes at 600 px, desktop sidebar at 1024 px, Alt+Left and phone edge-swipe back.

Checks (no Tauri launch or packaging needed):

```sh
pnpm build
pnpm test
pnpm --filter @swiftnest/app build:web
cargo check --manifest-path client/src-tauri/Cargo.toml
SWIFTNEST_E2E=1 pnpm vitest run packages/api server
SWIFTNEST_WEB_E2E=1 pnpm vitest run client/test/web.e2e.test.ts
```

The optional web test starts an isolated real kernel and fake SSE model, drives Chromium through pairing,
new chat, streamed text, queued send and history replay, then cleans up. Build the web App first. It skips
when Chromium cannot launch; it never downloads a browser automatically. Use `SWIFTNEST_CHROMIUM=/path/to/chrome`
for a system browser. A non-loopback IPv4 address, when available, also exercises plain LAN HTTP UUID support.
Unit tests cover the connection store, native adapter, transcript reducer against API fixtures, routing,
translations, design tokens, contrast and motion.
