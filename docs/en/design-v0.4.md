# Swiftnest Design v0.4 — The Agent Mesh

> Status: Draft v0.4 (2026-10-26). Builds on v0.3 (device capability control plane). This version incorporates the new goal: **give unlimited agents active communication — messaging, file transfer, task delegation — no matter where they are or what network they are on, through multiple channels, mainly in Rust and TS.**
>
> In one sentence: **v0.3 turns your devices into capabilities agents can call; v0.4 turns your agents into peers that talk to each other.**

---

## 1. The Shift

v0.3 is a **star topology**: every device (Perch) connects to a central Nest, and communication is **agent → device** (an agent calls a tool on a device). The Nest is the hub.

The new goal is a **mesh**: agents talk to **each other** actively — send messages, transfer files, delegate tasks — no matter where they are. This is **agent ↔ agent**, not agent → device.

**The decision: keep the device layer, add the mesh layer.**

- The device capability layer (Nest / Perch / Plugin, the encrypted channel, pairing, policy, audit) is built and works. It stays.
- A new **mesh layer** is added on top: each machine that runs an agent becomes a **node** in a peer-to-peer mesh. Nodes connect to each other directly (or via a relay), and agents on different nodes can message, transfer files, and delegate tasks.
- A node can be **both** a Nest (hub for its local devices) **and** a mesh peer (connected to other nodes). The inference host is both.

```
   v0.3 (star)                          v0.4 (mesh + star)

   Agent ──→ Nest ──→ Perch            Agent A ─┐
   (call tool)  (hub)   (device)        Agent B ─┼─ mesh (libp2p) ─┼→ Agent C
                                                Agent C ─┘           │
                                                each node also hosts │
                                                its own Perch (device)
```

The two layers are orthogonal:
- **Control plane** (v0.3, TS): agent → device. "Call `laptop__shell__run`."
- **Communication plane** (v0.4, Rust): agent ↔ agent. "Send a message / file / task to agent B."

## 2. What a Node Is

A **node** is the unit of the mesh. It is a machine running an agent (a DSH Bot, a Claude Desktop instance, a headless worker, …). A node:

1. Runs a **Rust mesh core** (a sidecar process): the libp2p node, transports, NAT traversal, relay, file transfer, encryption.
2. Runs the **TS core** (`@swiftnest/core`): the Nest/Perch/Plugin device capability layer.
3. The TS core talks to the Rust core over a **local Unix socket** (the proven sidecar pattern from dsh-tool-manager).
4. Hosts local devices (Perch) as capabilities, and exposes an MCP surface so agents can call tools.
5. Can send messages, transfer files, and delegate tasks to other nodes in the mesh.

A node's identity is an **Ed25519 key pair** (the same scheme v0.3 already uses for devices). The public key is the node's address in the mesh; the fingerprint is what a human compares when pairing two nodes.

## 3. The Rust Mesh Core

A new package, `packages/mesh` (Rust, published as `swiftnest-mesh`), is the heart of v0.4. It is a **sidecar**: the TS layer spawns it, talks to it over a local Unix socket (line-delimited JSON, the same convention as the dsh-tool-manager sidecar), and it owns all the heavy networking.

### 3.1 Why Rust

- **libp2p (rust-libp2p)** is the production-grade P2P stack: multiple transports (TCP, QUIC, WebSocket, WebRTC, WebTransport), native roaming (a connection follows a peer as it moves between networks), protocol muxing, encrypted by default (Noise / TLS 1.3), and **built-in NAT traversal** (hole punching, AutoNAT, relay). This is exactly the "no matter what network they are on, through multiple channels" requirement.
- **quinn** (Rust QUIC) gives fast, reliable, multiplexed transport; libp2p's QUIC transport uses it.
- Rust gives the memory safety and concurrency the mesh needs for many simultaneous streams (file transfers, messages) without a GC pause.

### 3.2 Responsibilities

