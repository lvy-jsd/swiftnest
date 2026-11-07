# Session cache acceptance evidence

PR #76 implements a connection-scoped live cache, not a durable offline replica.

## Reproduce automated checks

Build the client and run the real-kernel browser cases:

```sh
pnpm --filter @swiftnest/app build:web
SWIFTNEST_WEB_E2E=1 pnpm exec vitest run client/test/sessionCache.real.e2e.test.ts client/test/web.e2e.test.ts
```

Set `SWIFTNEST_CHROMIUM` to an installed Chrome/Chromium executable when the Playwright browser cache is unavailable. Tests use an isolated temporary DSH home and a local fake model, not production conversations or model credentials.

## Six-scene checklist (2026-11-07)

| Scene | Evidence / remaining work |
| --- | --- |
| 1. Twenty warm conversations, 1s each, click-to-first-visible-content p95 <100ms, no repeated snapshots | **Not measured on target hardware.** The synchronous twenty-cache unit check is not browser paint evidence. Need 3 long replies, 2 images, 1 streaming session; frame-level timing, screen recording and decrypted protocol instrumentation/network evidence. Encrypted WS frame counts alone cannot identify snapshot frames. |
| 2. Generate in X, spend 5s in Y, return to X | Real DSH/browser test checks the complete final text occurs once and no streaming row remains. |
| 3. Ten-second network loss, restore | Real browser test sets offline, closes the carrier, waits 10s, restores network, waits for readiness and verifies text once with no error modal or inline error after recovery. Browser transport now uses the existing bounded-backoff recovery, not an explicit re-pair requirement. During reconnect this cache is cleared, so the test does **not** prove uninterrupted offline reading. |
| 4. Seventy visited sessions, revisit evicted first | Real browser test creates 70 distinct durable conversations and visits all, then verifies first-session content and no cross-session text. Unit test additionally asserts the evicted subscription closes and reopening calls follow again. |
| 5. Server change / sign-out clears identity data | Unit test covers clear and stale events; browser test covers a failed re-pair and absence of the former transcript. **Successful change to a second server and actual sign-out/revocation still need dedicated e2e coverage.** A failed pairing is not equivalent to those scenarios. |
| 6. Memory after 64 cached conversations | **Not measured.** Need baseline and loaded browser process/JS heap figures, workload, Chrome/Electron version and target machine specification. No numeric memory budget has been accepted yet. |

Do not merge on this checklist alone: scenes 1, the remaining part of 5, and 6 are still open. If scene 3 requires history to remain visible for the entire outage rather than reload correctly afterwards, the present connection-scoped invalidation policy does not meet that stronger requirement and must be redesigned with an identity-safe reconnect boundary.
