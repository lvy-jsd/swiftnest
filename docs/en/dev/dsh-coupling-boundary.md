# Swiftnest and DSH Coupling Inventory & Boundary Design (L2)

> Status: Design proposal (under review, no migration code included).  
> Objective: Systematically catalogue all current coupling points between Swiftnest and DeepSeek Harness (DSH), defining clear boundaries for "out-of-process migration", "in-kernel bridging", and "non-negotiable retention" to lower future upstream upgrade costs.

---

## 1. Context and Core Principles

During previous upgrades (e.g., DSH 0.2.1 to 0.2.2-rc.1), small upstream internal adjustments—such as attachment reference schema, default network permissions, and Node runtime constraints—rippled across multiple business domains. This highlighted that Swiftnest's business capabilities (devices, settings, memory, search, tools) were directly and heterogeneously bound to DSH's internal container context.

However, **decoupling does not mean reinventing wheels, nor does it justify adding arbitrary proxy layers**. The L2 boundary design adheres to three principles:

1. **Own What Is Ours**: Static pages, device hubs, settings stores, and audit logs belong to Swiftnest and should not reside within kernel extensions.
2. **Bridge with Contracts**: Hooks that must execute in-kernel must be consolidated behind a single Anti-Corruption Layer. Live internal references (Cordis `Context`, live `Session`, `Peer`) must never leak to domain logic. Retained hooks must be defended by minimal contract tests.
3. **Never Reinvent Authentication**: Retain DSH's native session admission, signed HttpOnly cookies, and WebSocket multiplexing transport; keep existing native pairing extensions and refuse to build custom login or credential systems.

---

## 2. Complete Coupling Inventory

A comprehensive audit across `server/src/`, `server/bundle/`, and `packages/api/` reveals dependencies across five dimensions:

### 2.1 Context Services & Injected Providers

