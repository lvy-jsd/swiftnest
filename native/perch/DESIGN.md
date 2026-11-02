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
Agents cannot reach stream creation or socket admission through native tools/MCP. The Nest is a trusted
key distributor but both relay hops forward opaque ciphertext; neither relay decrypts video/input
records. This does not provide secrecy against the trusted Nest process.

### HTTPS outside loopback

The App API requires an `https:` server URL outside `localhost`, `127.0.0.1` and `[::1]`, including
when using the native HTTP/WebSocket carrier. The live-offer HTTP response contains the stream's
directional AES keys. Sending that response over LAN HTTP would expose those keys and the owner
session to an observer; encrypted binary records alone would then offer no protection. Browser
`crypto.subtle` also requires a secure context (HTTPS, with loopback permitted for development).
The native WebView's secure context does not protect an HTTP request to a remote server.

The bundle rejects remote non-TLS live-offer requests with HTTP 426 and rejects their socket upgrades.
It accepts a TLS socket or a loopback peer, allowing TLS termination at a trusted local reverse proxy;
it never treats `X-Forwarded-Proto` as proof of TLS. That proxy must enforce HTTPS/WSS on its public
listener and preserve the kernel's Host/Origin admission requirements. The loopback exception cannot
detect an incorrectly configured proxy that publicly exposes HTTP. These tests exercise loopback and
the TLS admission predicate; they do not validate a deployed TLS proxy/certificate setup.

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

The shared registry/negotiation/AEAD framing also carries purpose `file` in E2c (specified below).
Reliable file scheduling uses acknowledged offsets, chunk/final hashes and identity-bound approvals,
independently of video scheduling. Bulk I/O remains independent of JSON task replies.

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

## Backend validation boundary

| Backend | Evidence | Still unverified |
| --- | --- | --- |
| wlroots on headless labwc/pixman | Real screen capture, approved agent pointer input, encrypted live frames, owner take-over/input/handback/local Stop; Chromium LivePanel at 390 px with screenshots of both control states | Physical desktop/phone performance, virtual keyboard behavior, other wlroots compositors including niri, fractional/rotated/multiple displays |
| GNOME/KDE ScreenCast + RemoteDesktop portal/PipeWire | Linux compilation and Clippy only | Portal chooser/session lifecycle, real PipeWire frames and input on GNOME or KDE |
| X11 XGetImage + xdotool/XTest | Linux compilation and Clippy only | An actual X11 session, capture and input |
| Windows GDI + SendInput | Source implementation only; previous cross-check failed because the target standard library was absent | Windows compilation and runtime; DXGI is future work |
| macOS | Explicitly unsupported; screen/input not advertised | Backend implementation |

Playwright uses a real isolated labwc framebuffer and the actual Rust/crypto/relay/browser decoder.
Its owner-session admission is a test fixture, not a signed DSH login; signed-session/chat behavior has
separate kernel e2es. Browser gesture fixtures cover English/Chinese and desktop layout. Neither those
tests nor Linux compilation establishes Android WebView, tray-menu/notification or other OS acceptance.
See [VALIDATION.md](./VALIDATION.md) for commands, results and screenshot locations.

## E2c reliable file streams (implemented)

`transfer_file` is a server-level Ivy tool; `transfer_status` and `transfer_cancel` complete its agent
surface. The App uses owner-admitted `/swiftnest/api/devices/transfers` and receives
`transfers-changed` on the existing devices event stream. Start performs a bounded 1 MiB source
inspection and returns the immutable transfer id; approval and all bulk I/O run in background jobs.
Native `transfer.inspect`, `transfer.receive` and `transfer.status` are endpoint helpers, filtered out
of the DSH device catalog. They share files' PathGuard. The parent's progress monitor checks read
classification/policy directly, without retaining one task/audit entry per second; the receive approval
and transfer lifecycle remain recorded in the audit log and durable transfer index.

### Identity, consent and durable offsets

The id is the lowercase SHA-256 of UTF-8 compact JSON:
`["swiftnest/file/v1",sourcePublicKey,destinationPublicKey,sourcePath,destinationPath,size,mtimeMillis,prefixSHA256]`.
The prefix is the first min(size, 1 MiB) bytes. Both paired Ed25519 identities, both paths, size, mtime
and prefix are immutable; every reconnect checks the paired identities and source metadata. Metadata
uses safe integer byte counts/milliseconds. Source contents changing in the middle of a transfer fail
verification unless the received complete bytes still match the sender's final hash; concurrent source
writers are not locked. Do not edit the source during transfer.

`receive` has **write** risk and the normal TaskManager owner approval. Its full binding is displayed
in the existing approval UI, including name (in the paths), size, source and destination. Its successful
invocation creates a private receipt and an exclusive 0600 temporary file in an existing shared folder.
The native receipt is stored in `<host-private-data>/transfers/<id>.json`. Only an exactly matching
receipt and destination identity permit a file offer to receive bytes; a stream offer alone cannot
grant write approval. Approval survives link/process restarts, but current protected/shared-folder
checks still run. `inspect` is read risk only inside shared folders; out-of-root/protected paths are
classified sensitive and refused even if approved. Destination files already present are refused.

