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

| Scene                                                                                                   | Evidence / remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Twenty warm conversations, 1s each, click-to-first-visible-content p95 <100ms, no repeated snapshots | Linux headless Chrome measurement passed: p95 **27ms**, max 38.2ms; session/follow opens **20→20**, snapshot frames **20→20**. Three replies each contain 200 paragraphs, two conversations include a PNG, one is actively streaming. Uses real navigation link click dispatch, visible content layout and two animation frames, not a compositor-present timestamp. Recording and metadata-only loopback mux envelope log captured.                                                                |
| 2. Generate in X, spend 5s in Y, return to X                                                            | Real DSH/browser test checks the complete final text occurs once and no streaming row remains.                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3. Ten-second network loss, restore                                                                     | Real browser test sets offline, closes the carrier, waits 10s, restores network, waits for readiness and verifies text once with no error modal or inline error after recovery. Browser transport now uses the existing bounded-backoff recovery, not an explicit re-pair requirement. During reconnect this cache is cleared, so the test does **not** prove uninterrupted offline reading.                                                                                                        |
| 4. Seventy visited sessions, revisit evicted first                                                      | Real browser test creates 70 distinct durable conversations and visits all, then verifies first-session content and no cross-session text. Unit test additionally asserts the evicted subscription closes and reopening calls follow again.                                                                                                                                                                                                                                                         |
| 5. Server change / sign-out clears identity data                                                        | Real browser case successfully re-pairs the same renderer to a second independent DSH kernel served under a distinct same-origin mount; its conversation loads, then the old server's conversation ID shows no old text. No navigation/reload resets the app. Web same-origin policy remains enforced; this uses test HTTP/WS forwarding, not permission bypass. Failed re-pair and clear/stale-event unit cases also pass. Actual native sign-out/revocation is still a manual check, not claimed. |
| 6. Memory after 64 cached conversations                                                                 | JS heap **13,402,064 bytes (12.8MiB)** vs baseline 6,872,028 bytes (6.6MiB). Browser-reported process set RSS sum **1,053,708KiB (1029MiB)** vs baseline 977,560KiB (955MiB), increase about 74MiB. This sum double-counts shared pages and includes browser/GPU/network/recording overhead; it is not the cache's exclusive allocation or a leak measurement. No forced GC and no accepted memory budget.                                                                                          |

## Metrics reproduction and conditions

```sh
pnpm --filter @swiftnest/app exec playwright install ffmpeg
SWIFTNEST_CACHE_METRICS=1 SWIFTNEST_CACHE_EVIDENCE_DIR=/absolute/path/outside-checkout \
  pnpm exec vitest run client/test/sessionCache.metrics.e2e.test.ts
```

2026-11-07 run: Linux 7.3.0, AMD Ryzen 7 PRO 6850HS, 16 logical CPUs, approximately 30.7GiB RAM; headless Google Chrome 156.0.8078.73, viewport 1280×900. Production-built React client, real DSH kernels and local fake model. Evidence includes `metrics.json`, `protocol-envelopes.json` (envelope types only; no cookies/message bodies), `twenty-session-browser.png`, `server-switch.json` and a WebM recording. This is desktop-browser evidence, not Electron/Android hardware certification. The absence of new snapshot frames is measured directly on the loopback plaintext mux, not inferred from encrypted byte totals.

The metrics case uses a separate explicit opt-in because performance depends on hardware; standard CI browser tests still cover functional cache flows. Scene 5 native sign-out remains unverified. If scene 3 requires history to remain visible for the entire outage rather than reload correctly afterwards, the present connection-scoped invalidation policy does not meet that stronger requirement and must be redesigned with an identity-safe reconnect boundary. Final acceptance/merge belongs to review, not this report.
