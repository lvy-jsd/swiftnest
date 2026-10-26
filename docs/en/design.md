# Swiftnest Design v0.3

> Status: Draft v0.3 (2026-10-22). Decisions from v0.2 are in Section 15; this version incorporates the review from the local model Xiaoyan (小燕) (Swift 1.5, the agent that will live in the Nest), see Section 16.
> In one sentence: **Turn your devices into capabilities that any agent can safely call.**

---

## 1. What It Is, What It Isn't

**Swiftnest is the control plane and execution plane for device capabilities.** It handles: device identity, pairing, multi-link networking, capability registration, permissions, approval, audit, task execution, and resource state.

**It is not a personal assistant, nor is it just an MCP gateway.** Conversation, memory, personality, long-running task orchestration, and IM chat experience are all handled by upper-layer agents. DSH (a first-class citizen), Claude Desktop, Cursor, OpenClaw, and others are all its clients.

### 1.1 Names and Terminology

A swift builds its nest twig by twig; Swiftnest's features are likewise built entirely from plugins.

**Newcomers only need to know three things: server, device, and plugin.**

| External term | Project term | What it is |
|---|---|---|
| Server | **Nest (巢)** | A machine that is always on (or temporarily), responsible for device registration, pairing, permissions, approval, and audit, aggregating all devices' capabilities for agents |
| Device | **Perch (栖点)** | The program running on each controlled device: connects back to the Nest, hosts local capabilities, executes operations |
| Plugin | **Plugin** | The carrier of all functionality |

Advanced terms (only needed when writing plugins): Link (link plugin), Capability (capability plugin, usually an MCP service), Surface (entry-point plugin), Policy / Router / Store / Panel (replaceable default plugins).

### 1.2 Related Open-Source Projects (surveyed 2026-10-21)