Chunks are fixed at 4 MiB in this version (including a possibly shorter final chunk, and empty files).
SHA-256 covers each chunk and the complete file. Encrypted flag **4** carries at most 8 KiB JSON:
`ready {offset,prefix}`, `chunk {offset,length,hash}`, `ack {offset}`, `retry {offset}`,
`reset`, `finish {hash}`, or `complete {hash}`. Flag **5** carries raw chunk bytes. The chunk header
and data are separate AEAD records, so a 4 MiB chunk fits the existing stream maximum. One chunk is in
flight. A bad chunk is requested again at the same offset, up to three transmissions per attempt;
AEAD authentication errors close the attempt (fresh keys on retry). Replays never get a retry exception.

ACK follows `write_all`/datasync and an atomic fsynced receipt replacement. On reconnect, unacknowledged
tail bytes are truncated; source and destination independently hash the acknowledged prefix. A mismatch
resets the offset to zero. Final mismatch likewise resets without publishing a final file. Only after
whole-file verification is `.swiftnest-<id>.part` atomically renamed within the destination folder.
A saved `committing` hash recovers a crash between rename and recording `complete`. The same hostile
same-user directory-swap boundary as files applies to final existence checks and rename. Unix native
journals and destination directories are synced; other filesystems/platforms need hardware validation.

Pause/cancel drains the attempt and closes its child streams. Paused jobs stay paused across server
restart. Other active jobs recover from the persisted server index. Cancel keeps partial bytes and
receipts (including server quota reservations); owner cleanup is explicit, not an automatic delete.
A retry reuses the same immutable approval. Missing/corrupt private receipts fail closed. The UI's
cancelled ids are terminal; starting with a different destination creates a new id/approval.

### Transport and resource bounds

File offers reuse encrypted `stream_open`/`stream_accept`/`stream_close`, one-use relay tickets and the
stream-v1 AEAD envelope. The Nest distributes a fresh random 32-byte file root and random 128-bit
`cipherId` in BOTH endpoints' authenticated control offers on EVERY attempt. HKDF-SHA256 uses this
root, a 32-byte zero salt and `swiftnest/stream/v1/<cipherId>` to derive sender/receiver keys. Both
endpoints authenticate the common cipherId in record AAD; relay socket ids/tickets remain distinct.
Counters restart only with fresh attempt keys, including pause/resume and transport failure. Keys and
tickets never enter transfer persistence, agent replies, chat cards or owner file-transfer HTTP replies.
The Nest is the same trusted key distributor as E2b; device-device relays forward opaque records and
never invoke a plaintext codec. Device-server transfers intentionally decrypt at server storage.

For automatic routing, the sender listens on an ephemeral IPv4 port and returns the IPv4 address used
by its parent connection as a candidate in encrypted `stream_accept`. Nest forwards it to the receiver.
A random per-attempt 192-bit ticket admits the direct WebSocket; all subsequent records are AEAD.
The receiver tries up to three candidates, 800 ms each. The sender waits four seconds for direct
admission, then both use the existing Nest relay. `routing: relay` disables discovery/listening.
The current candidate set is one IPv4 interface, without NAT traversal or IPv6 discovery. A parent
disconnect/revocation also ends direct sockets. The App is a controller, not a bulk browser uploader.

The Rust sender/receiver hold one chunk, its AEAD record and constant-size hashing buffers. The server
storage pull inbox holds at most two records, and file relays enforce the existing 8 MiB socket high
watermark. The global registry allows 32 streams and the native session at most four child streams.
File attempt leases are 24 hours, with 30-minute read/hash idle deadlines and cancellable waits; screen
limits remain unchanged. Source reads, hash-prefix scans, writes and queues do not scale with file size.
SHA-256 prefix rescans on resume take O(acknowledged bytes) time, with bounded memory. Progress is a
once-per-second destination journal snapshot, speed is durable-byte delta, and ETA is an estimate.

Server files live exclusively under `config.home/files`, with private receipts under
`config.home/devices/file-receipts`. This explicit server-owned storage root is exempt from the
outer SWIFTNEST_HOME denial; symlink escapes, other protected paths and out-of-root paths remain refused.
`files.quotaBytes` (or `SWIFTNEST_FILES_QUOTA_BYTES`) defaults to 100 GiB. Quota counts existing files,
partials and the remaining size of approved uploads; serialized reservations prevent concurrent
approval overcommit. Physical ENOSPC and filesystem faults still require owner attention. Existing
legacy TS Perches without `transfer`/file streams cannot participate; native Perches advertise the
new endpoints during hello. See the English/Chinese **Transfer files** guides and VALIDATION.md.
