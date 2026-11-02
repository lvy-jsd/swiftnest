# Perch device core

`swiftnest-perch` is a Node-free library shared by Tauri hosts. The server remains the only Nest.
`Controller` owns the saved identity/settings, one cancellable connection task and a UI snapshot. The host
supplies its private data directory and performs fingerprint consent; no capability can grant approval.
Configuration changes stop/drain the previous session before changing roots. Turning control off keeps
the pairing; unpair stops it and removes the local Nest pin. The server entry is revoked separately.

## Control channel (implemented)

The v1 JSON wire format is the TypeScript implementation's format, not a new protocol: exact hs1/hs2
transcript bytes, X25519, HKDF-SHA-256, Ed25519 authentication and AES-256-GCM, independent direction
counters starting with auth at zero. Replay, ordering, authentication and size errors terminate the
session. WebSocket and encoded/decrypted frames are bounded by 16 MiB. Only rustls TLS is enabled.
Pairing sends an HMAC of the six-digit code bound to the transcript. Both owners must compare fingerprints;
the pin is saved before hello. Reconnect uses the pin, fresh ephemeral keys and counters; a changed key or
revocation stops retries. WebSocket ping/pong (15 s / 45 s) works with existing v1 TS peers. Retries use
1–30 s exponential backoff and jitter. An interrupted initial pairing needs a fresh owner attempt.

The capability trait mirrors TS manifest/classify/invoke. At most 32 calls run concurrently, each with a
cancellation token and timeout (maximum one hour). Disconnect, disable and exit cancel/drain calls.
File operations run on the blocking pool and check cancellation before mutation; completed filesystem
mutations cannot be undone by cancellation. Manifests are checked-in copies of the TS tool descriptions
and schemas; the Vitest parity test detects drift. An optional hello `name` updates only the server's
human label; the protocol identity and server-assigned slug stay stable.

## Storage and permissions

The host's data directory contains a raw 32-byte Ed25519 seed (`identity.key`) and atomic `settings.json`
with the Nest public key, stable device slug, display name, folders, URL and opt-in flags. No secret enters
the WebView. Unix directory/file modes are 0700/0600; Windows restricts directory inheritance using
`icacls` before key creation. Existing corrupt keys fail closed. OS keyring integration and at-rest key
encryption are follow-ups. Local processes running as the same OS user are outside this trust boundary.

Files follow the TS realpath/nearest-existing-ancestor guard and protected location list, augmented with
native browser/keychain paths and the host data directory. Empty roots share nothing. Like the TS guard,
this is not an atomic defense against a hostile same-user process swapping directories during file I/O.
File reads/listing are bounded to 512 KiB/500 entries; shell output to a combined 64 KiB.

Shell classification ports the TS cases. Read commands execute directly with arguments; approved exec
uses `sh -c` on Linux/macOS. Linux additionally requires **bubblewrap** in PATH and usable user namespaces:
only system executable/library mounts and the selected folders are visible; protected descendants are
masked, read-classified calls get read-only shared mounts (so flags such as `sort -o` cannot
bypass approval), the environment is cleared, networking/PID/IPC namespaces are isolated. macOS uses
`/usr/bin/sandbox-exec` with deny-by-default file access; availability and real-hardware behavior need
platform validation. Windows' chosen future shell is `cmd.exe /D /S /C`; shell invocation currently fails
with `SANDBOX_UNAVAILABLE` until a filesystem-isolating Windows executor is available. Android likewise
fails closed for shell. File tools and the Rust protocol are portable. No platform silently runs an
unconfined command. Unix cancellation kills the whole process group and the sandbox PID namespace.
Runtime/library files are necessarily readable in the shell sandbox; user data outside the roots is not.

## E2b streams (implemented) / E2c reuse

Peers opt in with hello `extensions: ["streams-v1"]`; legacy v1 peers never receive stream messages.
The Nest sends encrypted `stream_open` (random 128-bit hex id, purpose, duplex direction, transport candidates, limits, display, expiry and
one-use ticket), Perch responds with `stream_accept` or `stream_close`. Either side can close at any
time; parent disconnect/revocation closes every child stream. The device dials a separate binary
WebSocket on its saved parent URL, using `?stream=id&ticket=...`. This version negotiates the existing
Nest relay transport; direct App-to-device candidate discovery is a follow-up.