| Module | Responsibility |
|---|---|
| Node | libp2p node: identity (Ed25519), listen addresses, peer store |
| Transports | QUIC (default), TCP, WebSocket, WebRTC; automatic selection by environment |
| NAT traversal | Hole punching, AutoNAT (who can reach whom), relay fallback |
| Relay | Connect through a relay peer when direct connection fails; the relay is a node that runs the relay role |
| Encryption | Noise (libp2p default) on the transport; the v0.3 Ed25519+X25519+AES-GCM channel is reused for the app-level session between two nodes |
| Messaging | Agent ↔ agent messages: text, structured JSON, events; ordered, reliable per stream |
| File transfer | Chunked, resumable, with per-chunk checksums; a file is a named artifact with a content hash |
| Task delegation | Send a task to another node's agent; track its state; retrieve the result |
| Discovery | A2A agent cards: each node advertises the agents it hosts and their capabilities |

### 3.3 The Socket Protocol (TS ↔ Rust)

Line-delimited JSON over a local Unix socket (mode 600, owner only), the same convention as the dsh-tool-manager sidecar. The TS side sends one command per line and gets one response per line, in order. After `subscribe`, the same connection also carries events; an event line has an `event` key and a response does not.

```
TS → Rust:  {"cmd":"status"}
Rust → TS:  {"ok":true,"peer_id":"12D3Koo…","addrs":["/ip4/127.0.0.1/tcp/30001","/ip4/127.0.0.1/udp/30000/quic-v1"],"peers":[]}
TS → Rust:  {"cmd":"dial","addr":"/ip4/10.0.0.5/tcp/30001/p2p/12D3Koo…"}
TS → Rust:  {"cmd":"subscribe"}
TS → Rust:  {"cmd":"send_message","to":"<peer-id>","text":"hello"}
Rust → TS:  {"event":"message","from":"<peer-id>","text":"hi","ts":1761800000000}
TS → Rust:  {"cmd":"send_file","to":"<peer-id>","path":"/tmp/x.bin"}
Rust → TS:  {"event":"file_sent","peer_id":"<peer-id>","transfer_id":"…","ok":true,"note":"file saved to …"}
TS → Rust:  {"cmd":"delegate_task","to":"<peer-id>","task":"echo:hi"}
Rust → TS:  {"ok":true,"request_id":4,"task_id":"task-…"}
Rust → TS:  {"event":"task_result","peer_id":"<peer-id>","task_id":"task-…","ok":true,"result":"hi"}
```

Commands: `status`, `list_peers`, `list_transfers`, `dial`, `send_message`, `send_file`, `delegate_task`, `subscribe`. Events: `peer_connected`, `peer_disconnected`, `message`, `file_received`, `file_sent`, `task_result`, `request_failed`.

**The sender is the authenticated libp2p peer.** The `from` / `to` fields inside a mesh request are whatever the sender wrote and are never used for a decision: trust (`MESH_TRUSTED_PEERS`), events and logs all use the peer id the transport authenticated. File names must be a single path component, and a transfer id must equal the hash both sides derive from (name, size, sha256), because both become file names under the inbound directory.

The Rust core owns the libp2p event loop; the TS layer never touches the network directly. If the Rust core dies, the TS layer sees the socket close and can restart it (the sidecar pattern already handles parent-process monitoring).

## 4. The Communication Plane (Agent ↔ Agent)

On top of the mesh, the communication plane gives agents three primitives:

1. **Message**: send a text or structured message to an agent on another node. Reliable, ordered per (sender, receiver) pair.
2. **File**: transfer a file to an agent on another node. Chunked, resumable, content-hashed. The receiver gets an artifact ID and can read it in chunks.
3. **Task**: delegate a task to an agent on another node. The task is executed by the remote agent (which may call its own device capabilities); the sender tracks its state and retrieves the result.

These are exposed to agents as **MCP tools** on the local node's MCP surface:

- `mesh.list_peers()` — the nodes and agents currently reachable.
- `mesh.send_message(peer, agent, body)` — send a message.
- `mesh.send_file(peer, agent, path)` — transfer a file.
- `mesh.delegate_task(peer, agent, task)` — delegate a task; returns a task ID.
- `mesh.task_status(task_id)` / `mesh.task_wait(task_id)` / `mesh.task_cancel(task_id)` — track a delegated task.
- `mesh.receive()` — poll for incoming messages/files/tasks (or subscribe to events).

An agent on node A can thus call `mesh.send_message("node-b", "bot-2", "…")` and the message arrives at the agent on node B, no matter where node B is.

## 5. Discovery: A2A Agent Cards

**A2A (Agent2Agent)** is the open standard (originated by Google, donated to the Linux Foundation) for agent interoperability: agents advertise **agent cards** (their capabilities, endpoints, skills) and discover each other. We adopt A2A as the discovery and collaboration layer:

