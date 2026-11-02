# Devices

English | [简体中文](../../zh/guide/devices.md)

Swiftnest Server is the **Nest**: it runs the agent, plugins, memory and external tools. Each controlled
computer or phone connects as a **Perch** and exposes only its own capabilities. The web App chats and
manages devices. Installing the server does not grant it control of your computer or phone.

## Pair a device

1. Connect your App using the server's App link, then open **Devices → Pair a device**.
2. On the device's Perch, use the displayed address and six-digit code. A code expires after five minutes,
   works once and closes after five wrong proofs. Generating another code invalidates the earlier one.
3. Compare the fingerprints on both screens. Confirm the device fingerprint in the App and the server
   fingerprint on the device. Both confirmations are required; a code alone does not complete pairing.
4. The device appears online with its capabilities. When it disconnects, its pairing, last observed
   capabilities, connection method, fingerprint and last-seen time remain visible.

The device listener defaults to port **7711** on the same address as the server; mDNS discovery is enabled.
For another machine, configure a reachable LAN address (the default `127.0.0.1` is local only), permit that
port through your firewall, and keep the App/API host reachable too. The displayed WebSocket address is the
address the device should dial; encrypted, mutually authenticated Swiftnest messages run over that link.

```yaml
host: 192.168.1.20
# Optional: follows host by default.
devices:
  host: 192.168.1.20
  port: 7711
  mdns: true   # false disables discovery; the displayed address still works
```

This server feature does not ship desktop/Android device-side integration. A compatible Perch is needed;
the existing Node Perch and capability plugins can be used for development.

## Approve a request

Reads pass the default policy. Writes, execution and sensitive operations wait for you. A chat banner
opens a request sheet; the Devices page lists the pending cards. Review the **device, tool, original JSON
arguments, risk, reason and requesting client** before choosing **Approve** or **Deny**. Approval applies to
that task once. Pending requests expire after ten minutes and fail closed on server shutdown.

The agent receives a task id while waiting and can use `swiftnest__task_wait` or `swiftnest__task_status`
to get the result. There is no MCP tool for approval, pairing or revocation. Approvals require your
App's authenticated owner session. The requesting client currently identifies DSH's MCP client, rather
than an individual chat, so the banner shows all pending device requests.

**Revoke device** asks for confirmation, disconnects it immediately and removes its pairing. Reconnecting
then requires a new code and fingerprint confirmation. Revocation also removes offline devices.

## Storage and audit

Everything lives under `<home>/devices/`: `identity.pem`, `paired.json`, `seen.json` and `audit.jsonl`.
Keep the server identity and paired-device file private. Preserve them when moving the server to retain
pairings; losing them requires pairing again. The audit log records task transitions, requesting clients,
raw arguments, decisions and failures, including reads and denied calls. It can contain private data.
Recent entries are available through `SwiftnestClient.deviceAudit(limit)` (default 100, maximum 1000).

## Developer API

All paths below are under `/swiftnest/api/devices` and use the same signed owner session and Host/Origin
fence as the existing App API. Cross-site requests and unauthenticated requests are rejected.

| Method | Path | Result |
|---|---|---|
| GET | `/` | Online and paired devices |
| POST | `/pairing` | Code, expiry, dial URL, address/port and server fingerprint |
| GET | `/pairing` | Pending fingerprint confirmations |
| POST | `/pairing/:id/approve` or `/deny` | Confirm or reject a candidate |
| POST | `/revoke/:device` | Disconnect and forget a device |
| GET | `/approvals` | Pending tasks with original arguments |
| POST | `/approvals/:id/approve` or `/deny` | Answer once; stale decisions return 409 |
| GET | `/audit?limit=100` | Recent audit entries |
| GET | `/events` | SSE invalidations: devices-changed, approval-pending, approvals-changed, pairing-changed |

Use the typed helpers in `@swiftnest/api`; `watchDevices()` supports browser and native/manual-cookie
fetch carriers, cancellation and client disposal. Push events invalidate snapshots; fetch current lists
on subscription/reconnection. The App reconnects the stream and periodically refreshes snapshots.

The parent process owns the Nest. The DSH bundle proxies owner-authorized requests to a loopback admin
listener. A separate loopback MCP listener uses its own random bearer credential. Both ports are allocated
by the OS and credentials change each process; the generated DSH patch contains only an environment-variable
expression for the MCP header. No approval endpoint is exposed through MCP. These are local process trust
boundaries, not a sandbox for hostile server plugins or code running as the server's OS user.

DSH tools are named `mcp__devices__<device>__<capability>__<tool>`; task meta tools are also prefixed
`mcp__devices__swiftnest__task_*`. Device changes send MCP `tools/list_changed`. The real-kernel acceptance
test checks additions and removals in an existing conversation and discovery in a new conversation;
no server or kernel restart is used.