A private exporter is HKDF-SHA256(shared X25519, salt=parent transcript,
info=`swiftnest/streams/v1`, 32). The ticket is HMAC-SHA256(exporter,
`swiftnest/ticket/v1\0{id}\0{expiresMillis}`); the registry consumes it once, with a 15-second deadline.
Per-stream directional keys are HKDF-SHA256(exporter, salt=parent transcript,
info=`swiftnest/stream/v1/{id}`, 64): first 32 bytes device-to-viewer, second 32 viewer-to-device.
The owner-only HTTP API returns only that stream's keys. App admission uses the devices API's signed
owner session and Host/Origin checks; the bundle forwards only its private loopback admin bearer.
Agents cannot reach stream creation or socket admission through native tools/MCP. The App enforces HTTPS for LAN key exchange; only loopback development permits HTTP. The bundle also
rejects non-TLS remote stream requests (TLS may terminate at a trusted loopback reverse proxy), without
trusting forwarded-proto headers. Browser AEAD additionally requires a secure context. The Nest is a trusted key distributor but both relay hops forward opaque ciphertext; neither
relay decrypts video/input records. This does not provide secrecy against the trusted Nest process.

Records are `[version:u8=1][id:16][sequence:u64 BE][flag:u8][length:u32 BE][ciphertext][GCM tag:16]`.
All 30 header bytes are authenticated AAD; the nonce is four zero bytes plus the sequence. Directions
start at zero, and replay, counter exhaustion, wrong id/length/tag terminate the stream. Flag 1 is
`metadataLength:u32 BE + JSON metadata + JPEG`; flag 2 is owner JSON (ready, frame_ack, takeover,
handback or input), flag 3 is host control status/error. The device waits for an encrypted owner ready
before capturing. No plaintext record or stream id grants input authority.

Limits: 4 MiB payload, 64 KiB owner WebSocket messages, 32 streams globally, one viewer per parent,
15 seconds to attach and one-hour viewer leases. Relays close above an 8 MiB buffered high-water mark.
Native captures are serialized across tools/live view, and only one acknowledged video frame is in flight; stale capture opportunities
are skipped. Already-encrypted frames are never dropped (that would skip a sequence). The App keeps two
latest updates and bounded crypto/input work queues. RTT acknowledgements adapt JPEG quality 35–80
and frame intervals 80–1000 ms; capture CPU cost also limits achieved fps. Unchanged pixel hashes are
not transmitted. H.264/WebRTC is the intended future video transport.

The shared registry/negotiation/AEAD framing reserves purpose `file` for E2c. E2b accepts only `screen`
in the native producer. File transfer must add acked offsets, chunk/final hashes, identity-bound resume
metadata, path approval and reliable bounded scheduling before enabling that purpose. It must not use
video's stale-frame semantics. Bulk I/O remains independent of JSON cancellation and task replies.

## Screen/input ownership and privacy

The host must call `set_indicator_ready(true)` after installing observation UI. The App uses a working
tray as this prerequisite; otherwise screen/input are not advertised. Only Linux and Windows advertise
them. `allowLiveView` is a separately persisted, default-false setting, checked alongside device enable
and host readiness. The tray changes to red and emits a start notification while observing; the local
page reports observation/take-over. Local Stop disables the live permission, cancels the stream and
backend, and requires another opt-in. Disable/unpair/exit cancel and drain the parent as before.

Agent screen tools have read risk and return base64 PNG/JPEG plus image size, crop, scale and a host
capture id in structured data. Screen content is untrusted. Input has exec risk. Host-saved capture
geometry maps screenshot coordinates back to native display pixels and is checked against current
display geometry; callers cannot supply a scale to bypass it. The host-owned gate publishes owner mode
before draining an existing injection; every queued agent injection checks the gate inside its native
injection lock. Owner input requires owner mode and is available only inside the authenticated stream.
Handback/disconnect/stream failure releases mode; rejected agent actions are not replayed.

Linux discovers protocols per current session: grim 1.5 implements wlr/ext capture, Rust uses
output-bound zwlr_virtual_pointer_v1 and wtype uses zwp_virtual_keyboard_v1. xdg-output provides logical
geometry/fractional scale. Missing virtual-input/capture protocols select ScreenCast + RemoteDesktop
portals, with an explicit OS chooser, a nonpersistent session and one bounded latest PipeWire/GStreamer
RGB frame. Portal coordinates describe the normalized logical stream. X11 uses XGetImage and
xdotool/XTest; Windows uses GDI and SendInput, with DPI-aware coordinates. Helper programs run as argv,
never through a shell. macOS screen/input is unsupported. See VALIDATION.md for actual backend evidence;
compilation is not evidence of GNOME/KDE, Windows, niri or phone-hardware behavior. Linux helper bundling,
direct transport candidates, monitor-picker UI and H.264/WebRTC remain follow-ups.