- Each node advertises an **agent card** for each agent it hosts (name, description, capabilities, the mesh address to reach it).
- When two nodes connect, they exchange agent cards; each agent learns what the other node's agents can do.
- Task delegation uses the A2A task model (a task has a state: submitted → working → completed / failed).

This means Swiftnest agents are interoperable with any other A2A agent (LangGraph, CrewAI, Google ADK, …), not just other Swiftnest agents.

## 6. Links and Channels (Multiple Ways to Reach a Peer)

The mesh tries channels in priority order, exactly as v0.3's link plugins do:

| Channel | When it works | Transport |
|---|---|---|
| **Direct (LAN)** | Both nodes on the same network | QUIC / TCP, hole-punched |
| **Direct (WAN)** | Both nodes reachable (port open, or hole punch succeeds) | QUIC |
| **Relay** | Direct fails (symmetric NAT, firewall) | Through a relay node |
| **Headscale** | Both nodes on the same Tailscale network | QUIC over the Tailscale subnet |

The Rust core handles all of this transparently: it tries direct, falls back to relay, and (in M3) uses Headscale. The TS layer and the agents never see the difference — a message is a message, a file is a file, regardless of which channel carried it.

The v0.3 link plugins (link-lan, link-relay, link-headscale) become **the device layer's** links (Perch → Nest). The mesh layer has its own channel logic in Rust. They share the same identity and pairing model.

## 7. Security

The mesh reuses v0.3's security model, extended to nodes:

- **Identity**: each node has an Ed25519 key pair; the public key is its mesh address.
- **Pairing**: two nodes pair by comparing fingerprints (the same 4×4-digit scheme as device pairing). A node can also be **pre-paired** (pinned key) for headless setups.
- **Encryption**: Noise on the transport (libp2p default); the v0.3 AES-256-GCM app-level session between two nodes.
- **Permissions**: the same three-layer permission model (capability / tool / parameter) applies to mesh operations. Sending a message is low-risk; transferring a file to a path is medium-risk; delegating a task that runs `shell.run` is high-risk and requires approval.
- **Audit**: every mesh operation (message, file, task) is recorded in the same append-only audit log.
- **Revocation**: a node can be revoked; its key is invalidated and it drops out of the mesh.

## 8. Technology Choices (v0.4 additions)

| Aspect | Choice | Why |
|---|---|---|
| Mesh language | Rust | libp2p, quinn, Noise are first-class in Rust; memory safety for many streams |
| P2P stack | rust-libp2p | Transports, NAT traversal, relay, roaming, multiplexing — the whole "any network, multiple channels" requirement |
| Transport | QUIC (quinn) default, TCP/WebSocket/WebRTC fallback | Fast, reliable, multiplexed; works in browsers and on mobile |
| Encryption | Noise (transport) + Ed25519/X25519/AES-GCM (app) | libp2p default + the proven v0.3 scheme |
| Discovery | A2A agent cards | The open standard for agent interoperability |
| TS ↔ Rust | Local Unix socket, line-delimited JSON | The proven sidecar pattern from dsh-tool-manager |
| Relay | A node running the relay role (self-hosted) | No dependency on a third-party service; any node can be a relay |

## 9. Repository Structure (v0.4 additions)

```
swiftnest/
├─ packages/
│  ├─ core/          (TS, existing) Nest/Perch/Plugin device capability layer
│  ├─ protocol/      (TS, existing) messaging and version negotiation
│  ├─ mesh/          (Rust, NEW) the mesh core: libp2p node, transports, NAT, relay,
│  │                  file transfer, messaging, task delegation, A2A discovery
│  │  ├─ src/
│  │  ├─ Cargo.toml
│  │  └─ (built to a single binary, spawned as a sidecar by the TS layer)
│  ├─ sdk/           (TS, existing) plugin development kit
│  ├─ cli/           (TS, existing) swiftnest CLI (gains mesh commands)
│  └─ dsh-plugin/    (TS) dsh-plugin-swiftnest (gains mesh tools)
├─ plugins/
│  ├─ link-lan/  link-relay/  link-headscale/   (device layer links, existing)
│  ├─ cap-shell/  cap-files/  …                  (device capabilities, existing)
│  ├─ surface-mcp/                            (gains mesh.* tools)
│  └─ mesh-surface/      (NEW, TS) the mesh surface: exposes mesh.* MCP tools,
│                        bridges the TS core to the Rust mesh core over the socket
└─ docs/
```

