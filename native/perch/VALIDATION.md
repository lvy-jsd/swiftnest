# E2c validation — 2026-11-02

[简体中文](VALIDATION.zh-CN.md)

Large file transfer is implemented for native Perches and server storage. This work is uncommitted;
no commit, push, system-wide install, system configuration change, phone pairing or reboot was made.
All transfer fixtures use temporary files/identities. Prettier 3.6.2 was fetched through `pnpm dlx` into
the development cache only; no project dependency or package lock was added for formatting.

## Files and decisions

- `native/perch/src/{transfer,stream,runtime,lib}.rs`, `src/manifests/transfer.json`: file offers,
  shared-folder/protected-path checks, write approval receipts, SHA-256 chunk/final verification,
  durable acknowledged offsets, prefix validation/reset, atomic final rename and commit recovery,
  cancellation and IPv4 direct listener/fallback. Rust unit tests live beside the state machine.
- `packages/core/src/{streams,link,nest,remote}.ts`, `packages/protocol/src/index.ts`: file negotiation,
  fresh common attempt keys/cipher ids, opaque bounded relay bridging, parent-only policy-checked
  progress reads without accumulating polling tasks, separate file leases and internal server endpoint.
- `server/src/{file-storage,transfers,devices,config}.ts`: background coordinator, persistent transfer
  index, server endpoint under `config.home/files`, serialized quota reservations, binary AEAD codec,
  short-read/write handling, owner/private APIs and progress events.
- `server/bundle/src/{devices,native-devices}.ts`: bounded owner-admitted request forwarding and
  nonblocking `transfer_file`, `transfer_status`, `transfer_cancel` Ivy tools. Endpoint helper tools
  are excluded from the native DSH device catalog. Existing device tools/approvals remain intact.
- `packages/api/src/{devices,index}.ts`: typed requests/progress, start/list/actions and transfer events.
- `client/src/{transfers,devices,App,i18n}.tsx`, `styles.css`, `client/src-tauri/src/lib.rs`: Transfers
  view, chat cards, Devices send sheet, desktop file picker, bilingual controls/speed/ETA and phone layout.
- `server/test/{file-storage,transfers,transfers.e2e}.test.ts`, `client/test/transfers.e2e.test.ts`;
  existing native interop count and bundle catalog/proxy tests updated for the added tools.
- English/Chinese `guide/transfer-files.md`, VitePress sidebar, DESIGN.md and this validation record.

Decisions: fixed 4 MiB chunks; SHA-256 per chunk, first 1 MiB identity prefix and whole file; one chunk
in flight; ACK only after durable write/journal; immutable id bound to both paired identities, both
paths, size, mtime and prefix. Each destination approval records a readable name/size/source/destination
and persists its exact binding. Each attempt uses fresh keys/counters and an independent stream-v1
cipher id. Device-to-device relay sees ciphertext; the trusted Nest distributes keys and is still
trusted. For server transfers the server is the intended plaintext endpoint. Default quota is 100 GiB,
configurable with `files.quotaBytes` / `SWIFTNEST_FILES_QUOTA_BYTES`. Cancel retains partials/receipts
and quota reservations for explicit owner cleanup. Paused state survives server restart.

## Commands and results

| Command | Result |
| --- | --- |
| `cargo check --workspace` | Passed, Linux App + Perch |
| `cargo test --workspace` | Passed, 15 Rust tests |
| `cargo clippy --workspace --all-targets -- -D warnings` | Passed |
| `cargo fmt --all --check` | Passed |
| `cargo build -p swiftnest-perch --examples` | Passed |
| `pnpm build` | Passed |
| `pnpm --filter @swiftnest/app build:web` | Passed |
| `pnpm docs:build` | Passed |
| `pnpm vitest run server/test/file-storage.test.ts server/test/transfers.test.ts` | Passed, 4 tests: quota/guards, real binary endpoints, short I/O, pause + server restart |
| `SWIFTNEST_TRANSFER_E2E=1 pnpm vitest run server/test/transfers.e2e.test.ts` | Passed, two 200 MiB cases including pause/resume and both native endpoints killed/restarted near 50%; server upload/download included |
| `SWIFTNEST_TRANSFER_E2E=1 pnpm vitest run server/test/transfers.e2e.test.ts -t fallback` | Passed, unreachable candidate automatically falls back to encrypted relay |
| `SWIFTNEST_WEB_E2E=1 SWIFTNEST_CHROMIUM=/run/current-system/sw/bin/google-chrome pnpm vitest run client/test/transfers.e2e.test.ts` | Passed, English/Chinese at 390 px: progress, pause, resume, retry, cancel, send form, no horizontal overflow |
| Full opt-in suite below | Passed: 38 files, 197 tests passed, 1 unavailable-mDNS skip; 273.80 s |
| `git diff --check` | Passed |

