# Swiftnest App

English | [简体中文](README.md)

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
in the browser jar. Outside an expected plugin restart, reloading or losing the connection requires **Pair again**. No automatic
mutation retry or message resubmission occurs. Recent server history is replayed when reopening a chat;
older-page navigation and interactive approval/question controls are deferred.

Desktop and Android builds use `isTauriRuntime()` to dynamically load `src/nativeTransport.ts`; ordinary web mode
never loads Tauri modules. Official HTTP/WebSocket plugins provide manual-cookie transports. HTTP uses
`maxRedirections: 0`, `unsafe-headers`, and an empty Origin header (the plugin's explicit opt-out from
inserting the WebView Origin). Rust HTTP defaults are disabled to avoid the plugin's shared Cookie jar;
TLS verification remains enabled. WebSocket forwards the API Cookie in its native handshake. This keeps
the kernel's Origin/fetch-site fence intact. See the [integration notes](../docs/en/dev/dsh-integration.md).

The capability applies only to the local **main** window, with no remote-origin IPC access. HTTP scopes
allow HTTP(S), arbitrary user-selected hosts/ports, and only `/connect`, `/api/*`, `/swiftnest/health`, plugin API routes, device events and preferences.
Hosts cannot be enumerated ahead of LAN pairing. The official WebSocket plugin currently has no URL scope;
only its required `allow-connect` and `allow-send` commands are granted. The App derives the socket URL
from the paired root. The WebView receives no general filesystem or shell plugin permissions. Local custom IPC commands control
the Rust Perch and native folder picker; the Perch enforces its own shared-folder policy. These HTTP scopes cover
the server's root deployment; native reverse-proxy path prefixes need an explicit capability adjustment.

Desktop development uses `pnpm --filter @swiftnest/app tauri dev` (not part of checks). Linux dependencies
come from Nix; Windows needs Rust/MSVC and WebView2.
Preferences retain bilingual copy, system/light/dark themes, accent presets, reduced motion/transparency,
accessible sheets, two panes at 600 px, desktop sidebar at 1024 px, Alt+Left and phone edge-swipe back.

## Recommended plugins

Open **Recommended plugins** in the main menu (server owner only). Recommended choices come first,
with a description and switch. Read and confirm a plugin's note before enabling it. The community market
has an extra warning that Swiftnest does not check community plugins. Administrator-set switches are
read-only; community packages are listed separately as **Not reviewed**.
Choose **Apply** after changing switches. The assistant restarts briefly, with preparation and restart
progress on the page. Web connections recover automatically and refresh the list. If a native App says
**Reconnect needed**, use **Reconnect** and the new connection link in the existing pairing form;
success returns to the plugin page. A failed startup with rollback shows **The new plugins didn't start,
so the previous settings were restored**; other failures show an explanation and allow retry.
Reconnection does not resend messages or create chats. See the [plugin guide](../docs/en/guide/plugins.md).

## Android (arm64 debug APK)

From the repository root:

```sh
nix develop .#android
pnpm install --frozen-lockfile
pnpm build
# Already initialized and versioned. Only run init when creating a new target:
# pnpm --filter @swiftnest/app tauri android init
pnpm --filter @swiftnest/app tauri icon src-tauri/icons/source.svg
pnpm --filter @swiftnest/app tauri android build --debug --target aarch64 --apk
```

The application id is `dev.swiftnest.app` (Android 7/API 24 or newer). The APK is under
`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` relative to
`client/`; with only `aarch64` selected, this contains only `arm64-v8a`. It uses a local debug signing
key and is for testing. Build outputs, generated JNI/Kotlin glue, machine-specific Gradle files and
local SDK/signing settings are ignored; the Gradle wrapper, build scripts, manifest, activity and
resources are versioned. Do not re-run init over the customized project.

The Android shell supplies JDK 17, Rust Android targets, SDK/API 36, Build Tools 36.0.0, NDK 27.2
and an SDK `aapt2` override in
`GRADLE_OPTS`. Keep that variable when invoking Tauri/Gradle on NixOS: Gradle's downloaded Maven
`aapt2` cannot run there. First builds download Gradle/Maven dependencies. The Android shell uses
the official Node's Corepack-backed `pnpm` wrapper so Tauri's build hook and Gradle tasks also use
the pinned workspace version, avoiding the Nix standalone launcher's missing platform binary.
Re-enter `nix develop .#android` after updating this checkout if an older shell only has API 34/35.
The generated template's API 37 default is adjusted to API 36 to match Tauri's Android library and
the versioned dev shell.

For LAN chat, start the server with `SWIFTNEST_HOST=<server's concrete LAN IP>` and paste its
`http://192.168.x.y:<port>/connect?token=…` pairing URL into **Pair server** in the APK. Open **New chat**
and send a message. The phone must reach the server port on the same trusted LAN. Both HTTP and the
authenticated WebSocket use the same native carrier as desktop; the server's cross-origin fence stays
enabled. The shared capability has no platform restriction and matches Android's local `main` window.

`network_security_config.xml` permits cleartext for phase-0 LAN pairing, including debug and release
builds. Arbitrary LAN IPs cannot be enumerated at build time and Android domain rules cannot express
private IP CIDRs, so this is an app-level exception. The existing native HTTP path scopes and local-only
IPC permissions still apply; TLS verification is unchanged. Use trusted networks only. Phase 2 adds
encrypted transport and should remove this exception.

The activity applies system-bar/cutout and keyboard insets to the whole WebView, consumes them to avoid
double safe-area padding, and uses `adjustResize`. Web layouts retain CSS safe areas and `100dvh`.
Android system back dismisses Preferences first, returns detail/pairing to the chat list next, and exits
only from home. A visible keyboard gets the system's normal back-to-dismiss behavior first.
Real-device checks remain necessary: gesture and three-button navigation, rotation/cutouts, keyboard
show/hide, LAN pairing and streamed chat. Browser viewport tests do not verify Android IME behavior.

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

## This device (desktop)

**Devices → This device** hosts the Node-free `native/perch` Rust library in the App process. Control and
background operation default off, with no shared folders. Pair with a code from the server Devices page,
compare both fingerprints, then enable files/shell. See [Control this computer](../docs/en/guide/control-this-computer.md)
for the complete flow, private storage, tray behavior and platform limits. Android hides the section.
Linux requires bubblewrap for shell confinement; macOS uses sandbox-exec (unverified on hardware).
Windows shell currently fails closed pending a filesystem sandbox; Windows file tools are portable.
The App matches its native identity/fingerprint to the connected server’s device list and supplies that
server-assigned slug as chat context; Android and web omit it. The chosen Windows command syntax is cmd.exe /D /S /C. Closing in background mode hides to the tray;
Quit cancels the core before exiting. No autostart service is installed.

Cargo uses the repository-root workspace/lockfile, containing this App and `native/perch`; the older mesh
crate remains separate. Run from the root:

```sh
cargo check --workspace
cargo test --workspace
cargo build -p swiftnest-perch --example interop
SWIFTNEST_PERCH_E2E=1 pnpm vitest run native/perch/test
```

The interop test starts a real TS Nest and a Rust child, exercises code/fingerprint pairing, tool schemas,
reads, approval-gated writes, shell cancellation/timeouts, link drops, process restart and changed-key
refusal. It uses temporary storage only. `native/perch/DESIGN.md` reserves separate authenticated binary
streams for E2b/E2c without implementing capture, input or large transfers.
