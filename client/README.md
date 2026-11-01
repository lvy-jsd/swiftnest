# Swiftnest App

English | [简体中文](README.zh-CN.md)

Our Apache-2.0 app uses React 19, strict TypeScript, Vite and Tauri 2. Components and assets are original;
Phosphor icons and TanStack Virtual are MIT licensed. Follow the [design rulebook](../docs/en/dev/design-system.md).

Run commands from the repository root. Node 24+, pnpm and Rust are provided by the Nix shell.

```bash
nix develop
pnpm install
pnpm --filter @swiftnest/app dev
```

Open `http://127.0.0.1:1420`. Build a plain web app with:

```bash
pnpm --filter @swiftnest/app build:web
```

Deploy `client/dist/` to a static host. Relative assets and hash routes support subpaths and chat deep links
without server rewrite rules. Web mode requires no Tauri APIs; `src/runtime.ts` feature-detects
`window.__TAURI_INTERNALS__` before native integration is considered.

Desktop development (Linux and Windows):

```bash
nix develop
pnpm --filter @swiftnest/app tauri dev
```

The CLI starts Vite automatically. On Windows use a Windows Rust/MSVC toolchain and Tauri's WebView2
prerequisites; the Nix shell supplies Linux dependencies. No native plugins are installed. Android initialization
is deferred; the library entry point and Vite host support are ready for later mobile setup.

Checks:

```bash
pnpm build
pnpm test
pnpm --filter @swiftnest/app test
pnpm --filter @swiftnest/app build:web
cd client/src-tauri
cargo check
```

`pnpm build` checks the client with the root TypeScript project graph; `build:web` also bundles it.
Tests cover exact design scales, all text/background contrast pairs in five presets and both modes,
custom hues, motion durations, color conversion, bilingual rendering and routing.

The avatar button opens preferences: language, system/forced light/dark, five accent presets or a custom hue,
reduced motion and opaque surfaces. System accessibility preferences are also honored. Glass falls back
to opaque surfaces when blur is unavailable. Preferences and sample messages are in memory only.
The sidebar appears at 600 px (including landscape phones) and stays visible on desktop at 1024 px.
Use Alt+Left to return to Chats and Ctrl/Cmd+Enter to send; phones also support a swipe from the left edge.
Transcripts and list layouts virtualize above 50 rows. Sheet dialogs trap focus and support Escape.

Sample messages are local only. `src/App.tsx` marks the future `@swiftnest/api` boundary. Streaming,
interrupt/queue choices, approvals and tool/artifact cards need the backend integration and are not simulated.
Real-device performance measurements and Android initialization remain for later work.
