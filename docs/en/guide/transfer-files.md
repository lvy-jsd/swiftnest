# Transfer files

Open **Devices → Send file to…**, or **Transfers → Send file to…**. Select the source device,
source file, destination device and full destination filename. The desktop App also has **Choose a file
on this computer**. Picking a file does not share its folder: add the folder under **This device** first.
Both endpoints must remain running; closing a background-enabled desktop window is fine.

You can ask Ivy: “Send `/Shared/video.mp4` from my computer to `/Shared/video.mp4` on my phone.”
Ivy uses `transfer_file` with paired device slugs. Use `server` for the server's own file storage:

```json
{
  "source": { "device": "computer", "path": "/Shared/video.mp4" },
  "destination": { "device": "phone", "path": "/Shared/video.mp4" }
}
```

`transfer_file` returns an id after a bounded metadata read, without waiting for the file. `transfer_status`
reports progress; `transfer_cancel` stops a transfer. The App receives `transfers-changed` events and
shows progress cards in chat and the Transfers view, including speed, ETA, pause/resume, cancel and retry.
Speed is a sample of durable acknowledged bytes; hashing or waiting for a connection can show zero speed.

## Approval and integrity

The source must be a regular file inside a shared folder. Protected credentials, browser profiles and
Swiftnest private state are refused, including through symlinks. The destination folder must already
exist and be shared. An existing destination is refused; choose another name. The owner reviews one
**write** approval containing both identities, both paths, size, modification time and a content prefix
hash. Approval is saved by the destination and reused when that same transfer resumes. A changed source,
paired identity or destination creates a different transfer and requires a new approval. Removing a
shared folder takes effect on reconnect; saved approval does not bypass path checks.

Transfers use 4 MiB chunks and SHA-256 for each chunk, the first 1 MiB identity prefix and the whole file.
Only one chunk is in flight. Each acknowledgement follows a durable disk write and journal update.
Bad chunks are requested again (up to three transmissions per attempt). The destination writes
`.swiftnest-<transfer-id>.part` beside the destination and atomically renames it only after final hash
verification. A resume verifies the already acknowledged prefix; a damaged partial file restarts at zero.
No partial file appears under the final name.

Network changes reconnect automatically. After an App restart, enable/resume the same paired device;
the server continues from the destination's saved offset. Pausing survives server restart. Cancel stops
scheduling and closes the encrypted streams. Partial files and their quota reservations are retained;
remove an unwanted `.part` file and receipt with owner-managed file cleanup when no transfer is running.
A cancelled id cannot be resumed through the App; use another destination name to start afresh.

## Direct, relay and server storage

The Nest exchanges an IPv4 candidate from the sender's authenticated connection. The receiving Perch
tries it, using a fresh secret ticket and the same stream-v1 authenticated encryption. If unreachable,
both sides use the Nest relay. Firewalls may prevent direct connections; no router or firewall setting
is changed. `"routing": "relay"` forces the relay for diagnosis. IPv6 candidate discovery, multiple
network-interface selection and NAT traversal are not implemented. The control connection to the Nest
must remain alive even during a direct transfer.

For device-to-device transfers the relay forwards ciphertext. The trusted Nest distributes each
attempt's keys over the paired encrypted control channels and could derive plaintext; this is not secrecy
against the trusted Nest itself. For device-to-server transfers the server is the intended plaintext
endpoint, storing files under `config.home/files`. Relative server paths start there; paths outside that
area and protected paths are refused. Uploads need the same write approval.

Configure server capacity in YAML:

```yaml
files:
  quotaBytes: 107374182400 # 100 GiB, also the default
```

Or set `SWIFTNEST_FILES_QUOTA_BYTES`. Zero refuses nonempty uploads. Existing files, partial files and
the remaining sizes of approved uploads all count toward the quota; simultaneous approvals reserve
capacity serially. Available physical disk space can still be smaller than the configured quota.
The server's transfer index is private `config.home/devices/transfers.json`; receipts are in
`config.home/devices/file-receipts`. Native destination receipts are in the host's private `transfers`
directory. Do not edit receipts while transfers are active.

The automated acceptance uses two real Linux Rust Perches and the server on loopback, 200 MiB files,
direct/relay connections, process restart and hash verification. Physical phone performance and native
file dialogs still require device validation; the bilingual UI is tested at 390 px in Chromium.