| Project | What it is | Relationship |
|---|---|---|
| [OpenClaw](https://github.com/openclaw/openclaw) | TypeScript, MIT, ~390k stars. Gateway + IM channels + skills/plugins (ClawHub) + device nodes (macOS / iOS / watchOS / Android / headless hosts) | Closest project, but it is a full assistant. We build the device layer beneath it; plugins can connect Swiftnest devices to it |
| [OpenZiti mcp-gateway](https://github.com/openziti/mcp-gateway) | Go, Apache-2.0. Zero-trust network publishing of MCP services, NAT traversal, aggregation, per-tool filtering | Closest in spirit to "link + aggregation"; worth borrowing from; heavier architecture |
| MetaMCP, IBM ContextForge, Docker MCP Gateway, Obot | MCP aggregation gateways | Lean single-machine/enterprise; ContextForge's mDNS federation is worth referencing |
| [Cua](https://github.com/trycua/cua) Driver, agent-computer-use | Desktop operation MCP; and its allowlist/audit proxy | Desktop capability plugins plug in directly; permission model aligns |
| droidrun, mobile-mcp, etc. | Android control | Phone capability plugins |
| MeshCentral, RustDesk | Mature self-hosted remote management (non-AI) | Device management, pairing, NAT traversal experience |
| Headscale | Open-source self-hosted implementation of the Tailscale control plane | Primary networking solution |

## 2. Design Principles

1. **Everything is a plugin, but it works out of the box**: Anything replaceable is a plugin, and each type has a stable default implementation; newcomers don't need to know "the router is also a plugin."
2. **Use what exists before writing your own**: Device capabilities prefer connecting to existing MCP services with zero-code wrapping.
3. **Secure by default, and not dependent on model judgment**: Pairing, fine-grained permissions, approval, local confirmation, audit; sensitive operations are always decided by rules and humans, not by agents.
4. **Agent-friendly**: Few, precise tools; small, structured results; long tasks are async; errors are recoverable.
5. **Multiple interaction modes**: Web, DSH, CLI, IM, phone push, OpenAI-compatible API, MCP endpoint—entry points are also plugins.
6. **Newcomer-friendly**: First run only needs Node.js and a LAN; one-command install, scan a QR code or enter a 6-digit code to pair, errors tell you how to fix them.
7. **No lock-in, self-hosted**: DSH is a first-class citizen but not required; no dependency on any official service that requires login; data stays in your hands.
8. **Chinese and English treated equally.**

## 3. Overall Architecture

```
         Agents / Humans (Surface plugins)
  DSH · Claude Desktop · Cursor · OpenClaw · Web Panel · CLI · IM · Phone Push · OpenAI-compatible API
                              │  MCP endpoint (tools: <device>__<capability>__<tool>)
        ┌────────────────────────────────────────────────────────────┐
        │                        Nest (巢)                           │
        │ Core: plugin host · bus · config · identity · capability   │
        │       registry · permission proxy · audit · task state     │
        │ Default plugins: router · policy · store · panel · link ·  │
        │       surface                                              │
        └──┬───────────────────┬──────────────────┬──────────────────┘
   Link plugins │ LAN              │ Public relay       │ Headscale (later: BLE)
        ┌───────────┐     ┌───────────────┐     ┌───────────────┐
        │ Perch     │     │ Perch         │     │ Perch         │
        │ Laptop    │     │ Inference host│     │ Phone (later) │
        │ Cap.      │     │ Browser ·     │     │ Notify ·      │
        │ plugins   │     │ Email ·       │     │ Approve       │
        │ Cmd ·     │     │ Search · GPU  │     │ → Capabilities│
        │ Files     │     └───────────────┘     └───────────────┘
        └───────────┘
```

- Nest and Perch are **the same core with different default plugin combinations**; a single machine can be both (the inference host is).
- **Three deployment modes**:
  - **Persistent Nest**: A 24/7 machine serves as the Nest (recommended).
  - **Temporary Nest**: Any machine temporarily acts as the Nest, shut down when done.
  - **Nestless mode**: A single device's Perch exposes an MCP endpoint directly on the local machine—ideal for a first try.
- **When the Nest is offline**: Perches cache events and approval requests, syncing after the Nest recovers; already-authorized local operations continue as normal.

## 4. Core (the Non-Replaceable Part)

| Module | Responsibility |
|---|---|
| Plugin host | Discover, validate, start, stop, and restart plugins; run them at the appropriate isolation level (see 5.4) |
| Message bus | Request/response, events, streams; transparent across links; backpressure and per-device concurrency limits |
| Config | Each plugin's config has a Schema (auto-generates forms, validation, defaults); supports hot reload; **secrets stored separately** (see 7.6) |
| Identity | Device identity (Ed25519); client identity; users; task IDs (see 7.1) |
| Capability registry | See 4.1 |
| Permission proxy | All tool calls must pass through it; three-layer permission check (see 7.3); plugins cannot bypass it |
| Audit | Append-only audit log recording "who (client/agent) on which device used which tool, with what parameters, and what the result was"; plugins cannot modify it |
| Task state machine | See 4.2 |

The goal is not "how many lines" but that **every module is independently testable, has stable interfaces, and is versioned**.

### 4.1 Capability Registration and Tool Naming
- When a Perch comes online, it reports its capability manifest: each capability has a stable ID, version, tool Schema, required permissions, health status, and a check result for required system permissions.
- The Nest aggregates these into MCP tools, named **`<device>__<capability>__<tool>`**, e.g. `laptop__shell__run`, `box__email__list`. Device names are unique; conflicts require renaming. (LLM APIs don't allow dots in function names, so double underscores separate the parts; UIs may display `laptop.shell.run`)
- Events are emitted when devices go online/offline, capabilities are added/removed, or upgraded; the MCP endpoint sends `tools/list_changed`; clients that don't support it get a clear error and refresh hint on the next call.
- When a system permission is not granted (e.g. screen recording, accessibility), the tool is still listed but marked unavailable; calling it returns "which permission is missing and how to enable it."

### 4.2 Task Lifecycle
`Submit → Queue → (Awaiting approval) → Execute (streamable output) → Complete / Failed / Timed out / Cancelled`, with a `task_id` throughout and audit at every step.
- Calls that require approval or have long runtimes immediately return `pending` + `task_id`; the agent can continue with other work and retrieve results via `swiftnest.task.status` / `wait` / `cancel` tools or by subscribing to events.
- Timeouts auto-cancel; cancellation propagates to the Perch, terminating the corresponding process.
- For MCP clients that don't support async, the Nest blocks and waits within a bounded time; on timeout it returns `pending` and a query method (degradation strategy).

### 4.3 Results and Large Data
- Tool results are structured by default with a size cap; overflow is stored as a **temporary artifact**, returning a summary + artifact ID for on-demand chunked reads.
- Screenshots, screen recordings, and files use chunked and compressed transfer, not stuffed into regular messages.
- Unified error format: `code`, `message`, `suggestion` (how to fix), `retryable`.
- All content from the external world (web pages, emails, files, search results) carries an "untrusted" marker, reminding the agent not to treat text within as instructions.

## 5. Plugin System

### 5.1 Types

| Type | Runs on | Default / Examples |
|---|---|---|
| `capability` | Perch | shell, files, desktop-niri, browser (Playwright MCP), email, search, gpu-task; or any MCP service |
| `link` | Both ends | lan (default), relay, headscale; later ble |
| `surface` | Nest | mcp-endpoint (default), web-panel, dsh, cli, openai-api (box_task), ntfy, im |
| `policy` | Both ends | Default three-layer permission policy; time windows, budgets, domain/path/command allowlists |
| `router` | Nest | Default: prefer specified device, fall back to capability match when target unavailable, then fall back to Nest's local machine |
| `store` | Nest | Default sqlite (Node built-in `node:sqlite`) |
| `panel` | Nest | Add pages or cards to the web panel |

### 5.2 Manifest (the `swiftnest` field in package.json)

```jsonc
{
  "name": "swiftnest-plugin-desktop-niri",
  "swiftnest": {
    "apiVersion": 1,
    "kind": "capability",
    "runsOn": "perch",
    "platforms": ["linux"],
    "entry": "./dist/index.js",
    "permissions": ["screen.read", "input.write"],
    "systemPermissions": ["wayland.screencopy"],
    "dependsOn": ["swiftnest-plugin-files@^1"],
    "config": "./dist/config.schema.json",
    "secrets": ["apiKey"],
    "displayName": { "zh": "niri 桌面控制", "en": "niri desktop control" }
  }
}
```

### 5.3 Zero-Code Integration of Existing MCP Services

```jsonc
{
  "name": "swiftnest-plugin-browser",
  "swiftnest": {
    "apiVersion": 1, "kind": "capability", "runsOn": "perch",
    "mcp": { "npm": "@playwright/mcp", "args": ["--caps", "vision"], "transport": "stdio" },
    "permissions": ["network.public", "browser.control"]
  }
}
```

The CLI wizard `swiftnest plugin add-mcp` asks in sequence: source (npm / uvx / Docker / binary), package name or command, arguments, which permissions are needed, whether public network is allowed, then automatically lists its tools, generates the manifest, and runs a health check.

### 5.4 Isolation Levels

| Level | Applies to | Method |
|---|---|---|
| Built-in trusted | Official core plugins (default router, policy, store) | Same process or worker thread, saving resources (friendly to phones and low-spec devices) |
| Community plugins | Third-party plugins | Separate child process; only gets declared permissions; filesystem read-only by default except declared directories; no public network by default |
| MCP services | Wrapped existing MCP | Child process; Perch handles unified health checks, restarts, and resource limits; on Linux, optional bubblewrap / systemd transient units for stronger isolation |

### 5.5 Plugin Ecosystem
- Publishing: npm packages, must include the `swiftnest` manifest field.
- Directory: The docs site periodically scans npm and generates a plugin directory page: type, platform, permissions, dependencies, version, update time, examples.
- Installation: Displays the permission manifest; on upgrade, shows **permission changes** (what new permissions are required compared to the old version), requiring confirmation.
- Integrity: Locked dependency versions; checksum verification; official plugins are signed.
- Developer experience: `npm create swiftnest-plugin@latest` → `npm run dev` (hot reload against a local playground) → `npm test` (SDK includes a simulated Nest and simulated devices) → `npm publish`.

## 6. Links

| Link plugin | Phase | Description |
|---|---|---|
| **link-lan** | M1 | mDNS discovery + WebSocket; zero-config on the same LAN |
| **link-relay** | M1.5 | Perch initiates outbound connection to the Nest's public entry (e.g. Cloudflare tunnel), NAT traversal; **disabled by default**, mandatory mutual authentication when enabled |
| **link-headscale** | M3 | Nest one-click deploys a self-hosted Headscale; pairing issues a one-time pre-auth key; Perch joins using the open-source Tailscale client; automatic direct connection / hole punching / relay |
| link-ble | Later | Close-range, offline emergency; only carries control commands and small data |

- Automatic routing: switches by priority and health checks; the panel shows the current link.
- All links carry the same encrypted messages with mutual identity-key authentication, independent of whether the link itself is encrypted.
- The public entry opens only one port (reverse tunnel); the panel, MCP endpoint, and Headscale control plane are **authenticated separately**; Headscale pre-auth keys are one-time.

## 7. Security Model

### 7.1 Identity
- **Devices**: One Ed25519 key pair each for Nest / Perch.
- **Clients**: Each connected agent (DSH, Claude Desktop, Cursor, OpenClaw, …) is registered, authorized, and revocable individually.
- **Users**: Panel login (local account when running standalone; Cloudflare Access etc. in front when public).
- **Tasks**: One `task_id` per call. Audit records by "client × device × tool × parameters."

### 7.2 Pairing
- The Nest generates a one-time pairing code (QR code or 6-digit code, valid for 5 minutes, bound to device model and timestamp, replay-protected).
- After public key exchange, both sides display a **short fingerprint** (4 groups of 4 digits); pairing completes only when the user confirms they match.
- **Offline pairing file** is also supported (when there is no camera or not on the same network).
- **Key rotation and recovery**: Periodic rotation; one-click rotation on compromise; re-pair after device reset; encrypted key backup.

### 7.3 Three-Layer Permissions

| Layer | Examples |
|---|---|
| Capability level | `screen.read`, `input.write`, `files.write`, `network.public` |
| Tool level | `shell.run`, `files.delete`, `browser.open`, `email.send` |
| Parameter-level policy | Path allowlist (only `~/projects/**`), command allowlist (`ls`, `cat`, `df`), domain allowlist, recipient allowlist, amount cap |

Each item is set to "allow / ask / deny." Defaults: read operations allowed, write operations ask, execution and sensitive operations ask and require local confirmation, `shell.run` defaults to allowing only allowlisted read-only commands.

### 7.4 Approval
- Approval requests include: client, device, tool, **original parameters** (not a model summary), parameter hash, risk level, nonce, expiry.
- Pushed to all entry points; approval at any one is sufficient; approval results are signed, replay-protected; timeout defaults to deny.
- Sensitive operations require "Nest approval + device-local confirmation"; local confirmation is triggered by the Perch core; plugins cannot forge or skip it.

### 7.5 Prompt Injection
- Don't trust the model: sensitive operations are gated only by permissions and approval.
- External content read carries an "untrusted" marker; browser, email, and file-reading tools cannot by default trigger write operations as a side effect.
- Outbound messages, deletions, payments, and install commands all require secondary confirmation.

### 7.6 Secrets and Supply Chain
- Secrets (API keys, IM tokens, email passwords) are stored encrypted separately, only handed to plugins that declare them; other plugins and agents cannot access them.
- Community plugins have permissions, network, and file access tightened per declaration; dependencies locked; checksums verified.

### 7.7 Disconnection and Audit
- One-click revocation of a device or client from the panel; devices also have a local "disconnect now"; after revocation, keys are invalidated.
- Audit is append-only, can include screenshot snapshots, and is exportable.

## 8. Interaction Modes (Surface Plugins)

| Entry | Phase | Description |
|---|---|---|
| MCP endpoint | M0 | Any MCP client can use it directly |
| CLI / Wizard | M1 | `swiftnest init / pair / doctor / plugin add-mcp / playground` |
| DSH plugin | M1.5 | Panel embedded in DSH; tools given to Xiaoyan; approval via DSH native approval cards |
| Web panel | M1.5 (minimal) → M2 | Devices, pairing, permissions, approval, audit, link status; can "add to home screen" |
| OpenAI-compatible API | M4 | Regular API works on the caller's local machine; `box_task` delegates to the Nest to open a one-shot sandbox (the inference host already has a prototype `swift-auto`) |
| Phone push / approval | M5 | Self-hosted ntfy |
| IM | M5 | WeChat / QQ / Feishu / Telegram (can reuse dsh-bridge) |
| Voice | Later | — |

## 9. Agent-Friendly (from Xiaoyan's Requirements)

- **On-demand tool loading**: By default, only commonly used tools and a "search tools by device/capability" meta-tool are given to the agent; specific device capabilities are loaded on demand.
- **Tool descriptions are short and precise**, high-frequency ones first.
- **Results are small and structured**; large content goes through artifacts + summaries; screenshots include a text summary alongside (the local model can see images, but summaries save context).
- **Long tasks and approvals are async**, not interrupting the agent's flow.
- **Resource priority**: When the Nest and Perch are on the same machine (e.g. the inference host), model inference takes priority; browser, search, and similar tasks have resource caps; GPU tasks queue; under high load, non-critical tasks are degraded.
- **Does not store agent memory**: Swiftnest only stores devices, capabilities, permissions, audit, and task records; conversation and memory belong to the agent itself.

## 10. Newcomer-Friendly

- **First run only needs**: Node.js 24 + two machines on the same LAN (or one machine in nestless mode). Docker, Headscale, public network, IM are all optional.
- **Install**: `npx swiftnest@latest init`, asks "should this be the server or a device," auto-configures and sets up auto-start.
- **Pairing**: Scan QR code, or enter a 6-digit code, then verify fingerprint; no camera? Use the offline pairing file.
- **`swiftnest doctor`**: Checks links, permissions, plugins, and system permissions item by item; each issue gets a one-line fix.
- **`swiftnest playground`**: Simulates a server and three devices on one machine; play and develop without real hardware.
- **Errors**: All explain "what's wrong, why, and how to fix it," with doc links.
- **Docs**: Chinese and English treated equally; "5-minute quickstart," "10 minutes to write your first plugin"; one minimal example per plugin type.
- **Bilingual maintenance**: Local model first draft + human proofreading + CI check for doc sync (alerts if only one language was updated).

## 11. Technology Choices

| Aspect | Choice |
|---|---|
| Language / Runtime | TypeScript, Node.js 24 (built-in `node:sqlite`, WebSocket client, minimal native dependencies) |
| Repository | pnpm monorepo |
| Schema | zod → JSON Schema |
| Protocol | Capability layer: MCP; Control layer: proprietary lightweight messaging (events, approvals, tasks, artifacts) with version negotiation |
| Crypto | @noble (Ed25519 / X25519), pure JS |
| Networking | LAN WebSocket; public reverse relay; self-hosted Headscale + open-source Tailscale client |
| Packaging | npm, Node single-file executable (SEA), Docker, Nix flake / NixOS module |
| UI / i18n | Web panel + i18n (zh / en) |
| Docs | VitePress, bilingual (zh / en) |
| Testing | Vitest; SDK includes simulated Nest / simulated devices |
| License | Apache-2.0 |

## 12. Repository Structure

```
swiftnest/
├─ packages/
│  ├─ core/          Core: plugin host, bus, config, identity, capability registry, permission proxy, audit, task state machine
│  ├─ protocol/      Messaging and version negotiation (zod)
│  ├─ nest/          Server: default plugin combination + entry point
│  ├─ perch/         Device: default plugin combination + entry point (includes nestless mode)
│  ├─ sdk/           Plugin development kit + simulated Nest / simulated devices
│  ├─ cli/           swiftnest CLI and wizards
│  ├─ web/           Web panel (standalone or embedded in DSH)
│  └─ dsh-plugin/    dsh-plugin-swiftnest
├─ plugins/          Official plugins (same status as community plugins)
│  ├─ link-lan/  link-relay/  link-headscale/
│  ├─ cap-shell/  cap-files/  cap-mcp/ (generic MCP wrapper)  cap-desktop-niri/  cap-browser/  cap-email/  cap-search/
│  ├─ surface-mcp/  surface-web/  surface-openai/  surface-ntfy/
│  └─ policy-default/  router-default/  store-sqlite/
├─ templates/        Plugin templates
├─ examples/
├─ docs/             zh/  en/
└─ nix/
```

## 13. Relationship to Existing Deployments (Inference Host Migration)

| Current | After migration | Phase |
|---|---|---|
| agent-mcp.nix browser / email / search MCP | Inference host Perch's cap-browser / cap-email / cap-search | M4 |
| swift-auto + dsh-task-runner | surface-openai plugin | M4 |
| DSH on dsh-box | Install dsh-plugin-swiftnest | M1.5 |
| The device's connector / MCP relay / mcp-niri / mcp-shell | Concepts and code rewritten into link-relay / cap-desktop-niri / cap-shell | M1–M5 |
| swift-agent | Retired after functionality is covered | After M4 |

Switch services one by one; no big-bang migration.

## 14. Roadmap

| Milestone | Content | Acceptance |
|---|---|---|
| **M0 Skeleton** ✅ | Repository, core (minimal registry, permission proxy, audit, task state machine), protocol, SDK, plugin templates, simulated Nest/devices, cap-shell, MCP endpoint, playground, docs site skeleton (zh/en) | MCP client in simulated environment calls `sim__shell__run("echo ok")` successfully with audit record; template-generated plugin tests pass |
| **M1 First Connection** ✅ (see §17) | Standalone Nest + one LAN Perch; link-lan; cap-shell, cap-files; CLI pairing (code + fingerprint); **minimal security**: tool allowlist, default ask, timeout and cancel, audit, permission declarations, one-click disconnect | Claude Desktop connects to Nest, calls `laptop__shell__run("echo ok")`; `rm`-type commands are intercepted and require confirmation; audit is queryable; 30-second timeout can cancel |
| **M1.5 DSH and Public Network** | dsh-plugin-swiftnest, link-relay (default off), approval entry, minimal web panel | Have Xiaoyan operate the laptop via DSH; laptop leaves LAN and reconnects via relay |
| **M2 Full Security** | Three-layer permissions + parameter policies, signed approvals, local confirmation, key rotation and recovery, client identity, revocation, secret storage | Sensitive operations require phone/panel approval AND device-local confirmation; revocation takes effect immediately |
| **M3 Networking** | link-headscale (Nest one-click deploy), automatic routing | Laptop on external network auto-connects via Headscale |
| **M4 Migrate Inference Host** | cap-browser / cap-email / cap-search, inference host Perch, surface-openai | Inference host's existing capabilities run as plugins; old services retired one by one |
| **M5 Desktop and Notifications** | cap-desktop-niri, ntfy push, IM entry; **phone does approval / notifications first** | Approve Xiaoyan's operations on the laptop desktop from a phone while away |
| **M6 Open-Source Release v0.1** | Install script, doctor, playground, zh/en docs, contribution guide, plugin directory | New user completes "server + one device" within 15 minutes following docs |
| Later | Full Android Perch, link-ble, capability marketplace page, voice | — |

## 15. Decision Log

| # | Question | Decision | Date |
|---|---|---|---|
| — | Language | TypeScript (Node.js 24) | 2026-10-21 |
| — | Networking | Self-hosted Headscale, no official service requiring login | 2026-10-21 |
| — | Bluetooth | Not urgent, deferred to after M6 | 2026-10-21 |
| — | Repository | New repository, open source | 2026-10-21 |
| 0 | Positioning | Device network beneath the assistant (device capability control plane + execution plane), complementary to OpenClaw | 2026-10-22 |
| 1 | License | Apache-2.0 | 2026-10-22 |
| 2 | Docs and UI language | Chinese and English treated equally | 2026-10-22 |
| 3 | Standalone Nest | Included in M1 | 2026-10-22 |
| 4 | Hosting | GitHub personal account | 2026-10-22 |

## 16. Review Log

### 2026-10-22 Xiaoyan (local Swift 1.5, reviewed v0.2 with high reasoning effort)

**Adopted**: Repositioned as "device capability control plane + execution plane"; core split into non-replaceable core + replaceable default plugins, removed the "2000 lines" target; added capability registration and tool naming, task lifecycle, large data transfer, backpressure, offline queue, plugin dependencies, secret management, system permission detection, MCP client degradation; security refined to three-layer permissions + parameter policies, pairing fingerprints, key rotation, signed approvals, local confirmation triggered by core, plugin supply chain, Headscale exposure surface, four identity types, prompt injection; newcomers only remember "server / device / plugin," M1 only needs Node + LAN, 6-digit code + offline pairing, `plugin add-mcp` wizard, nestless / temporary Nest / Nest-offline modes; roadmap split out M1.5, minimal security in M1, M4 narrowed, phone does approval first; agent-perspective on-demand loading, small results, async approvals, resource priority, no memory storage.

**Not adopted**:
- "M1 Chinese only, add English before release": The initiator already decided on equal zh/en; switched to "local model first draft + human proofreading + CI sync check" to reduce cost (Xiaoyan translated this document v0.2 in 2 minutes).
- "If the model can't see images, add OCR": Swift 1.5 can see images directly; kept "screenshots with text summaries" to save context.

## 17. M1 implementation notes (2026-10-22)

**What was built**

| Part | Where | Notes |
|---|---|---|
| Encrypted session | `core/src/channel.ts` | Shared by every link. Two plaintext handshake messages (each with the Ed25519 identity key, an ephemeral X25519 key and a nonce) give the transcript hash `th`; HKDF-SHA-256 derives one AES-256-GCM key per direction; the first ciphertext each way is an identity signature over `role ‖ th`. Every frame then carries an 8-byte counter as its nonce, strictly increasing; a tampered, replayed or reordered frame closes the session. Node's built-in crypto only. |
| Pairing | `core/src/pairing.ts`, `remote.ts` | One-time 6-digit code (5 minutes, single use, dropped after 5 wrong tries); the device sends `HMAC(code, th)`; each side confirms the other's fingerprint, and the first "no" ends it. Paired devices live in `devices.json` (mode 600, atomic writes). |
| Remote devices | `core/src/remote.ts` | On the Nest a remote device is an ordinary `PerchConnection`, so tasks, policy, approvals and audit are unchanged; every message is validated against the protocol schema; running tasks fail with `DEVICE_OFFLINE` when the device drops. New `nest.revoke()`. |
| LAN link | `plugins/link-lan` | Two dependencies, `ws` and `multicast-dns`. The Nest listens on 7711 and allows 16 unauthenticated handshakes at once; refusals reach the device as error codes (`NOT_PAIRED`…), which decide between "retrying cannot help" and "reconnect later"; reconnects back off exponentially (1 → 30 s); when mDNS finds nothing the last address that worked is dialled. |
| Files capability | `plugins/cap-files` | list/read/stat/write/mkdir/move/delete; shared folders (home by default) + a real-path check (no symlink escapes) + an always-refused list of secret locations (Swiftnest's own keys included). |
| Command line | `packages/cli` | `nest`, `perch`, `pair`, `devices`, `revoke`, `pending`, `approve`, `deny`, `audit`. The Nest opens a mode-600 Unix socket for the local owner, so it can run headless; approvals and pairing confirmations in a terminal share one prompt queue. Chinese and English. |

**Acceptance** (`scripts/acceptance-m1.mjs`, separate processes and real sockets, all 14 checks pass): pairing code and fingerprint; a device refuses a Nest with the wrong fingerprint; online after both confirm; an MCP client sees `laptop__shell__run` and gets the `echo ok` output; `rm -rf` waits for approval, `swiftnest pending` shows the raw arguments and the risk, `swiftnest deny` refuses it; an approved 30-second command is cancelled while running and its process on the device is really gone; the audit log is complete; after revoke the device exits, deletes its pairing and cannot reconnect. Plus 61 unit and integration tests (the mDNS test skips itself on this machine because of the firewall).

**Different from the plan**

- Acceptance used the MCP SDK client over HTTP, not Claude Desktop itself; Claude Desktop reaches the HTTP endpoint through `mcp-remote` (the docs give the config). A direct `swiftnest mcp` stdio bridge moves to M1.5.
- mDNS was not exercised on the development machine: NixOS's default firewall drops UDP 5353. The code has a test that skips itself where multicast cannot work; the docs explain `--nest` instead.
- Pairing codes are not bound to a device model and timestamp: the proof is bound to the session's transcript hash, which is what prevents replay.

**Left for M1.5 / M2**: policy reason strings are English only; approvals are not signed and there is no local confirmation on the device (M2); key rotation and recovery (M2); the `swiftnest mcp` stdio bridge; the web panel.