Final combined acceptance command (existing App/chat/approval/screen/kernel/interop e2es plus file e2es):

```sh
SWIFTNEST_E2E=1 SWIFTNEST_WEB_E2E=1 SWIFTNEST_PERCH_E2E=1 \
SWIFTNEST_SCREEN_E2E=1 SWIFTNEST_TRANSFER_E2E=1 \
SWIFTNEST_CHROMIUM=/run/current-system/sw/bin/google-chrome pnpm vitest run
```

Earlier full existing opt-in regression (file tests disabled): 192 passed, 3 skipped, before the final
short-I/O and server-restart unit additions. Initial development runs caught and corrected the internal
storage endpoint appearing as a paired device, changed static-tool catalog expectations, a disabled
send form before device discovery, and Clippy callback/enum size warnings. Final outcomes above are
from corrected code; compilation is not physical-device acceptance.

## Evidence and remaining limits

The file e2e pairs **two real Rust Perch processes** with the real parent Nest. Each routing case writes
200 MiB of nonempty chunk data, verifies destination does not exist before approval, starts only after
write approval, pauses/resumes, kills and restarts both native processes once the receiver journal
reaches 100 MiB, then independently hashes the complete source/destination. A single receive approval
is asserted across all retries/restarts. Relay instrumentation in the TEST ONLY decrypts/re-encrypts
one authenticated chunk hash to force a retry and verifies retransmission at the same offset. The
production bridge has no file codec. Device/server upload and server/device download are also 200 MiB,
with write approval and independent final hashes. A separate test exchanges an unreachable direct
candidate and verifies automatic relay fallback. Rust unit tests additionally reject replay/tag changes,
wrong bindings, invalid offsets/protected paths, corrupt chunks and final hashes without publishing
partial bytes. Server tests cover concurrent quota reservations, symlink escapes, empty/partial chunks,
short OS I/O and paused approval cancellation surviving server restart.

Generated owner-review screenshots (ignored by Git):

- `client/test/screenshots/transfers-en-390.png`
- `client/test/screenshots/transfers-zh-CN-390.png`

The UI fixture uses real React components and a deterministic client; it proves the controls/layout,
not a signed owner login for that screenshot. Separate existing real-kernel e2es cover owner sessions;
proxy tests explicitly reject agent admission and oversized/private transfer requests.

Not validated here: physical Android phone/WebView throughput, native file dialogs, Windows/macOS
runtime/rename durability, multiple-GB throughput or power-loss durability on real storage. File I/O
uses constant-size buffers and 64-bit offsets, but this is not a measured many-GB performance claim.
Direct discovery currently advertises one IPv4 interface from the control connection; IPv6/multiple
interface discovery and NAT traversal are not implemented. The parent Nest must remain connected.
Legacy TS Perches without the new file endpoint helpers cannot transfer. A cancelled partial and its
quota reservation require explicit owner cleanup; there is no automatic garbage collector. Prefix
verification on resume rereads the acknowledged prefix (bounded memory, O(offset) time). Existing
same-user filesystem-swap limits of files_write still apply. The trusted Nest could derive stream keys.

---

Historical E2b/E2a records below are retained; their E2c future-work statements are superseded above.

# E2b validation — 2026-11-02

The Linux screen/input/live-view/owner-take-over path is implemented and exercised on a disposable
headless labwc desktop. This is **not full platform acceptance**: the platform/hardware and transport
follow-ups below remain. The implementation baseline is committed at `6b29899`; this final-validation
follow-up makes no commit or push. No system-wide package installation, real desktop input injection,
real phone pairing, system configuration change or reboot was performed. Nix fetched development-shell
packages; Rust dependencies use the user Cargo cache. All test identities/state were temporary.

## Changed files and decisions

- `native/perch/src/stream.rs`, `channel.rs`, `runtime.rs`, `store.rs`: private stream exporter,
  directional AEAD, control negotiation, persisted live-view consent, bounded/cancellable stream tasks.
- `native/perch/src/screen.rs` and `screen/{live,wayland,portal,x11,windows}.rs`: screen/input
  capabilities, serialized native capture, crop/downscale mapping, host input gate, JPEG adaptation,
  protocol/session selection, portal lifecycle and OS backends.
- `native/perch/src/manifests/{screen,input}.json` and
  `packages/core/src/{screen,input}-manifest.ts`: matched capability/tool metadata; all input is exec risk.