| Service                 | Locations                                                                                                   | Actual Usage & Semantics                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.webServer`         | `server/bundle/src/core.ts`<br>`server/bundle/src/chat-search.ts`<br>`server/bundle/src/memory.ts`          | Mounts HTTP/WS routes (`/app/` static assets, `/swiftnest/health`, search/memory debug endpoints, device reverse proxies).                         |
| `ctx.connection`        | `server/bundle/src/core.ts`<br>`server/bundle/src/channel.ts`<br>`server/bundle/src/native-pairings.ts`     | Request admission (`connection.admit`), API Peer creation/destruction, client ID extraction, and Host/Origin enforcement.                          |
| `ctx.tools`             | `server/bundle/src/media.ts`<br>`server/bundle/src/native-devices.ts`<br>`server/bundle/src/chat-search.ts` | Dynamic tool registration (`tools.register`), output rendering wrappers (`output.render`), tool visibility and lifecycle management.               |
| `ctx.llm`               | `server/bundle/src/vision.ts`<br>`server/bundle/src/memory/auto.ts`                                         | Calling vision description models and invoking LLMs for automated conversation review.                                                             |
| `ctx.attachments`       | `server/bundle/src/vision.ts`                                                                               | Inspecting photo attachment metadata, validating byte dimensions, and extracting image streams.                                                    |
| `ctx.systemPrompt`      | `server/bundle/src/routing.ts`<br>`server/bundle/src/memory.ts`                                             | Injecting sections into kernel system prompts (`systemPrompt.section`), such as routing guidance and memory snapshots.                             |
| `ctx.on` / `ctx.effect` | `server/bundle/src/*.ts`                                                                                    | Subscribing to lifecycle events and registering cleanup effects on plugin reload or teardown.                                                      |
| `@deepseek-ai/dsh-web`  | `server/bundle/src/web-fetch.ts`                                                                            | Direct type dependency on private upstream packages to register custom safe fetch providers (private network rejection, DNS rebinding mitigation). |

### 2.2 Event Subscriptions vs. Log Discrimination

True event-bus subscriptions must be distinguished from passive stream labels:
- **Active Event-Bus Subscriptions (6 types)**:
  1. `session/created`: Initializing new sessions for memory tracking and search indexing.
  2. `session/event`: Capturing message stream mutations for search index updates and memory extraction.
  3. `session/disposed`: Cleaning up session caches and active tasks upon session teardown.
  4. `tools/pre-execute`: Intercepting tool executions for expert routing approval and risk gating.
  5. `llm/stream`: Intercepting LLM request streams to convert image references into descriptions for text-only models.
  6. `approval/request`: Core interaction prompt requesting owner confirmation for privileged operations.
- **Stream / Log Event Labels (Data Payloads Only)**:
  Labels like `session/title`, `approval/asked`, `turn-end`, and `assistant-stream` are payload fields within the follow protocol, requiring no direct event listeners.

### 2.3 Sessions & Persistence Layer

- `ctx.sessions`:
  - `sessions.list()`: Listing in-memory active session instances.
  - `sessions.flush(session)`: Committing active session frames to disk.
- `ctx.sessionPersistence`:
  - `sessionPersistence.list()`: Listing session headers on disk (IDs, origins).
  - `sessionPersistence.open(id, 'read')` / `read()` / `close()`: Reading historical records sequentially for indexing or catch-up.
  - Physical deletion and pruning semantics are currently tied to DSH storage structures.

### 2.4 Process Management & Configuration Assembly

- `server/src/kernel.ts`: Spawning DSH via CLI, parsing ready lines and tokens, and supervising process exit with parent guards.
- `server/src/profile.ts`: Bundling order orchestration, parsing YAML AST to retain `!!js` tags for persona overrides.
- `server/bundle/cordis.patch.yml`: Statically defining plugin IDs and patch targets.
- `server/src/tool-ultra.ts`: Loading audited Tool Ultra 0.5.0 npm packages and applying patches.

### 2.5 Client Wire RPC Protocol

- `packages/api/src/index.ts`, `events.ts`, `transport.ts`:
  Implementing JSON-RPC framing, `/api/remote.mux` stream multiplexing, and Session Follow frame handling to keep `@swiftnest/api` free from direct runtime DSH imports.

---

## 3. Boundary Categorization & Design

Dependencies are categorized into three distinct strategies:

```
┌────────────────────────────────────────────────────────┐
│             Swiftnest Domain Layer (Parent / UI)       │
│  - Device management & approvals   - Preferences sync  │
│  - Static app (/app) hosting       - Search & memory   │
└─────────────────────────┬──────────────────────────────┘
                          │ Pure DTOs & commands (No Cordis/Session leakage)
┌─────────────────────────▼──────────────────────────────┐
│             Swiftnest Bridge & Adapter Layer           │
│  - KernelAdapter       - SessionBridge                 │
│  - ToolApprovalBridge  - VisionRewriteBridge           │
└─────────────────────────┬──────────────────────────────┘
                          │ In-kernel hooks & data synchronization
┌─────────────────────────▼──────────────────────────────┐
│                 DSH Kernel (Child Process)             │
│  - LLM stream middleware           - Tool execution    │
│  - Native admission & cookies      - WebSocket mux     │
└────────────────────────────────────────────────────────┘
```

### 3.1 Category A: Move Out-of-Process (Pure Swiftnest Logic)

These capabilities belong to Swiftnest and should not depend on `ctx.webServer`:
1. **Static Web Hosting & Health Checks**:
   - `/app/` asset distribution and `/swiftnest/health` should be served directly by the parent process server.
2. **Device Hub & Settings**:
   - The in-kernel `devices.ts` is merely a proxy. The actual Nest, pairing persistence, identity keys, LAN link, and audit logs already run in the parent process. Kernel proxying should be removed in favor of direct communication.
3. **Memory & Search Business Decision Engines**:
   - SQLite vector storage, embedding queries, and extraction heuristics belong in the application domain. The kernel should only receive final context slices via prompt injection.

### 3.2 Category B: Retain and Bridge (Defensive Adaptor with Strict Contracts)

In-kernel hooks cannot be moved out of process and must be encapsulated behind a clean adapter:
1. **Unified Bridge (No Leaked Objects)**:
   - DSH internal objects (`Session`, `Peer`, `Context`) must never leak to domain modules.
   - Domain logic interacts only with clean Swiftnest data models.
2. **SessionBridge Contract**:
   - Wraps `session/created`, `session/event`, and `session/disposed`.
   - Must guarantee strictly monotonic sequences (`seq`), replay catching up, gap retries, task cancellation, and explicit file handle closure.
3. **In-Kernel Execution Hooks**:
   - `tools/pre-execute`: Retained for authorization and approval gating.
   - `llm/stream`: Retained for dynamic image description rewrites.
   - `systemPrompt.section`: Retained for injecting read-only context snippets.
   - `web.registerFetchProvider`: Retained for private network defence.
4. **Contract Testing**:
   - Focused minimal assertions around attachment schemas, approval returns, and tool registration signatures to verify compatibility in seconds.

### 3.3 Category C: Never Reinvent (Authentication & Channels)

**Rebuilding auth or session admission to reduce coupling introduces unjustified complexity and security risks.**
1. **Retain DSH Native Admission**:
   - Continue relying on `connection.admit`, cryptographically signed HttpOnly cookies, and `/api/remote.mux` WebSocket multiplexing.
2. **Retain Native Pairing Extensions**:
   - Swiftnest's `native-pairings` mechanism continues bridging persistent device credentials to temporary API peers.
3. **Maintain Strict Security Guarantees**:
   - Uphold Host/Origin fence boundaries; revoke active connections immediately upon credential revocation.
   - **Never trust unverified incoming HTTP headers** (such as forged `X-User-Id` headers).

---

## 4. Architecture Options and Roadmap

| Dimension               | Option 1: Consolidated Adapters (Recommended) | Option 2: Frontend Proxy in Parent             | Option 3: Full Distributed Services           |
| ----------------------- | --------------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| **Scope**               | Refactor `server/bundle` into clean adapters  | Parent manages port; kernel on loopback        | Separate processes for sessions/search/memory |
| **Port Exposure**       | Single port (managed as today)                | Single port owned by parent process            | Multiple internal RPC sockets                 |
| **Auth & Transport**    | Full reuse of existing cookies and mux        | Requires proxying cookies, TLS, and WebSockets | Reinvents auth or introduces custom tokens    |
| **Implementation Cost** | **Low**, zero network topology changes        | **Medium**, requires proxy testing             | **Prohibitive**, violates core principles     |
| **Upgrade Benefit**     | Isolates changes to adapter boundaries        | Complete ownership of entry routing            | Complete isolation at high architectural debt |

### Recommended Implementation Roadmap

1. **Phase 1 (Current Deliverable)**: Establish this boundary inventory and architectural consensus without committing migration code.
2. **Phase 2**: Implement **Option 1**, consolidating DSH calls inside `server/bundle` behind unified adapter interfaces (`SessionBridge`, `KernelAdapter`) and writing contract tests.
3. **Phase 3 (Optional Evaluation)**: Evaluate Option 2 only if complete ownership of public HTTP ports is deemed necessary by product requirements. Option 3 is rejected.
