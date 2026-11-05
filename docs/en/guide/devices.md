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
  mdns: true # false disables discovery; the displayed address still works
```

The desktop App includes a Rust Perch under **This device**, off by default. Follow
[Control this computer](./control-this-computer) to choose folders and pair it. Android device control
is hidden for now. The existing Node Perch remains available for CLI development.

## App pairing survives restarts

Pair the desktop or Android App once using the server's connection link. Applying plugins, updating the
server or restarting DSH reconnects automatically and keeps your chats. Closing and reopening the App
also restores its pairing. Reconnection never resends a message or creates a chat.

Each App connection appears in **Devices** even before device control is enabled. **Revoke device**
invalidates its saved App credential immediately. When **This device** is also paired, its device entry
covers the App connection too; revoking it or choosing **Unpair** forgets the App pairing. Only revoked
or expired pairings need a new connection link (App credentials expire after one year).

The server saves credential hashes in `<home>/native-pairings.json` with mode 0600. The App saves its
credential in its private application data folder with mode 0600 on Unix/Android; it never puts it in
URLs, logs or Web storage. Keep the server home when upgrading to retain pairings.

## How the App connection is protected

New App pairing links carry the server identity and LAN addresses. The App checks that identity before sending its pairing credential inside an encrypted channel. Chats, approvals and device events share that channel. Each connection gets fresh session keys; altered or replayed data closes the connection. If the server identity changes, the App asks you to pair again. Get the new link from a server you trust.

Native Apps use this channel even with LAN HTTP addresses. LAN browsers must open the server page over HTTPS to protect the page's code as well; only the same-origin localhost page may keep its existing direct connection. Old links still work locally or over HTTPS. Old LAN HTTP links need a fresh pairing link, and browsers also need HTTPS. Browser pairing credentials stay in memory: page reloads require pairing again, while plugin restarts reconnect automatically.

Keep `app-channel-key.json` in the server home when upgrading or moving it; this mode-0600 file holds its identity. The address list reserves an empty relay slot. There is no default relay or automatic connection to an external relay.

## Approve a request

Open **Approvals** from the count shown on every App page. Chat tool requests, device actions and incoming files wait in one inbox, even when their chat is closed. Open **Details** to review who asked, the device, original arguments, risk and deadline, then choose **Approve** or **Deny**. Answering in chat, Devices or another App removes the request everywhere. Each request grants only one action.

All three kinds wait ten minutes by default. An unanswered request is denied; stopping the server also denies pending requests. Under **Preferences → Approvals**, “Remind me when my approval is needed” is saved now; notifications will be added separately. **Advanced options** holds each kind's waiting time (1 second–24 hours) and automatic low-risk approval, which is off by default. Changes affect new requests. Only a source-classified `read` request qualifies as low risk; DSH requests without a risk classification remain sensitive.

The audit log records each decision's time, owner or system actor, and the paired device or App pairing identifier. Browser sessions without an App pairing use an identifier derived from their authenticated credential. It does not record the credential itself. Automatic decisions are marked explicitly. If audit storage fails, the action is denied.

DSH native device calls wait until the decision and return their result or a denial. There is no agent-side approval tool. External MCP clients retain the task-id/status/wait interface.

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

| Method | Path                                | Result                                                                                   |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/`                                 | Online and paired devices                                                                |
| POST   | `/pairing`                          | Code, expiry, dial URL, address/port and server fingerprint                              |
| GET    | `/pairing`                          | Pending fingerprint confirmations                                                        |
| POST   | `/pairing/:id/approve` or `/deny`   | Confirm or reject a candidate                                                            |
| POST   | `/revoke/:device`                   | Disconnect and forget a device                                                           |
| GET    | `/approvals`                        | Pending tasks with original arguments                                                    |
| POST   | `/approvals/:id/approve` or `/deny` | Answer once; stale decisions return 409                                                  |
| GET    | `/audit?limit=100`                  | Recent audit entries                                                                     |
| GET    | `/events`                           | SSE invalidations: devices-changed, approval-pending, approvals-changed, pairing-changed |

`POST /swiftnest/api/chat` accepts `{ request, deviceSlug? }` under the same owner admission;
`request` is the existing DSH session prompt request. Prefer `SwiftnestClient.sendMessage()`.

Use the typed helpers in `@swiftnest/api`; `watchDevices()` supports browser and native/manual-cookie
fetch carriers, cancellation and client disposal. Push events invalidate snapshots; fetch current lists
on subscription/reconnection. The App reconnects the stream and periodically refreshes snapshots.

### Unified approval API

Owner routes under `/swiftnest/api/approvals` use the same admission and encrypted App channel:

| Method | Path                        | Result                                                   |
| ------ | --------------------------- | -------------------------------------------------------- |
| GET    | `/`                         | `{ items, settings }`, pending requests only             |
| GET    | `/events`                   | SSE invalidations; reread after subscribing/reconnecting |
| POST   | `/:id/allow` or `/:id/deny` | One decision; stale answers return 409                   |
| POST   | `/settings`                 | Validated complete settings, saved privately             |