- `packages/{protocol,core}/src`: opt-in wire messages, underscore-safe tool names, stream registry,
  Nest/remote integration. Separate sockets keep bulk traffic out of the control queue.
- `plugins/link-lan/src/index.ts`, `server/src/devices.ts`, `server/bundle/src/{core,devices}.ts`:
  one-use device stream admission, private admin carrier, owner-session-only HTTP/WS relay. Both relay
  hops forward encrypted records. Nest distributes per-stream keys through the owner API; the trusted
  Nest could derive them. LAN key exchange requires HTTPS; forwarded-proto headers are not trusted.
- `packages/api/src/{index,live,transport,types}.ts`, `client/src/nativeTransport.ts`: binary native/web
  transport, bounded AEAD/inbox work, cancellation and cleanup, live-view API.
- `client/src/{liveView,App,devices,thisDevice,i18n}.tsx`, `styles.css`,
  `client/src-tauri/{Cargo.toml,src/lib.rs}`: chat chips/panel, gestures and keyboard, bilingual states,
  default-off live-view toggle, visible tray state/start notification and local Stop action. Hosts without
  a working observation indicator do not advertise screen/input.
- Tests: `packages/core/test/streams.test.ts`, `server/test/live.test.ts`,
  `server/bundle/test/devices.test.ts`, `client/test/liveView{,.real}.e2e.test.ts`, native unit tests and
  `examples/screen_fixture.rs`; updated the existing interop driver/manifest count.
- `flake.nix`, Cargo manifests/lock, server manifests/pnpm lock: dev-only Linux helpers/compositor,
  image/Wayland/X11/portal/Windows bindings and WS runtime dependencies. No new system service.
- English/Chinese `guide/live-view.md`, Control-this-computer/Devices guides, sidebar and DESIGN.md.

Decisions: one viewer per computer session; host-owned gate pauses before owner injection; rejected agent
input is never replayed. Capture ids reference host geometry rather than trusting caller-provided scale.
The stream carries only changed JPEG frames, one awaiting acknowledgement, with quality/interval feedback.
Capture and owner input reading run independently. Queues and native captures are bounded. A stopped,
revoked, disconnected or failed stream releases owner control. The shared file-purpose negotiation and
framing are available for E2c to extend; file transfers are not enabled.

Final diff review found that the connection store treated live-view socket closure as loss of the
main chat connection. It now observes only the main `api/remote.mux` socket for whole-App disconnects;
a regression test covers viewer failure/close and subsequent real main-socket loss. The screen e2es
share `client/test/fixtures/screenHost.ts` to start and clean up an isolated compositor and paired host.

### HTTPS boundary

Outside loopback, both the native App and browser must use an HTTPS server URL (and WSS for its live
socket). The owner HTTP offer contains the AES stream keys: LAN HTTP would disclose those keys and
the session credential, defeating the binary stream's encryption. Browser AEAD also uses
`crypto.subtle`, which is available only in a secure context. A secure native WebView does not secure
its outbound HTTP traffic. Loopback HTTP is a development exception.

