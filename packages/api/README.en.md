# @swiftnest/api

UI-free Apache-2.0 TypeScript client for Swiftnest Server's pinned DSH kernel.
Works without DSH page globals; runtime code uses only Web APIs.

```ts
import { connect } from '@swiftnest/api';

const api = await connect(pairingUrl);
const { sessionId } = await api.createSession();
const events = await api.follow(sessionId); // initial snapshot attached before this resolves
const rendering = (async () => {
  for await (const event of events) {
    // Render event.type: user-message, assistant-delta, assistant-message,
    // tool-start, tool-result, turn-end, error, approval-request, question-request…
    // assistant-start/end delimit attempts. The end event links messageSeq to
    // the final message seq; discard abandoned partial text.
  }
})();
await api.sendMessage(sessionId, 'hi'); // returns admission, not turn completion
// events.close() / AbortSignal / breaking for-await cancels this subscription.
// api.close() disposes the paired connection and every subscription.
```

In Node inject a socket factory that can send the cookie header (`ws` is a test/dev dependency, not a
browser runtime dependency):

```ts
import WebSocket from 'ws';
const api = await connect(pairingUrl, {
  fetch,
  createWebSocket: (url, { headers }) => new WebSocket(url, { headers }),
});
```

`health()` returns typed server/model health; `listSessions()` returns summaries. `createSession({cwd})`
optionally chooses a server-side workspace. One client pairs once; create a new client to reconnect.
A socket loss emits `error` and ends each follow. No automatic retry of mutations. `follow()` begins with
the server's recent history window; phase 0 does not expose older-history pagination. Render durable
messages by `messageId` and streamed attempts by `attemptId`. A `turn-end` does not end the subscription.
Use one consumer per subscription and close it when its view is discarded.

For `approval-request`, use `answerApproval(event.requestId, 'allowed-once' | 'rejected' | 'cancelled' |
'unavailable')`. For `question-request`, call `answerQuestion(event.requestId, {answers: [...]})`. Pending
requests are scoped to followed sessions; an unfollowed session delegates to the next Host answerer.
Host cancellation emits `interaction-cancelled` and invalidates that request id. A continued timed question
can be answered with `answerQuestion({sessionId, callId}, {answers: [...]})`; the original question event
includes its `callId` when available. Reopening historical question cards from projections is left to a
future API expansion.

Browsers require **the same origin as the server**, and use their cookie jar. A packaged Tauri WebView's
origin is usually different: plain cross-origin fetch/WebSocket is blocked by the kernel's Origin and
fetch-site checks as well as browser CORS/cookie rules. Use an authorized native HTTP/WebSocket carrier
in manual-cookie mode, or a same-origin deployment. This package does not bypass those fences or change
server policy. Pairing tokens and cookies are secrets: do not log or persist them in App telemetry.

Tests: `pnpm test`; real chat acceptance: `SWIFTNEST_E2E=1 pnpm vitest run packages/api server`.
Protocol findings: [DSH integration](../../docs/en/dev/dsh-integration.md#swiftnestapi).


## Devices and approvals

After `connect()`, `listDevices()` includes online and paired offline devices. `createDevicePairing()`
returns a five-minute code, LAN dial URL and server fingerprint; `listDevicePairings()` and
`confirmDevicePairing(id, accept)` handle the owner's fingerprint confirmation. `revokeDevice(name)`
disconnects and forgets a device.

Use `listDeviceApprovals()` for pending raw-argument tasks and `answerDeviceApproval(id, accept)` for
an owner decision. A stale decision rejects with `ApiError.code === 'device-conflict'`. These methods
use the App's session, never MCP. `deviceAudit(limit)` returns recent raw-argument audit entries.

```ts
const changes = await client.watchDevices({ signal });
try {
  for await (const event of changes) {
    // Events invalidate snapshots; fetch both on initial subscription and reconnection too.
    const devices = await client.listDevices();
    const approvals = await client.listDeviceApprovals();
    render({ event, devices, approvals });
  }
} finally {
  changes.close();
}
```

`watchDevices()` is a fetch-based SSE stream compatible with browser cookies and the native carrier.
Caller abort, iterator return and `client.close()` release the reader. Reconnect the stream if it ends;
mutating requests are never retried automatically. See [Devices](../../docs/en/guide/devices.md).
