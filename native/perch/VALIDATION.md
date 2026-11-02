# E2a validation — 2026-11-02

Validated on the Linux development host with Rust 1.99 and the existing repository dependencies.
No commit, push, system-wide installation, system configuration change or real device pairing was made.
The previous Tauri-local Cargo.lock was moved to the new repository-root Cargo workspace/lockfile.

| Command | Result |
| --- | --- |
| `cargo check --workspace` | Passed, App and Perch |
| `cargo test --workspace` | Passed: 2 channel tests + 6 capability/controller tests |
| `cargo clippy --workspace --all-targets -- -D warnings` | Passed |
| `cargo fmt --all --check` | Passed |
| `cargo build -p swiftnest-perch --example interop` | Passed |
| `pnpm build` | Passed |
| `pnpm test` | Passed: 169 tests; optional integration tests disabled in this invocation |
| `pnpm --filter @swiftnest/app build:web` | Passed |
| `pnpm docs:build` | Passed |
| `SWIFTNEST_E2E=1 SWIFTNEST_WEB_E2E=1 SWIFTNEST_CHROMIUM=/run/current-system/sw/bin/google-chrome pnpm vitest run` | Passed: 178 tests; Rust interop opt-in and unavailable multicast discovery skipped |
| `SWIFTNEST_PERCH_E2E=1 pnpm vitest run native/perch/test` | Passed: manifest parity and real TS Nest ↔ Rust Perch interop |
| `git diff --check` | Passed |
| `nix develop .#android --command cargo check --target aarch64-linux-android -p swiftnest-perch` | Unavailable: repository has no `android` devShell |
| `cargo check --target aarch64-linux-android -p swiftnest-perch` | Unavailable: Rust target standard library is not installed (`E0463`) |

Interop covers code + both fingerprint confirmations, eight advertised tools, reads, pending approval →
approval → completed writes, shell cancellation/timeouts, disabling during execution, pin preservation,
renaming without changing slug, network reconnect, process restart, changed Nest key refusal and unpair.
The driver uses only temporary storage. Unit tests port the TS files/shell cases and add frame integrity,
limits, protected symlinks, private storage, read-only mounts, child-process cancellation and host-owned
trust settings. The standalone TLS-provider test prevents relying on the host App's feature unification.
The Perch dependency graph has no OpenSSL/native-tls.

The new browser test uses a mocked native IPC bridge to verify UI consent/state behavior at 390 px in
English and Chinese, including unsaved invalid fields not blocking the emergency off command. Actual
Rust behavior is tested separately by the interop driver. The existing browser e2e uses the real server
and model fixture. Native folder dialogs, tray interactions and close-to-background were compiled but
not manually exercised in a real desktop App window.

Remaining platform work: Windows shell intentionally returns an error until a filesystem-isolating
executor exists; `cmd.exe /D /S /C` is the selected syntax but not an enabled executor. macOS sandbox-exec
and platform tray behavior, Windows ACL/files behavior, and Android cross compilation need their target
platform/toolchain validation. Linux shell requires bubblewrap and user namespaces. Keyring integration
is a follow-up. Capture, input, video, take-over and resumable large transfers remain E2b/E2c, with stream
separation reserved in DESIGN.md.