## 10. Roadmap (v0.4)

The v0.3 roadmap (M0–M6) is kept for the device layer. The mesh layer gets its own milestones, interleaved:

| Milestone | Content | Acceptance |
|---|---|---|
| **M0** ✅ | Device core (v0.3) | (as before) |
| **M1** ✅ | Device first connection (v0.3) | (as before) |
| **M1.5** | Device: DSH plugin + public relay. **Mesh: foundation** — the Rust `mesh` package builds, a libp2p node with QUIC+TCP, two nodes on a LAN connect directly, exchange agent cards, send a text message over the socket | Two nodes on a LAN: agent A sends a message to agent B; B receives it; the audit log records it |
| **M2** | Device: full security. **Mesh: NAT traversal + relay + file transfer** — hole punching, AutoNAT, relay fallback; chunked resumable file transfer; task delegation | Two nodes on different networks (one behind NAT) exchange a message and a 10 MB file through the relay; a delegated task runs on the remote node and returns its result |
| **M3** | Device: Headscale. **Mesh: Headscale channel + A2A interop** — the mesh uses the Tailscale subnet as a channel; Swiftnest agents interoperate with external A2A agents | A node on the Tailscale network reaches another node directly; a Swiftnest agent delegates a task to an external A2A agent |
| **M4** | Migrate inference host (device layer) | (as before) |
| **M5** | Desktop + notifications (device layer). **Mesh: mobile node** — a node on a phone joins the mesh over WebRTC | A phone node receives messages and files while on cellular |
| **M6** | Open-source release v0.1 (device + mesh) | A new user sets up two nodes and gets agent-to-agent messaging working within 15 minutes |

## 11. Relationship to Existing Code

| Existing (v0.3) | In v0.4 |
|---|---|
| `core` (TS): Nest/Perch/Plugin, channel, pairing, policy, audit | **Kept unchanged.** It is the device capability layer. |
| `protocol` (TS) | **Kept.** Gains mesh message types. |
| `link-lan` / `link-relay` / `link-headscale` | **Kept** as the device layer's links (Perch → Nest). The mesh has its own channels in Rust. |
| `cap-shell` / `cap-files` | **Kept.** Device capabilities. |
| `surface-mcp` | **Extended** with `mesh.*` tools. |
| `cli` | **Extended** with mesh commands (`swiftnest mesh peers / send / sendfile / delegate`). |
| — | **New**: `packages/mesh` (Rust), `plugins/mesh-surface` (TS). |

Nothing in the existing device layer is rewritten. The mesh is a new layer that reuses the identity, pairing, and audit model.

## 12. Open Questions

1. **Relay hosting**: Should the default relay be a public service (operated by the project) or must every user self-host one? Leaning: self-hosted by default (any node can be a relay), with an optional public relay for convenience.
2. **A2A depth**: How much of A2A to implement in M2? Leaning: agent cards + task delegation (the core), streaming and push notifications later.
3. **The TS ↔ Rust boundary**: Should the TS layer be able to run without the Rust core (device-only mode, no mesh)? Leaning: yes — the mesh is optional; a node without the Rust core is a v0.3 Nest/Perch.
4. **Mobile**: WebRTC in the Rust core for mobile nodes (M5) — needs a browser or a native mobile runtime. Leaning: defer to M5, use a headless browser or a native wrapper.

## 13. Decision Log (v0.4)

| # | Question | Decision | Date |
|---|---|---|---|
| 5 | New goal | Add an agent-to-agent communication mesh on top of the device capability layer; keep the device layer | 2026-10-26 |
| 6 | Mesh language | Rust (libp2p, quinn, Noise), as a sidecar to the TS layer | 2026-10-26 |
| 7 | P2P stack | rust-libp2p (transports, NAT traversal, relay, roaming) | 2026-10-26 |
| 8 | Discovery | A2A agent cards (the open standard for agent interoperability) | 2026-10-26 |
| 9 | TS ↔ Rust | Local Unix socket, line-delimited JSON (the dsh-tool-manager sidecar pattern) | 2026-10-26 |
| 10 | Device layer | Kept unchanged; the mesh reuses its identity, pairing, and audit model | 2026-10-26 |