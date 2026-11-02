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

## E2b / E2c stream multiplexing (reserved, not implemented)

Logical stream 0 is the existing encrypted JSON control connection. Future live video and resumable file
transfer use **separate binary WebSocket connections per stream**, rather than filling this socket's
send queue with video or file chunks. A physical single ordered socket cannot eliminate head-of-line
blocking merely by attaching stream ids. This separation keeps cancellation and tool replies responsive.

A future opt-in protocol negotiation introduces stream-open/accept/close control messages with a random
stream id, purpose (`screen` or `file`), direction, limits and transport candidates (LAN-direct first,
server relay otherwise). Old v1 peers never receive these messages. Each binary connection must mutually
authenticate, bind its stream id and parent transcript using an expiring one-use HMAC ticket, and derive
separate directional AEAD keys/counters with HKDF domain separation. Relay transport never terminates
end-to-end encryption. No stream id or unencrypted frame is sufficient authorization.

Binary records will carry version, stream id, sequence/offset, length, flags and authenticated payload;
size/window quotas and bounded per-stream queues prevent memory exhaustion. Video drops obsolete frames
instead of blocking. File chunks use acknowledged offsets plus per-chunk and final content hashes;
resumption is bound to the paired identities and transfer metadata, never a host-supplied arbitrary path.
Device capabilities get a host-provided stream registry alongside their invoke context. Control remains
independent of bulk scheduling. Take-over will be a host-owned input gate: owner input pauses agent input
before any queued input is injected. These are design reservations only; no capture, input, stream,
transfer, relay or take-over implementation is included in E2a.
