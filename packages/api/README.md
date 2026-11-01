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