Use `approvalInbox()`, `watchApprovals()`, `answerInboxApproval(id, allowed)` and `updateApprovalSettings(settings)` in `@swiftnest/api`. Legacy device answer routes and `answerApproval()` also settle through this inbox. Settings are stored in `<home>/approvals.json` (0600); YAML `approvals` supplies defaults until the App saves settings:

```yaml
approvals:
  remind: true
  autoAllowLowRisk: false
  timeouts:
    dsh: 600000
    device: 600000
    transfer: 600000
```

## Native DSH plugin contract

Every capability tool of every paired device is registered by the Swiftnest bundle **inside the DSH
child process**, with the exact native name `device__<slug>__<capId>_<tool>`. For example:
`device__laptop__files_read`, `device__laptop__files_write`, `device__laptop__shell_run`.
The bundle forwards calls over the authenticated loopback control channel to the Nest in the parent.
The generated `cordis.patch.yml` no longer adds a device MCP client.

A slug is chosen from the device name at pairing, matches `[a-z0-9_-]{1,24}`, and is unique among paired
devices. Names are normalized to lowercase ASCII; unsupported runs become `-`, an empty result becomes
`device`, and collisions receive `-2`, `-3`, etc. within the length limit. It is stored in `paired.json`
and never changes: renaming changes only the display name. Existing records are migrated automatically;
valid stored slugs are reserved before assigning slugs to older records. Devices default to `desktop`;
a Perch can advertise `kind: 'android'` in its authenticated hello.

Plugins can inject `swiftnestDevices` (types exported from `@swiftnest/server-bundle/native-devices`):

```ts
interface SwiftnestDevices {
  list(): { slug: string; name: string; kind: 'desktop' | 'android'; online: boolean; lastSeen?: string }[];
  currentFor(sessionId: string): string | undefined;
}
// Swiftnest provides it via ctx.provide('swiftnestDevices', service).
```

Both methods are synchronous. `list()` includes offline paired devices and returns a snapshot.
`currentFor()` returns the device slug reported by the App connection that most recently sent an accepted
chat prompt for that session. A native device App sets `ClientOptions.deviceSlug` when connecting through
`@swiftnest/api`; `sendMessage()` sends it with the actual prompt to `/swiftnest/api/chat`. The server checks
the signed owner session and that the slug is paired before dispatching the existing DSH session prompt.
The server-host web App omits it and maps to `undefined`, as do unknown sessions and revoked devices.
This owner-reported connection hint is routing context, not proof of physical presence or permission
to execute a device tool. It is held in memory and refreshed by the next chat after a server restart.

On pairing, revocation, online and offline transitions, the bundle emits:

```ts
ctx.emit('swiftnest/devices-changed', { slugs: ['laptop'] });
```

`slugs` identifies affected namespaces, including a revoked slug. Subscribe and reread `list()`; startup
and control-channel reconnection also reconcile snapshots. Tool registration and metadata updates finish
before the event is emitted. Display-name and capability metadata changes also invalidate the snapshot.

**Offline tools stay registered**, including across server restarts. A call fails with
`device <slug> is offline (last seen <ISO time>)`. Only revoking the device removes its tools. Tool schemas,
summaries and risk metadata are cached in `seen.json`. Legacy E1 records only cached tool names: their
offline tools use an open object schema and conservative `sensitive` catalog risk until the next Perch
connection supplies full metadata. Offline calls always fail before execution.

If `toolCatalog` exists, each tool receives:

```ts
toolCatalog.annotate(name, { category: 'device', group: slug, risk, summary });
```

`risk` comes from the capability's tool metadata (`read | write | exec | sensitive`); `summary` is its
English description. An absent catalog is silently skipped. Call-time argument classification and the
Nest policy still decide whether approval is needed.

There are **no native task meta tools** (`device__task_*`): native calls wait through policy, owner
approval and execution, preserving the existing ten-minute approval timeout and capability execution
timeout. Cancellation requests cancel the Nest task. Pairing, revocation and approval are owner App
actions, never agent tools.

## External MCP

The separate loopback MCP endpoint remains available for external agents with its own random bearer
credential. Its raw names remain `<device>__<capId>__<tool>` and `swiftnest__task_status`,
`swiftnest__task_wait`, `swiftnest__task_cancel` (plus `swiftnest__devices`). MCP discovery continues to
reflect online devices and send `tools/list_changed`; it is independent of the native DSH registry.

The admin and MCP ports are allocated by the OS and credentials change each process. Credentials are
passed through the environment, never written into generated patches. The owner API proxy cannot reach
the private native call/control routes. No approval endpoint is exposed through MCP. These are local
process trust boundaries, not a sandbox for hostile server plugins or code running as the server's OS user.

## Live view

On an Ivy chat, choose an online screen-capable computer to [watch and take over](./live-view).
The computer must enable device control and the independent Allow live view permission. Only the owner
session admitted by the existing devices API can open a stream; MCP/native agent tools have no viewer
route. Input tools retain their normal approvals and fail during owner take-over.