The bundle allows a TLS socket or a loopback peer and ignores forwarded-proto headers. If a trusted
local reverse proxy terminates TLS, its public listener must require HTTPS/WSS and preserve Host/Origin
checks; the loopback exception cannot validate the proxy's public configuration. Unit tests cover
the admission predicate; a deployed HTTPS proxy/certificate and remote physical-phone connection
were not tested. See [DESIGN.md](./DESIGN.md#https-outside-loopback).

## Commands and results

Final checks below were rerun in the existing default devShell after the review and screenshot test.
Earlier dependency setup and unavailable cross-target checks are explicitly marked.

| Command | Result |
| --- | --- |
| `cargo check --workspace` | Passed, App + Perch on Linux |
| `cargo test --workspace` | Passed, 12 Rust tests |
| `cargo clippy --workspace --all-targets -- -D warnings` | Passed |
| `cargo fmt --all --check` | Passed |
| `cargo build -p swiftnest-perch --examples` | Passed, interop + Wayland fixture |
| `pnpm build` | Passed |
| `pnpm test` | Passed: 175 passed, 14 opt-in/environment skips |
| `pnpm --filter @swiftnest/app build:web` | Passed |
| `pnpm docs:build` | Passed |
| `SWIFTNEST_WEB_E2E=1 SWIFTNEST_SCREEN_E2E=1 SWIFTNEST_CHROMIUM=/run/current-system/sw/bin/google-chrome pnpm vitest run client/test/liveView.real.e2e.test.ts client/test/connection.test.ts server/test/live.test.ts` | Passed: 10 tests, real headless labwc/pixman and browser screenshots |
| `SWIFTNEST_E2E=1 SWIFTNEST_WEB_E2E=1 SWIFTNEST_PERCH_E2E=1 SWIFTNEST_SCREEN_E2E=1 SWIFTNEST_CHROMIUM=/run/current-system/sw/bin/google-chrome pnpm vitest run` | Passed: 34 files, 188 passed, 1 unavailable-mDNS skip |
| Earlier: `pnpm install --no-frozen-lockfile --config.manage-package-manager-versions=false` | Passed; existing dependencies/lock linked correctly |
| Earlier: `pnpm install --offline` / attempted root `pnpm add ... --offline` | Initially unavailable: missing cached registry metadata; no root dependency added. WS tests live under the server package, which already depended on WS |
| Earlier: `cargo check --target x86_64-pc-windows-gnu -p swiftnest-perch` | Unavailable: target core/std absent (`E0463`); Windows code is not cross-compile-verified |
| `git diff --check` | Passed |

## Evidence and limits

The labwc test runs an actual fullscreen wl_shm fixture in an isolated runtime directory with the pixman
renderer. A Rust Perch pairs with the TS Nest; screenshot bytes have a real PNG signature and dimensions.
The fixture reports actual wl_pointer button events. The test checks default-off live-view rejection,
pending approval before agent click, owner-only App socket admission, encrypted binary viewing through
both relay hops, owner click without an agent approval, rejection of an approved agent call during
take-over, handback restoring approved agent input, and local Stop closing the viewer, clearing the gate
and refusing subsequent viewers. No input was sent to the user's actual desktop.

Crypto/relay/API tests cover Rust/TS key/framing interop, different directions/transcripts, replay/tamper,
size bounds, one-use ticket admission, wrong parent, duplicate viewers, dial races, backpressure cleanup,
agent-input gating and screenshot crop/downscale bounds. Browser tests exercise 390 px English/Chinese
and 1280 px English: takeover state, coordinate mapping, tap/hold/right-click/drag, two-finger scroll,
pinch zoom, keyboard text, handback, fit/no horizontal overflow and cleanup. The gesture UI test uses a
known stream fixture. The additional 390 × 844 Chromium test uses real labwc → Rust Perch capture →
encrypted Nest and App relays → browser AEAD/JPEG decode → LivePanel. It checks the red wl_shm fixture
pixels, no horizontal overflow, both control labels and host gate state, an actual touch click delivered
to the fixture, handback and viewer cleanup. Only owner-session admission and the chat-page mounting
wrapper are fixtures in this test; it does not perform a signed DSH login. Existing real-kernel
App/API/chat/device approval e2es and the old Rust interop e2e remain green.

Owner-review screenshots (generated evidence, ignored by Git):

- `client/test/screenshots/live-view-390-ivy.png` — **Ivy is in control**, real frame, Take over enabled.
- `client/test/screenshots/live-view-390-owner.png` — **You are in control**, same real frame, Hand back enabled.

Regenerate after building the Rust examples with
`SWIFTNEST_WEB_E2E=1 SWIFTNEST_SCREEN_E2E=1 SWIFTNEST_CHROMIUM=/run/current-system/sw/bin/google-chrome pnpm vitest run client/test/liveView.real.e2e.test.ts`
inside the default devShell. Set `SWIFTNEST_CHROMIUM` to an available Chromium executable, or omit it
when a Playwright-managed browser is already installed. No browser download is performed by the test.

Only **headless labwc/pixman** received actual capture/pointer-input validation; virtual keyboard
injection was not exercised against that compositor. GNOME/KDE portal + PipeWire and X11 are
Linux-compiled but not session-tested. Windows GDI/SendInput has neither a successful Windows compile
nor runtime validation; the previous cross-check lacked target core/std. niri,
multi-monitor/fractional/rotated displays, tray notifications/menu interactions and
physical Android phone/WebView gestures/performance were not manually exercised. No measured 10–15 fps
claim is made: this is the adaptive LAN target, and debug capture under concurrent tests is slower.

Not done: direct App-to-device candidate discovery (current negotiated candidate is the existing Nest
WS relay), an in-panel monitor picker (SDK displayId works), packaging Linux helpers into a distributable
App, physical-phone/backend acceptance, DXGI optimization, H.264/WebRTC and E2c resumable files. macOS
screen/input is deliberately unsupported and not advertised. Linux production deployments need grim 1.5,
wtype, xdotool for X11, and GStreamer/pipewiresrc for portal sessions in PATH; default devShell supplies
them without a system-wide installation. The Nest is a trusted key distributor, not an opaque server
against which end-to-end secrecy is claimed.

---

The following is the historical E2a validation, retained as the baseline (its future-work statements are
superseded by E2b above).

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
