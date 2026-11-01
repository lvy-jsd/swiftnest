//! The mesh node: a libp2p swarm that listens, dials, and exchanges messages and files.
//!
//! The node runs its event loop in a background task. Commands arrive over an mpsc channel
//! (from the Unix socket server) and are answered with a [`CmdResponse`] over a per-command
//! oneshot channel.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use futures::StreamExt;
use libp2p::{
    autonat, dcutr, identify, identity, multiaddr::Protocol, relay, request_response,
    swarm::StreamProtocol, Multiaddr, PeerId, Swarm, SwarmBuilder,
};
use libp2p::request_response::OutboundRequestId;
use libp2p::swarm::behaviour::toggle::Toggle;
use libp2p::swarm::NetworkBehaviour;
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::{
    now_ms, transfer_id, base64, codec,
    task_policy::{CheckedTask, TaskPolicy},
    pairing::{write_private, PairCheck, PairingWindow, PeerBook},
    CmdResponse, Command, MeshEvent, PeerInfo, Request, Response, TransferInfo, PROTOCOL,
};
use base64::Engine;

/// The raw byte size of each file chunk (1 MiB). Base64-encoded it is ~1.33 MiB, well under the
/// 16 MiB codec limit.
const CHUNK_SIZE: u64 = 1024 * 1024;

/// A file transfer being received. The partial file lives at `path` (in the `.partial` dir).
struct InboundTransfer {
    name: String,
    size: u64,
    sha256: String,
    next_seq: u64,
    /// Bytes written to the partial file so far. Never allowed to pass `size`.
    received: u64,
    path: PathBuf,
}

/// The state of a file transfer being sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SendState {
    WaitingStartAck,
    WaitingChunkAck,
    WaitingEndAck,
    Done,
    /// A request of this transfer could not be delivered; `send_file` again to resume.
    Failed,
}

/// A file transfer being sent.
struct OutboundTransfer {
    path: PathBuf,
    name: String,
    size: u64,
    /// The file's sha256, kept so a transfer can be resumed after a restart even if the
    /// receiver's partial file is gone (the transfer id is derived from it).
    #[allow(dead_code)]
    sha256: String,
    next_seq: u64,
    state: SendState,
}

/// The mesh swarm behaviour: request-response (messages, files, tasks) + relay (so nodes can
/// reach each other through a relay when a direct connection is not possible) + autonat (NAT
/// status detection) + identify (peer info exchange) + dcutr (direct-connection upgrade through
/// relay, for NAT hole punching).
#[derive(NetworkBehaviour)]
pub struct MeshBehaviour {
    rr: request_response::Behaviour<codec::JsonCodec<Request, Response>>,
    /// Off unless the owner asks: a relay lets any peer spend this node's bandwidth.
    relay: Toggle<relay::Behaviour>,
    relay_client: relay::client::Behaviour,
    autonat: autonat::Behaviour,
    identify: identify::Behaviour,
    dcutr: dcutr::Behaviour,
}

impl MeshBehaviour {
    /// Build the behaviour for a node with the given identity.
    pub fn new(
        local_peer_id: PeerId,
        local_public_key: libp2p::identity::PublicKey,
        relay_client: relay::client::Behaviour,
        relay_server: bool,
    ) -> Self {
        let protocol = StreamProtocol::new(PROTOCOL);
        Self {
            rr: request_response::Behaviour::with_codec(
                codec::JsonCodec::default(),
                [(
                    protocol,
                    request_response::ProtocolSupport::Full,
                )],
                request_response::Config::default(),
            ),
            relay: relay_server
                .then(|| relay::Behaviour::new(local_peer_id, relay::Config::default()))
                .into(),
            relay_client,
            autonat: autonat::Behaviour::new(local_peer_id, autonat::Config::default()),
            identify: identify::Behaviour::new(identify::Config::new(
                "swiftnest/0.1.0".to_string(),
                local_public_key,
            )),
            dcutr: dcutr::Behaviour::new(local_peer_id),
        }
    }
}

type MeshSwarm = Swarm<MeshBehaviour>;

/// A command paired with the channel its response is sent on.
pub struct CommandEnvelope {
    pub cmd: Command,
    pub reply: oneshot::Sender<CmdResponse>,
}

/// A libp2p mesh node.
pub struct MeshNode {
    swarm: MeshSwarm,
    local_peer_id: PeerId,
    /// Directory where received files are written.
    inbound_dir: PathBuf,
    /// In-progress file transfers being received, keyed by transfer id.
    inbound: HashMap<String, InboundTransfer>,
    /// In-progress file transfers being sent, keyed by transfer id.
    outbound: HashMap<String, OutboundTransfer>,
    /// The peer address we are trying to reach. Re-dialed periodically if the connection drops.
    dial_target: Option<Multiaddr>,
    /// The execution boundary for delegated tasks (see [`task_policy`]).
    task_policy: TaskPolicy,
    /// Where [`MeshEvent`]s go; socket clients subscribe to it.
    events: broadcast::Sender<MeshEvent>,
    /// Outbound file requests in flight, so a delivery failure marks the right transfer.
    file_requests: HashMap<OutboundRequestId, String>,
    /// Outbound task requests in flight (request -> task id), so a refusal or a delivery failure
    /// reaches the caller as that task's result instead of silence.
    task_requests: HashMap<OutboundRequestId, String>,
    /// Outbound pairing requests in flight.
    pending_pairs: HashMap<OutboundRequestId, PeerId>,
    /// The peers this node talks to. Everyone else is refused.
    book: PeerBook,
    /// An open invitation, if the owner started one.
    window: Option<PairingWindow>,
    /// This node's own label, sent when pairing.
    name: String,
}

/// Everything a node needs besides its keys.
pub struct NodeConfig {
    /// Where received files go.
    pub inbound_dir: PathBuf,
    /// What delegated tasks may do.
    pub task_policy: TaskPolicy,
    /// Where the node keeps its identity key and paired peers. `None` keeps both in memory only
    /// (tests): the peer id then changes on every start and nobody stays paired.
    pub state_dir: Option<PathBuf>,
    /// This node's label, sent to peers it pairs with.
    pub name: String,
    /// Act as a relay for other peers.
    pub relay_server: bool,
}

impl NodeConfig {
    pub fn new(inbound_dir: PathBuf, task_policy: TaskPolicy) -> Self {
        Self { inbound_dir, task_policy, state_dir: None, name: "node".into(), relay_server: false }
    }
}

impl MeshNode {
    /// Build a node (not listening yet; call [`Self::listen`] to start listening).
    pub fn new(inbound_dir: PathBuf, task_policy: TaskPolicy) -> anyhow::Result<Self> {
        Self::with_config(NodeConfig::new(inbound_dir, task_policy))
    }

    /// Build a node from a full configuration.
    pub fn with_config(cfg: NodeConfig) -> anyhow::Result<Self> {
        let NodeConfig { inbound_dir, task_policy, state_dir, name, relay_server } = cfg;
        let identity_key = match &state_dir {
            Some(dir) => load_or_create_identity(&dir.join("identity.key"))?,
            None => identity::Keypair::generate_ed25519(),
        };
        let book = PeerBook::load(state_dir.as_ref().map(|d| d.join("peers.json")))?;
        let local_peer_id = PeerId::from(identity_key.public());

        let swarm = SwarmBuilder::with_existing_identity(identity_key)
            .with_tokio()
            .with_tcp(
                Default::default(),
                libp2p::noise::Config::new,
                libp2p::yamux::Config::default,
            )?
            .with_quic()
            .with_relay_client(
                libp2p::noise::Config::new,
                libp2p::yamux::Config::default,
            )?
            .with_behaviour(|kp, relay_client| {
                let pid = PeerId::from(kp.public());
                MeshBehaviour::new(pid, kp.public(), relay_client, relay_server)
            })?
            .with_swarm_config(|cfg| cfg)
            .build();

        // Partial files live in a subdirectory so they don't collide with finalized files.
        let partial_dir = inbound_dir.join(".partial");
        std::fs::create_dir_all(&partial_dir)?;

        Ok(Self {
            swarm,
            local_peer_id,
            inbound_dir,
            inbound: HashMap::new(),
            outbound: HashMap::new(),
            dial_target: None,
            task_policy,
            events: broadcast::channel(256).0,
            file_requests: HashMap::new(),
            task_requests: HashMap::new(),
            pending_pairs: HashMap::new(),
            book,
            window: None,
            name,
        })
    }

    /// Start listening on the given ports.
    pub fn listen(&mut self, tcp: u16, quic: u16) -> anyhow::Result<()> {
        let tcp_addr = listen_addr(tcp);
        self.swarm.listen_on(tcp_addr.clone())?;
        println!("listening on {tcp_addr}");
        let quic_addr = quic_listen_addr(quic);
        self.swarm.listen_on(quic_addr.clone())?;
        println!("listening on {quic_addr}");
        Ok(())
    }

    /// Listen on an additional multiaddr (e.g. a relayed address, which triggers a relay
    /// reservation).
    pub fn listen_on(&mut self, addr: Multiaddr) -> anyhow::Result<()> {
        self.swarm.listen_on(addr.clone())?;
        Ok(())
    }

    /// Dial a peer at the given multiaddr.
    ///
    /// Also records the peer's address in the swarm's address book so that `send_request` can
    /// reach the peer (it dials using known addresses).
    pub fn dial(&mut self, addr: Multiaddr) -> anyhow::Result<()> {
        if let Some(peer_id) = peer_id_from_addr(&addr) {
            self.swarm.add_peer_address(peer_id, addr.clone());
        }
        self.swarm.dial(addr.clone())?;
        // Remember the target so the event loop can re-dial if the connection drops.
        self.dial_target = Some(addr);
        Ok(())
    }

    /// The node's own peer id.
    pub fn local_peer_id(&self) -> PeerId {
        self.local_peer_id
    }

    /// A sender the socket server uses to hand each client its own event receiver.
    pub fn events(&self) -> broadcast::Sender<MeshEvent> {
        self.events.clone()
    }

    /// The addresses the swarm is listening on right now.
    pub fn listen_addrs(&self) -> Vec<String> {
        self.swarm.listeners().map(|a| a.to_string()).collect()
    }

    /// Add a peer to the paired peers (no code involved) and announce it.
    pub fn trust(&mut self, peer: PeerId, name: &str) -> anyhow::Result<()> {
        self.book.add(&peer, name)?;
        self.emit(MeshEvent::Paired { peer_id: peer.to_string(), name: name.to_string() });
        Ok(())
    }

    /// Parse a peer id and check that the peer is paired; the error is the text for the caller.
    fn paired_peer(&self, to: &str) -> Result<PeerId, String> {
        let peer = to.parse::<PeerId>().map_err(|e| format!("invalid peer id {to}: {e}"))?;
        if self.book.contains(&peer) {
            Ok(peer)
        } else {
            Err(format!("peer {to} is not paired; pair with it first"))
        }
    }

    fn emit(&self, event: MeshEvent) {
        // No subscriber is fine: the event is only for whoever is listening.
        let _ = self.events.send(event);
    }

    /// Currently connected peers.
    pub fn connected_peers(&self) -> Vec<PeerInfo> {
        self.swarm
            .connected_peers()
            .map(|p| PeerInfo {
                peer_id: p.to_string(),
                connected: true,
            })
            .collect()
    }

    /// Send a text message to a peer. Returns the outbound request id.
    pub fn send_message(&mut self, to: &PeerId, text: &str) -> u64 {
        let req = Request::Message {
            from: self.local_peer_id.to_string(),
            to: to.to_string(),
            text: text.to_string(),
            ts: now_ms(),
        };
        self.send_request(to, req)
    }

    /// Start (or resume) a chunked file transfer to a peer. Reads the file from `path`, computes its
    /// sha256, and sends a `FileStart`. The event loop then drives the chunked send (see
    /// [`Self::send_next_chunk`]). Returns the outbound request id.
    pub fn send_file(&mut self, to: &PeerId, path: &str) -> anyhow::Result<u64> {
        let file_path = PathBuf::from(path);
        let data = std::fs::read(&file_path)?;
        let name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let size = data.len() as u64;
        let file_sha256 = sha256_hex(&data);
        let tid = transfer_id(&name, size, &file_sha256);

        // If a transfer for this file is already in progress, resume it (re-send FileStart to get
        // the receiver's latest next_seq). If it's done, start fresh is a no-op.
        if let Some(t) = self.outbound.get_mut(&tid) {
            if t.state == SendState::Done {
                // Already sent; nothing to do. Return a dummy id.
                return Ok(0);
            }
            t.state = SendState::WaitingStartAck;
        } else {
            self.outbound.insert(
                tid.clone(),
                OutboundTransfer {
                    path: file_path,
                    name: name.clone(),
                    size,
                    sha256: file_sha256.clone(),
                    next_seq: 0,
                    state: SendState::WaitingStartAck,
                },
            );
        }

        let req = Request::FileStart {
            from: self.local_peer_id.to_string(),
            to: to.to_string(),
            transfer_id: tid.clone(),
            name: name.clone(),
            size,
            sha256: file_sha256.clone(),
            chunk_size: CHUNK_SIZE,
            ts: now_ms(),
        };
        Ok(self.send_file_request(to, &tid, req))
    }

    /// Send a file-transfer request and remember which transfer it belongs to.
    fn send_file_request(&mut self, to: &PeerId, tid: &str, req: Request) -> u64 {
        let id = self.swarm.behaviour_mut().rr.send_request(to, req);
        self.file_requests.insert(id, tid.to_string());
        id.to_string().parse().unwrap_or(0)
    }

    /// Send the next chunk of an outbound transfer (or the `FileEnd` if all chunks are sent).
    /// Called from the event loop when a `FileStartAck` / `FileChunkAck` arrives.
    fn send_next_chunk(&mut self, to: &PeerId, tid: &str) {
        // Decide what to send and copy out the fields we need, so the mutable borrow of the
        // transfer ends before we call `send_request` (which also borrows `self`).
        let (req, next_state, log) = {
            let Some(t) = self.outbound.get_mut(tid) else {
                return;
            };
            if t.next_seq * CHUNK_SIZE >= t.size {
                // All chunks sent; send FileEnd.
                let req = Request::FileEnd {
                    from: self.local_peer_id.to_string(),
                    to: to.to_string(),
                    transfer_id: tid.to_string(),
                    ts: now_ms(),
                };
                (
                    req,
                    SendState::WaitingEndAck,
                    format!("file {tid}: all {} bytes sent, waiting for end ack", t.size),
                )
            } else {
                // Read and send the next chunk.
                let offset = t.next_seq * CHUNK_SIZE;
                let len = std::cmp::min(CHUNK_SIZE, t.size - offset) as usize;
                let seq = t.next_seq;
                let path = t.path.clone();
                match read_chunk(&path, offset, len) {
                    Ok(data) => {
                        let req = Request::FileChunk {
                            from: self.local_peer_id.to_string(),
                            to: to.to_string(),
                            transfer_id: tid.to_string(),
                            seq,
                            data_b64: base64::engine::general_purpose::STANDARD.encode(&data),
                            ts: now_ms(),
                        };
                        (
                            req,
                            SendState::WaitingChunkAck,
                            format!("file {tid}: sending chunk {seq} ({} bytes)", data.len()),
                        )
                    }
                    Err(e) => {
                        println!("file {tid}: failed to read chunk {seq}: {e}");
                        return;
                    }
                }
            }
        };
        let req_id = self.send_file_request(to, tid, req);
        println!("{log} (req {req_id})");
        if let Some(t) = self.outbound.get_mut(tid) {
            t.state = next_state;
        }
    }

    /// List in-progress file transfers (sending and receiving).
    pub fn list_transfers(&self) -> Vec<TransferInfo> {
        let mut out = Vec::new();
        for (tid, t) in &self.outbound {
            if t.state != SendState::Done {
                out.push(TransferInfo {
                    transfer_id: tid.clone(),
                    name: t.name.clone(),
                    size: t.size,
                    done: t.next_seq.saturating_sub(1) * CHUNK_SIZE
                        + if t.next_seq > 0 && t.next_seq * CHUNK_SIZE <= t.size {
                            std::cmp::min(CHUNK_SIZE, t.size - (t.next_seq - 1) * CHUNK_SIZE)
                        } else {
                            0
                        },
                    direction: "sending".to_string(),
                });
            }
        }
        for (tid, t) in &self.inbound {
            let done = std::fs::metadata(&t.path).map(|m| m.len()).unwrap_or(0);
            out.push(TransferInfo {
                transfer_id: tid.clone(),
                name: t.name.clone(),
                size: t.size,
                done,
                direction: "receiving".to_string(),
            });
        }
        out
    }

    /// Delegate a task to a peer. Returns the outbound request id and the task id.
    pub fn send_task(&mut self, to: &PeerId, task: &str) -> (u64, String) {
        let task_id = format!("task-{}-{:08x}", now_ms(), rand::random::<u32>());
        let req = Request::Task {
            from: self.local_peer_id.to_string(),
            to: to.to_string(),
            task_id: task_id.clone(),
            task: task.to_string(),
            ts: now_ms(),
        };
        let id = self.swarm.behaviour_mut().rr.send_request(to, req);
        self.task_requests.insert(id, task_id.clone());
        (id.to_string().parse().unwrap_or(0), task_id)
    }

    /// Send a request to a peer. Returns the outbound request id.
    fn send_request(&mut self, to: &PeerId, req: Request) -> u64 {
        let req_id = self.swarm.behaviour_mut().rr.send_request(to, req);
        req_id.to_string().parse().unwrap_or(0)
    }

    /// Run the event loop, processing swarm events and commands until the command channel
    /// is closed.
    pub async fn run(&mut self, mut cmd_rx: mpsc::Receiver<CommandEnvelope>) {
        // Periodically re-dial the target peer if the connection is not up.
        let mut redial = tokio::time::interval(std::time::Duration::from_secs(5));
        redial.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = redial.tick() => {
                    if let Some(addr) = self.dial_target.clone() {
                        if let Some(peer_id) = peer_id_from_addr(&addr) {
                            if !self.swarm.is_connected(&peer_id) {
                                println!("re-dialing {addr}");
                                let _ = self.swarm.dial(addr.clone());
                            }
                        }
                    }
                }
                event = self.swarm.next() => {
                    match event {
                        Some(libp2p::swarm::SwarmEvent::ConnectionEstablished { peer_id, .. }) => {
                            println!("connection established with {peer_id}");
                            self.emit(MeshEvent::PeerConnected { peer_id: peer_id.to_string() });
                        }
                        Some(libp2p::swarm::SwarmEvent::ConnectionClosed { peer_id, num_established: 0, .. }) => {
                            println!("connection closed with {peer_id}");
                            self.emit(MeshEvent::PeerDisconnected { peer_id: peer_id.to_string() });
                        }
                        Some(libp2p::swarm::SwarmEvent::NewListenAddr { address, .. }) => {
                            println!("new listen addr {address}");
                        }
                        Some(libp2p::swarm::SwarmEvent::IncomingConnection { local_addr, .. }) => {
                            println!("incoming connection from {local_addr}");
                        }
                        Some(libp2p::swarm::SwarmEvent::Behaviour(event)) => {
                            match event {
                                MeshBehaviourEvent::Rr(rr_event) => self.handle_rr_event(rr_event),
                                MeshBehaviourEvent::Relay(relay_event) => {
                                    self.handle_relay_event(relay_event)
                                }
                                MeshBehaviourEvent::RelayClient(client_event) => {
                                    self.handle_relay_client_event(client_event)
                                }
                                MeshBehaviourEvent::Autonat(autonat_event) => {
                                    self.handle_autonat_event(autonat_event)
                                }
                                MeshBehaviourEvent::Identify(id_event) => {
                                    // Log identify events to debug relay discovery.
                                    match &id_event {
                                        identify::Event::Received { peer_id, info, .. } => {
                                            println!(
                                                "identify: received from {peer_id} protocols={:?}",
                                                info.protocols
                                            )
                                        }
                                        other => tracing::debug!("identify event: {other:?}"),
                                    }
                                }
                                MeshBehaviourEvent::Dcutr(dcutr_event) => {
                                    self.handle_dcutr_event(dcutr_event)
                                }
                            }
                        }
                        Some(other) => tracing::debug!("{other:?}"),
                        None => break,
                    }
                }
                envelope = cmd_rx.recv() => {
                    match envelope {
                        Some(env) => {
                            let resp = self.handle_command(env.cmd);
                            let _ = env.reply.send(resp);
                        }
                        None => break,
                    }
                }
            }
        }
    }

    /// Handle a request-response event: acknowledge incoming messages and files.
    fn handle_rr_event(&mut self, event: request_response::Event<Request, Response>) {
        match event {
            request_response::Event::Message {
                peer,
                message: request_response::Message::Request { request, channel, .. },
                ..
            } => {
                let resp = self.handle_inbound_request(peer, request);
                match self.swarm.behaviour_mut().rr.send_response(channel, resp) {
                    Ok(()) => println!("sent response to {peer}"),
                    Err(unsent) => println!("failed to send response to {peer}: {unsent:?}"),
                }
            }
            request_response::Event::Message {
                peer,
                message: request_response::Message::Response { request_id, response },
                ..
            } => {
                let file_tid = self.file_requests.remove(&request_id);
                let task_id_for_request = self.task_requests.remove(&request_id);
                let pending_pair = self.pending_pairs.remove(&request_id);
                match response {
                    Response::Denied { reason, .. } => {
                        println!("{peer} refused our request: {reason}");
                        if let Some(tid) = file_tid {
                            // The transfer cannot go on; leave it resumable and tell the caller why.
                            if let Some(t) = self.outbound.get_mut(&tid) {
                                t.state = SendState::Failed;
                            }
                            self.emit(MeshEvent::FileSent {
                                peer_id: peer.to_string(),
                                transfer_id: tid,
                                ok: false,
                                note: format!("refused by peer: {reason}"),
                            });
                        }
                        if let Some(task_id) = task_id_for_request {
                            self.emit(MeshEvent::TaskResult {
                                peer_id: peer.to_string(),
                                task_id,
                                ok: false,
                                result: format!("refused by peer: {reason}"),
                            });
                        }
                        self.emit(MeshEvent::RequestFailed {
                            peer_id: peer.to_string(),
                            error: format!("refused by peer: {reason}"),
                        });
                    }
                    Response::PairAck { ok, name, note, .. } => {
                        // Only an answer to a pairing request we actually sent counts.
                        if pending_pair == Some(peer) {
                            if ok {
                                let name = clean_label(&name);
                                match self.trust(peer, &name) {
                                    Ok(()) => println!("paired with {peer} ({name})"),
                                    Err(e) => self.emit(MeshEvent::PairFailed {
                                        peer_id: peer.to_string(),
                                        note: format!("could not save the pairing: {e}"),
                                    }),
                                }
                            } else {
                                self.emit(MeshEvent::PairFailed { peer_id: peer.to_string(), note });
                            }
                        }
                    }
                    Response::Ack { ok, note, .. } => {
                        println!("received ack from {peer}: ok={} note=\"{}\"", ok, note);
                    }
                    Response::TaskResult {
                        task_id, ok, result, ..
                    } => {
                        println!(
                            "received task result from {peer}: task={task_id} ok={} \"{}\"",
                            ok,
                            result
                                .chars()
                                .take(200)
                                .collect::<String>()
                        );
                        self.emit(MeshEvent::TaskResult {
                            peer_id: peer.to_string(),
                            task_id,
                            ok,
                            result,
                        });
                    }
                    Response::FileStartAck {
                        transfer_id,
                        next_seq,
                        ok,
                        note,
                        ..
                    } => {
                        println!(
                            "file {transfer_id}: start ack from {peer} ok={} next_seq={next_seq} \"{}\"",
                            ok, note
                        );
                        if ok {
                            if let Some(t) = self.outbound.get_mut(&transfer_id) {
                                if t.state == SendState::WaitingStartAck {
                                    t.next_seq = next_seq;
                                    self.send_next_chunk(&peer, &transfer_id);
                                }
                            }
                        } else {
                            if let Some(t) = self.outbound.get_mut(&transfer_id) {
                                t.state = SendState::Done;
                            }
                            self.emit(MeshEvent::FileSent {
                                peer_id: peer.to_string(),
                                transfer_id,
                                ok: false,
                                note,
                            });
                        }
                    }
                    Response::FileChunkAck {
                        transfer_id, seq, ok, ..
                    } => {
                        if ok {
                            if let Some(t) = self.outbound.get_mut(&transfer_id) {
                                if t.state == SendState::WaitingChunkAck && seq >= t.next_seq {
                                    t.next_seq = seq + 1;
                                    self.send_next_chunk(&peer, &transfer_id);
                                }
                            }
                        } else {
                            println!("file {transfer_id}: chunk {seq} rejected by {peer}");
                            if let Some(t) = self.outbound.get_mut(&transfer_id) {
                                t.state = SendState::Done;
                            }
                            self.emit(MeshEvent::FileSent {
                                peer_id: peer.to_string(),
                                transfer_id,
                                ok: false,
                                note: format!("chunk {seq} rejected"),
                            });
                        }
                    }
                    Response::FileEndAck {
                        transfer_id, ok, note, ..
                    } => {
                        println!(
                            "file {transfer_id}: end ack from {peer} ok={} \"{}\"",
                            ok, note
                        );
                        if let Some(t) = self.outbound.get_mut(&transfer_id) {
                            t.state = SendState::Done;
                        }
                        self.emit(MeshEvent::FileSent {
                            peer_id: peer.to_string(),
                            transfer_id,
                            ok,
                            note,
                        });
                    }
                }
            }
            request_response::Event::OutboundFailure { peer, request_id, error, .. } => {
                println!("outbound request to {peer} failed: {error}");
                // A transfer whose request never arrived is stuck; mark it so the caller can
                // `send_file` again to resume from where the receiver got to.
                if let Some(tid) = self.file_requests.remove(&request_id) {
                    if let Some(t) = self.outbound.get_mut(&tid) {
                        t.state = SendState::Failed;
                    }
                    self.emit(MeshEvent::FileSent {
                        peer_id: peer.to_string(),
                        transfer_id: tid,
                        ok: false,
                        note: format!("delivery failed: {error}"),
                    });
                }
                if let Some(task_id) = self.task_requests.remove(&request_id) {
                    self.emit(MeshEvent::TaskResult {
                        peer_id: peer.to_string(),
                        task_id,
                        ok: false,
                        result: format!("delivery failed: {error}"),
                    });
                }
                if let Some(p) = self.pending_pairs.remove(&request_id) {
                    self.emit(MeshEvent::PairFailed {
                        peer_id: p.to_string(),
                        note: format!("could not reach the peer: {error}"),
                    });
                }
                self.emit(MeshEvent::RequestFailed {
                    peer_id: peer.to_string(),
                    error: error.to_string(),
                });
            }
            request_response::Event::InboundFailure { peer, error, .. } => {
                println!("inbound request from {peer} failed: {error}");
            }
            request_response::Event::ResponseSent { peer, .. } => {
                println!("response sent to {peer}");
            }
        }
    }

    /// Handle a relay event: log reservation and circuit establishment so we can see when a
    /// node is acting as a relay and when peers connect through it.
    fn handle_relay_event(&mut self, event: relay::Event) {
        match event {
            relay::Event::ReservationReqAccepted { src_peer_id, .. } => {
                println!("relay: reservation request accepted from {src_peer_id}");
            }
            relay::Event::ReservationReqDenied { src_peer_id } => {
                println!("relay: reservation request denied from {src_peer_id}");
            }
            relay::Event::CircuitReqAccepted { src_peer_id, dst_peer_id } => {
                println!("relay: circuit request accepted {src_peer_id} -> {dst_peer_id}");
            }
            relay::Event::CircuitReqDenied { src_peer_id, dst_peer_id } => {
                println!("relay: circuit request denied {src_peer_id} -> {dst_peer_id}");
            }
            relay::Event::CircuitClosed { src_peer_id, dst_peer_id, .. } => {
                println!("relay: circuit closed {src_peer_id} -> {dst_peer_id}");
            }
            other => tracing::debug!("relay event: {other:?}"),
        }
    }

    /// Handle a relay client event: log when this node makes a reservation on a relay and when
    /// it opens a circuit through a relay to reach another peer.
    fn handle_relay_client_event(&mut self, event: relay::client::Event) {
        match event {
            relay::client::Event::ReservationReqAccepted {
                relay_peer_id, renewal, ..
            } => {
                println!(
                    "relay-client: reservation accepted on {relay_peer_id} (renewal={renewal})"
                );
            }
            relay::client::Event::OutboundCircuitEstablished { relay_peer_id, .. } => {
                println!("relay-client: outbound circuit established via {relay_peer_id}");
            }
            relay::client::Event::InboundCircuitEstablished { src_peer_id, .. } => {
                println!("relay-client: inbound circuit established from {src_peer_id}");
            }
        }
    }

    /// Handle an autonat event: log NAT status changes so we can see whether this node is
    /// reachable directly or needs a relay.
    fn handle_autonat_event(&mut self, event: autonat::Event) {
        match event {
            autonat::Event::StatusChanged { old, new } => {
                println!("autonat: NAT status changed {old:?} -> {new:?}");
                if let Some(addr) = self.swarm.behaviour().autonat.public_address() {
                    println!("autonat: public address {addr}");
                }
            }
            other => tracing::debug!("autonat event: {other:?}"),
        }
    }

    /// Handle a dcutr event: log when a direct connection is established through a relay
    /// (NAT hole punching succeeded).
    fn handle_dcutr_event(&mut self, event: dcutr::Event) {
        match event.result {
            Ok(_) => {
                println!(
                    "dcutr: direct connection established with {}",
                    event.remote_peer_id
                )
            }
            Err(e) => {
                println!(
                    "dcutr: hole-punch failed with {}: {e}",
                    event.remote_peer_id
                )
            }
        }
    }

    /// Process an inbound request (message, file, or task). Returns the response to send back.
    ///
    /// `peer` is the libp2p-authenticated sender. The `from` field inside a request is whatever
    /// the sender wrote, so it is never used to decide anything.
    fn handle_inbound_request(&mut self, peer: PeerId, request: Request) -> Response {
        // Only a pairing request may come from a peer we do not know.
        if !matches!(request, Request::Pair { .. }) && !self.book.contains(&peer) {
            println!("refused a request from unpaired peer {peer}");
            return Response::Denied { reason: "not paired".to_string(), ts: now_ms() };
        }
        let from = peer.to_string();
        match request {
            Request::Pair { code, name, .. } => {
                let verdict = match self.window.as_mut() {
                    Some(w) => w.check(&code, Instant::now()),
                    None => PairCheck::Closed,
                };
                let ack = |ok: bool, note: &str, me: &str| Response::PairAck {
                    ok,
                    name: me.to_string(),
                    note: note.to_string(),
                    ts: now_ms(),
                };
                match verdict {
                    PairCheck::Accepted => {
                        self.window = None;
                        let name = clean_label(&name);
                        match self.trust(peer, &name) {
                            Ok(()) => {
                                println!("paired with {peer} ({name})");
                                ack(true, "paired", &self.name)
                            }
                            Err(e) => ack(false, &format!("could not save the pairing: {e}"), &self.name),
                        }
                    }
                    PairCheck::Wrong => {
                        println!("wrong pairing code from {peer}");
                        ack(false, "wrong code", &self.name)
                    }
                    PairCheck::Closed => {
                        self.window = None;
                        ack(false, "pairing is not open", &self.name)
                    }
                }
            }
            Request::Message { text, ts, .. } => {
                println!("received message from {from}: \"{}\"", text);
                self.emit(MeshEvent::Message { from, text, ts });
                Response::Ack {
                    ok: true,
                    note: "delivered".to_string(),
                    ts: now_ms(),
                }
            }
            Request::FileStart {
                transfer_id,
                name,
                size,
                sha256,
                chunk_size,
                ..
            } => {
                // Both ids end up as file names under our inbound directory, so neither may be
                // chosen freely by the sender. The transfer id must be the one both sides derive
                // from (name, size, hash), which also makes it plain hex.
                if !safe_file_name(&name) || transfer_id != crate::transfer_id(&name, size, &sha256) {
                    println!("file {transfer_id}: refused start from {from} (bad name or id)");
                    return Response::FileStartAck {
                        ok: false,
                        transfer_id,
                        next_seq: 0,
                        note: "refused: invalid file name or transfer id".to_string(),
                        ts: now_ms(),
                    };
                }
                let partial_dir = self.inbound_dir.join(".partial");
                let _ = std::fs::create_dir_all(&partial_dir);
                let partial_path = partial_dir.join(&transfer_id);

                // If we already have this transfer, resume it (keep the existing next_seq).
                if let Some(t) = self.inbound.get_mut(&transfer_id) {
                    println!(
                        "file {transfer_id}: resuming receive of {name} ({} bytes), next_seq={}",
                        size, t.next_seq
                    );
                    Response::FileStartAck {
                        ok: true,
                        transfer_id,
                        next_seq: t.next_seq,
                        note: "resumed".to_string(),
                        ts: now_ms(),
                    }
                } else {
                    // Fresh transfer: create the partial file.
                    match std::fs::File::create(&partial_path) {
                        Ok(_) => {
                            println!(
                                "file {transfer_id}: starting receive of {name} ({} bytes, chunk {})",
                                size, chunk_size
                            );
                            self.inbound.insert(
                                transfer_id.clone(),
                                InboundTransfer {
                                    name,
                                    size,
                                    sha256,
                                    next_seq: 0,
                                    received: 0,
                                    path: partial_path,
                                },
                            );
                            Response::FileStartAck {
                                ok: true,
                                transfer_id,
                                next_seq: 0,
                                note: "started".to_string(),
                                ts: now_ms(),
                            }
                        }
                        Err(e) => {
                            println!("file {transfer_id}: failed to create partial file: {e}");
                            Response::FileStartAck {
                                ok: false,
                                transfer_id,
                                next_seq: 0,
                                note: format!("failed to create partial file: {e}"),
                                ts: now_ms(),
                            }
                        }
                    }
                }
            }
            Request::FileChunk {
                transfer_id,
                seq,
                data_b64,
                ..
            } => {
                let Some(t) = self.inbound.get_mut(&transfer_id) else {
                    println!("file {transfer_id}: chunk {seq} for unknown transfer (from {from})");
                    return Response::FileChunkAck {
                        ok: false,
                        transfer_id,
                        seq,
                        ts: now_ms(),
                    };
                };
                match base64::engine::general_purpose::STANDARD.decode(&data_b64) {
                    Ok(data) => {
                        if seq == t.next_seq && t.received + data.len() as u64 > t.size {
                            // More bytes than the transfer declared: refuse rather than fill the disk.
                            println!("file {transfer_id}: chunk {seq} overruns the declared size");
                            Response::FileChunkAck {
                                ok: false,
                                transfer_id,
                                seq,
                                ts: now_ms(),
                            }
                        } else if seq == t.next_seq {
                            // Append the chunk.
                            match append_chunk(&t.path, &data) {
                                Ok(()) => {
                                    t.next_seq += 1;
                                    t.received += data.len() as u64;
                                    Response::FileChunkAck {
                                        ok: true,
                                        transfer_id,
                                        seq,
                                        ts: now_ms(),
                                    }
                                }
                                Err(e) => {
                                    println!("file {transfer_id}: failed to append chunk {seq}: {e}");
                                    Response::FileChunkAck {
                                        ok: false,
                                        transfer_id,
                                        seq,
                                        ts: now_ms(),
                                    }
                                }
                            }
                        } else if seq < t.next_seq {
                            // Duplicate chunk (already received); ack idempotently.
                            Response::FileChunkAck {
                                ok: true,
                                transfer_id,
                                seq,
                                ts: now_ms(),
                            }
                        } else {
                            // Out of order; the sender should resend from next_seq.
                            println!(
                                "file {transfer_id}: out-of-order chunk {seq} (expected {})",
                                t.next_seq
                            );
                            Response::FileChunkAck {
                                ok: false,
                                transfer_id,
                                seq,
                                ts: now_ms(),
                            }
                        }
                    }
                    Err(e) => {
                        println!("file {transfer_id}: failed to decode chunk {seq}: {e}");
                        Response::FileChunkAck {
                            ok: false,
                            transfer_id,
                            seq,
                            ts: now_ms(),
                        }
                    }
                }
            }
            Request::FileEnd { transfer_id, .. } => {
                let Some(t) = self.inbound.get_mut(&transfer_id) else {
                    println!("file {transfer_id}: end for unknown transfer (from {from})");
                    return Response::FileEndAck {
                        ok: false,
                        transfer_id,
                        note: "unknown transfer".to_string(),
                        ts: now_ms(),
                    };
                };
                let done = t.received;
                if done != t.size {
                    println!(
                        "file {transfer_id}: end but only {done}/{size} bytes received",
                        size = t.size
                    );
                    return Response::FileEndAck {
                        ok: false,
                        transfer_id,
                        note: format!("incomplete: {done}/{} bytes", t.size),
                        ts: now_ms(),
                    };
                }
                // Verify the hash.
                let data = match std::fs::read(&t.path) {
                    Ok(d) => d,
                    Err(e) => {
                        return Response::FileEndAck {
                            ok: false,
                            transfer_id,
                            note: format!("failed to read partial file: {e}"),
                            ts: now_ms(),
                        }
                    }
                };
                let actual = sha256_hex(&data);
                if actual != t.sha256 {
                    println!(
                        "file {transfer_id}: hash mismatch (expected {}, got {actual})",
                        t.sha256
                    );
                    return Response::FileEndAck {
                        ok: false,
                        transfer_id,
                        note: "hash mismatch".to_string(),
                        ts: now_ms(),
                    };
                }
                // Finalize: move the partial file to the inbound dir.
                let final_path = self.inbound_dir.join(&t.name);
                match std::fs::rename(&t.path, &final_path) {
                    Ok(()) => {
                        println!(
                            "file {transfer_id}: received {} ({} bytes) -> {}",
                            t.name,
                            t.size,
                            final_path.display()
                        );
                        let (name, size) = (t.name.clone(), t.size);
                        self.inbound.remove(&transfer_id);
                        self.emit(MeshEvent::FileReceived {
                            from,
                            transfer_id: transfer_id.clone(),
                            name,
                            path: final_path.display().to_string(),
                            size,
                        });
                        Response::FileEndAck {
                            ok: true,
                            transfer_id,
                            note: format!("file saved to {}", final_path.display()),
                            ts: now_ms(),
                        }
                    }
                    Err(e) => {
                        println!("file {transfer_id}: failed to finalize: {e}");
                        Response::FileEndAck {
                            ok: false,
                            transfer_id,
                            note: format!("failed to finalize: {e}"),
                            ts: now_ms(),
                        }
                    }
                }
            }
            Request::Task { task_id, task, .. } => {
                println!("received task {task_id} from {from}: \"{}\"", task);
                let (ok, result) = self.execute_task(&from, &task);
                println!(
                    "task {task_id} result: ok={} \"{}\"",
                    ok,
                    result
                        .chars()
                        .take(200)
                        .collect::<String>()
                );
                Response::TaskResult {
                    task_id,
                    ok,
                    result,
                    ts: now_ms(),
                }
            }
        }
    }

    /// Execute a delegated task. The task policy decides what may run: read-only commands run
    /// WITHOUT a shell, trusted peers may run anything through `sh -c`, and everything else is
    /// refused with a reason. The TS policy layer (which can ask a person) takes over task
    /// execution later; until then, the mesh only runs what is safe by default.
    ///
    /// Supported task forms:
    /// - `shell:<command>` — checked by the task policy (see [`task_policy`]).
    /// - `echo:<text>` — return the text.
    /// - anything else — acknowledge receipt (echo the task back).
    fn execute_task(&self, from: &str, task: &str) -> (bool, String) {
        let checked = match self.task_policy.check(from, task) {
            Ok(c) => c,
            Err(why) => return (false, format!("task not allowed: {why}")),
        };
        match checked {
            CheckedTask::Echo(text) => (true, text),
            CheckedTask::Ack(task) => (true, format!("task received: {task}")),
            CheckedTask::Shell(cmd) => run_shell(&cmd),
            CheckedTask::Direct { program, args } => {
                // Defense in depth: the check used a lexical path check; before running, follow symlinks.
                if let Err(why) = self.task_policy.verify_direct(&program, &args) {
                    return (false, format!("task not allowed: {why}"));
                }
                run_direct(&program, &args)
            }
        }
    }

    /// Handle a command from the socket server.
    fn handle_command(&mut self, cmd: Command) -> CmdResponse {
        let ok = CmdResponse::ok;
        match cmd {
            Command::Status => CmdResponse {
                peer_id: Some(self.local_peer_id.to_string()),
                addrs: Some(self.listen_addrs()),
                peers: Some(self.connected_peers()),
                ..ok()
            },
            Command::ListPeers => CmdResponse { peers: Some(self.connected_peers()), ..ok() },
            Command::ListTransfers => CmdResponse { transfers: Some(self.list_transfers()), ..ok() },
            Command::ListPaired => CmdResponse { paired: Some(self.book.list()), ..ok() },
            Command::SendMessage { to, text } => match self.paired_peer(&to) {
                Ok(peer_id) => CmdResponse { request_id: Some(self.send_message(&peer_id, &text)), ..ok() },
                Err(e) => CmdResponse::err(e),
            },
            Command::SendFile { to, path } => match self.paired_peer(&to) {
                Ok(peer_id) => match self.send_file(&peer_id, &path) {
                    Ok(req_id) => CmdResponse { request_id: Some(req_id), ..ok() },
                    Err(e) => CmdResponse::err(format!("failed to read file {path}: {e}")),
                },
                Err(e) => CmdResponse::err(e),
            },
            Command::DelegateTask { to, task } => match self.paired_peer(&to) {
                Ok(peer_id) => {
                    let (req_id, task_id) = self.send_task(&peer_id, &task);
                    CmdResponse { request_id: Some(req_id), task_id: Some(task_id), ..ok() }
                }
                Err(e) => CmdResponse::err(e),
            },
            Command::Dial { addr } => match addr.parse::<Multiaddr>() {
                Ok(multiaddr) => match self.dial(multiaddr) {
                    Ok(()) => ok(),
                    Err(e) => CmdResponse::err(format!("failed to dial {addr}: {e}")),
                },
                Err(e) => CmdResponse::err(format!("invalid multiaddr {addr}: {e}")),
            },
            Command::PairStart => {
                let now = Instant::now();
                let window = PairingWindow::open(now);
                let (code, expires_in) = (window.code().to_string(), window.seconds_left(now));
                self.window = Some(window);
                CmdResponse { code: Some(code), expires_in: Some(expires_in), ..ok() }
            }
            Command::PairWith { addr, code } => match addr.parse::<Multiaddr>() {
                Ok(multiaddr) => match peer_id_from_addr(&multiaddr) {
                    Some(peer) => {
                        self.swarm.add_peer_address(peer, multiaddr);
                        let req = Request::Pair { code, name: self.name.clone(), ts: now_ms() };
                        let id = self.swarm.behaviour_mut().rr.send_request(&peer, req);
                        self.pending_pairs.insert(id, peer);
                        ok()
                    }
                    None => CmdResponse::err("the address must end in /p2p/<peer id>, so the peer can be verified"),
                },
                Err(e) => CmdResponse::err(format!("invalid multiaddr {addr}: {e}")),
            },
            Command::Trust { peer_id, name } => match peer_id.parse::<PeerId>() {
                Ok(peer) => match self.trust(peer, &clean_label(&name)) {
                    Ok(()) => ok(),
                    Err(e) => CmdResponse::err(format!("could not save: {e}")),
                },
                Err(e) => CmdResponse::err(format!("invalid peer id {peer_id}: {e}")),
            },
            Command::Revoke { peer_id } => match peer_id.parse::<PeerId>() {
                Ok(peer) => match self.book.remove(&peer) {
                    Ok(had) => {
                        let _ = self.swarm.disconnect_peer_id(peer);
                        if had {
                            self.emit(MeshEvent::Revoked { peer_id });
                        }
                        ok()
                    }
                    Err(e) => CmdResponse::err(format!("could not save: {e}")),
                },
                Err(e) => CmdResponse::err(format!("invalid peer id {peer_id}: {e}")),
            },
            // The socket server answers this itself; it never reaches the node in practice.
            Command::Subscribe => ok(),
        }
    }
}

/// The maximum task output kept (same cap as the TypeScript cap-shell).
const MAX_TASK_OUTPUT: usize = 64 * 1024;

/// Run a command through `sh -c` (only for trusted peers).
fn run_shell(cmd: &str) -> (bool, String) {
    match std::process::Command::new("sh").arg("-c").arg(cmd).output() {
        Ok(out) => task_output(out),
        Err(e) => (false, format!("failed to run shell: {e}")),
    }
}

/// Run a program directly with its arguments, WITHOUT a shell (no injection possible).
fn run_direct(program: &str, args: &[String]) -> (bool, String) {
    match std::process::Command::new(program).args(args).output() {
        Ok(out) => task_output(out),
        Err(e) => (false, format!("failed to run {program}: {e}")),
    }
}

/// Combine stdout/stderr into the task result, capping the output.
fn task_output(out: std::process::Output) -> (bool, String) {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let mut result = if stderr.trim().is_empty() {
        stdout.to_string()
    } else {
        format!("{stdout}{stderr}")
    };
    if result.len() > MAX_TASK_OUTPUT {
        let mut end = MAX_TASK_OUTPUT;
        while !result.is_char_boundary(end) {
            end -= 1;
        }
        result.truncate(end);
        result.push_str(" [output truncated]");
    }
    (out.status.success(), result.trim().to_string())
}

/// Compute the hex sha256 of a byte slice.
fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Read a chunk of `len` bytes from `path` at byte `offset`.
fn read_chunk(path: &std::path::Path, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; len];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

/// Append `data` to the end of `path`.
fn append_chunk(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(data)?;
    Ok(())
}

fn listen_addr(port: u16) -> Multiaddr {
    let mut a = Multiaddr::empty();
    a.push(Protocol::Ip4([0, 0, 0, 0].into()));
    a.push(Protocol::Tcp(port));
    a
}

/// The node's keys: read from `path`, or made and saved there (owner-only) on first start, so
/// the peer id stays the same across restarts.
fn load_or_create_identity(path: &Path) -> anyhow::Result<identity::Keypair> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(identity::Keypair::from_protobuf_encoding(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let key = identity::Keypair::generate_ed25519();
            write_private(path, &key.to_protobuf_encoding()?)?;
            Ok(key)
        }
        Err(e) => Err(e.into()),
    }
}

/// A peer-supplied label made safe to show and store: no control characters, at most 64 chars.
fn clean_label(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).take(64).collect::<String>().trim().to_string()
}

fn quic_listen_addr(port: u16) -> Multiaddr {
    let mut a = Multiaddr::empty();
    a.push(Protocol::Ip4([0, 0, 0, 0].into()));
    a.push(Protocol::Udp(port));
    a.push(Protocol::QuicV1);
    a
}

/// A file name a peer may ask us to create: exactly one normal path component. Anything that
/// could point outside the inbound directory (`..`, `/etc/x`, `a/b`, an empty name) is refused,
/// as is the name of our own scratch directory.
fn safe_file_name(name: &str) -> bool {
    use std::path::{Component, Path};
    let p = Path::new(name);
    let mut comps = p.components();
    matches!((comps.next(), comps.next()), (Some(Component::Normal(n)), None) if n == p.as_os_str())
        && name != ".partial"
        && !name.contains('\0')
}

/// Extract the peer id from a multiaddr's `p2p` component, if present.
fn peer_id_from_addr(addr: &Multiaddr) -> Option<PeerId> {
    for protocol in addr.iter() {
        if let Protocol::P2p(multihash) = protocol {
            return PeerId::from_multihash(multihash.into()).ok();
        }
    }
    None
}
#[cfg(test)]
mod tests {
    //! Requests a malicious peer could craft, fed straight to the inbound handler. The network
    //! round trips are in `tests/mesh.rs`.

    use std::collections::HashSet;

    use super::*;
    use crate::task_policy::PathGuard;

    fn node(trusted: &[PeerId]) -> (MeshNode, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let policy = TaskPolicy::new(PathGuard::new(vec![], vec![]), trusted.iter().cloned().collect::<HashSet<_>>());
        (MeshNode::new(dir.path().join("inbound"), policy).unwrap(), dir)
    }

    fn peer() -> PeerId {
        PeerId::from(identity::Keypair::generate_ed25519().public())
    }

    /// A new peer this node has already paired with.
    fn paired(n: &mut MeshNode) -> PeerId {
        let p = peer();
        n.trust(p, "test").unwrap();
        p
    }

    fn task(from: &PeerId, text: &str) -> Request {
        Request::Task { from: from.to_string(), to: String::new(), task_id: "t".into(), task: text.into(), ts: 0 }
    }

    fn file_start(name: &str, tid: &str, size: u64, sha: &str) -> Request {
        Request::FileStart {
            from: String::new(), to: String::new(), transfer_id: tid.into(), name: name.into(),
            size, sha256: sha.into(), chunk_size: CHUNK_SIZE, ts: 0,
        }
    }

    fn chunk(tid: &str, seq: u64, data: &[u8]) -> Request {
        Request::FileChunk {
            from: String::new(), to: String::new(), transfer_id: tid.into(), seq,
            data_b64: base64::engine::general_purpose::STANDARD.encode(data), ts: 0,
        }
    }

    fn end(tid: &str) -> Request {
        Request::FileEnd { from: String::new(), to: String::new(), transfer_id: tid.into(), ts: 0 }
    }

    fn task_result(r: Response) -> (bool, String) {
        match r {
            Response::TaskResult { ok, result, .. } => (ok, result),
            other => panic!("expected a task result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_peer_cannot_claim_to_be_a_trusted_peer() {
        let trusted = peer();
        let (mut n, _dir) = node(&[trusted]);
        n.trust(trusted, "t").unwrap();
        let mallory = paired(&mut n);
        // `&&` is only allowed for trusted peers. Mallory writes the trusted id in `from`.
        let forged = task(&trusted, "shell:echo a && echo b");
        let (ok, why) = task_result(n.handle_inbound_request(mallory, forged));
        assert!(!ok, "forged `from` must not grant shell access, got: {why}");
        assert!(why.contains("not allowed"), "{why}");
    }

    #[tokio::test]
    async fn the_real_trusted_peer_still_gets_a_shell() {
        let trusted = peer();
        let (mut n, _dir) = node(&[trusted]);
        n.trust(trusted, "t").unwrap();
        // The body names somebody else; only the authenticated peer counts.
        let (ok, out) = task_result(n.handle_inbound_request(trusted, task(&peer(), "shell:echo a && echo b")));
        assert!(ok, "{out}");
        assert_eq!(out, "a\nb");
    }

    #[tokio::test]
    async fn file_names_cannot_leave_the_inbound_directory() {
        let (mut n, dir) = node(&[]);
        let outside = dir.path().join("evil");
        for name in ["../evil", "/tmp/evil", "a/b", "..", ".", "", ".partial", "x\0y"] {
            let tid = crate::transfer_id(name, 1, "00");
            let p = paired(&mut n);
            let r = n.handle_inbound_request(p, file_start(name, &tid, 1, "00"));
            assert!(matches!(r, Response::FileStartAck { ok: false, .. }), "{name:?} was accepted: {r:?}");
        }
        assert!(!outside.exists());
        assert!(n.inbound.is_empty());
    }

    #[tokio::test]
    async fn transfer_ids_must_be_the_derived_hash_not_a_path() {
        let (mut n, _dir) = node(&[]);
        for tid in ["../../etc/x", "/etc/x", "not-the-derived-id"] {
            let p = paired(&mut n);
            let r = n.handle_inbound_request(p, file_start("ok.bin", tid, 1, "00"));
            assert!(matches!(r, Response::FileStartAck { ok: false, .. }), "{tid:?} was accepted: {r:?}");
        }
    }

    #[tokio::test]
    async fn a_chunk_past_the_declared_size_is_refused() {
        let (mut n, _dir) = node(&[]);
        let tid = crate::transfer_id("f.bin", 4, "00");
        let p = paired(&mut n);
        assert!(matches!(n.handle_inbound_request(p, file_start("f.bin", &tid, 4, "00")), Response::FileStartAck { ok: true, .. }));
        let r = n.handle_inbound_request(p, chunk(&tid, 0, &[0u8; 8]));
        assert!(matches!(r, Response::FileChunkAck { ok: false, .. }), "{r:?}");
        let partial = std::fs::metadata(&n.inbound[&tid].path).unwrap().len();
        assert_eq!(partial, 0, "nothing past the declared size may be written");
    }

    #[tokio::test]
    async fn a_file_with_the_wrong_hash_is_not_kept() {
        let (mut n, _dir) = node(&[]);
        let claimed = sha256_hex(b"what the sender promised");
        let tid = crate::transfer_id("f.bin", 4, &claimed);
        let p = paired(&mut n);
        n.handle_inbound_request(p, file_start("f.bin", &tid, 4, &claimed));
        assert!(matches!(n.handle_inbound_request(p, chunk(&tid, 0, b"abcd")), Response::FileChunkAck { ok: true, .. }));
        let r = n.handle_inbound_request(p, end(&tid));
        assert!(matches!(r, Response::FileEndAck { ok: false, .. }), "{r:?}");
        assert!(!n.inbound_dir.join("f.bin").exists());
    }

    #[tokio::test]
    async fn a_good_file_is_saved_and_announced_with_the_authenticated_sender() {
        let (mut n, _dir) = node(&[]);
        let p = paired(&mut n);
        let mut events = n.events().subscribe();
        let sha = sha256_hex(b"abcd");
        let tid = crate::transfer_id("f.bin", 4, &sha);
        n.handle_inbound_request(p, file_start("f.bin", &tid, 4, &sha));
        n.handle_inbound_request(p, chunk(&tid, 0, b"abcd"));
        assert!(matches!(n.handle_inbound_request(p, end(&tid)), Response::FileEndAck { ok: true, .. }));
        assert_eq!(std::fs::read(n.inbound_dir.join("f.bin")).unwrap(), b"abcd");
        match events.try_recv().unwrap() {
            MeshEvent::FileReceived { from, name, size, .. } => {
                assert_eq!((from, name, size), (p.to_string(), "f.bin".to_string(), 4));
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn an_unpaired_peer_is_refused_for_every_request_type() {
        let (mut n, _dir) = node(&[]);
        let stranger = peer();
        let sha = sha256_hex(b"abcd");
        let tid = crate::transfer_id("f.bin", 4, &sha);
        let requests = [
            Request::Message { from: String::new(), to: String::new(), text: "hi".into(), ts: 0 },
            file_start("f.bin", &tid, 4, &sha),
            chunk(&tid, 0, b"abcd"),
            end(&tid),
            task(&stranger, "echo:hi"),
        ];
        for r in requests {
            let label = format!("{r:?}");
            let resp = n.handle_inbound_request(stranger, r);
            assert!(matches!(resp, Response::Denied { .. }), "{label} got {resp:?}");
        }
        assert!(n.inbound.is_empty());
        assert!(!n.inbound_dir.join("f.bin").exists());
    }

    fn pair_request(code: &str, name: &str) -> Request {
        Request::Pair { code: code.into(), name: name.into(), ts: 0 }
    }

    fn open_code(n: &mut MeshNode) -> String {
        n.handle_command(Command::PairStart).code.unwrap()
    }

    #[tokio::test]
    async fn the_right_code_pairs_a_stranger_exactly_once() {
        let (mut n, _dir) = node(&[]);
        let code = open_code(&mut n);
        let (first, second) = (peer(), peer());

        let r = n.handle_inbound_request(first, pair_request(&code, "laptop\u{7}\nx"));
        assert!(matches!(r, Response::PairAck { ok: true, .. }), "{r:?}");
        assert!(n.book.contains(&first));
        assert_eq!(n.book.list()[0].name, "laptopx", "labels are cleaned");

        // The code is spent: a second peer cannot reuse it, and the first is still paired.
        let r = n.handle_inbound_request(second, pair_request(&code, "evil"));
        assert!(matches!(r, Response::PairAck { ok: false, .. }), "{r:?}");
        assert!(!n.book.contains(&second));
        let r = n.handle_inbound_request(first, Request::Message { from: String::new(), to: String::new(), text: "x".into(), ts: 0 });
        assert!(matches!(r, Response::Ack { ok: true, .. }));
    }

    #[tokio::test]
    async fn without_an_open_window_nobody_can_pair() {
        let (mut n, _dir) = node(&[]);
        let p = peer();
        let r = n.handle_inbound_request(p, pair_request("000000", "x"));
        assert!(matches!(r, Response::PairAck { ok: false, .. }), "{r:?}");
        assert!(!n.book.contains(&p));
    }

    #[tokio::test]
    async fn guessing_the_code_closes_the_window() {
        let (mut n, _dir) = node(&[]);
        let code = open_code(&mut n);
        let wrong = if code == "000000" { "111111" } else { "000000" };
        let guesser = peer();
        for _ in 0..crate::pairing::MAX_TRIES {
            let r = n.handle_inbound_request(guesser, pair_request(wrong, "g"));
            assert!(matches!(r, Response::PairAck { ok: false, .. }));
        }
        // Even the right code no longer works, for anyone.
        let r = n.handle_inbound_request(peer(), pair_request(&code, "late"));
        assert!(matches!(r, Response::PairAck { ok: false, .. }), "{r:?}");
        assert!(n.book.list().is_empty());
    }

    #[tokio::test]
    async fn commands_to_an_unpaired_peer_are_rejected_up_front() {
        let (mut n, _dir) = node(&[]);
        let stranger = peer().to_string();
        for cmd in [
            Command::SendMessage { to: stranger.clone(), text: "x".into() },
            Command::SendFile { to: stranger.clone(), path: "/etc/hostname".into() },
            Command::DelegateTask { to: stranger.clone(), task: "echo:x".into() },
        ] {
            let r = n.handle_command(cmd);
            assert!(!r.ok && r.error.unwrap().contains("not paired"));
        }
    }

    #[tokio::test]
    async fn revoking_a_peer_closes_the_door_again() {
        let (mut n, _dir) = node(&[]);
        let p = paired(&mut n);
        let msg = || Request::Message { from: String::new(), to: String::new(), text: "x".into(), ts: 0 };
        assert!(matches!(n.handle_inbound_request(p, msg()), Response::Ack { ok: true, .. }));
        assert!(n.handle_command(Command::Revoke { peer_id: p.to_string() }).ok);
        assert!(matches!(n.handle_inbound_request(p, msg()), Response::Denied { .. }));
    }

    #[tokio::test]
    async fn the_identity_and_paired_peers_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let make = || {
            let mut cfg = NodeConfig::new(dir.path().join("inbound"), TaskPolicy::new(PathGuard::new(vec![], vec![]), HashSet::new()));
            cfg.state_dir = Some(dir.path().join("state"));
            MeshNode::with_config(cfg).unwrap()
        };
        let mut first = make();
        let friend = peer();
        first.trust(friend, "friend").unwrap();
        let id = first.local_peer_id();
        drop(first);

        let second = make();
        assert_eq!(second.local_peer_id(), id, "the peer id must not change on restart");
        assert!(second.book.contains(&friend));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("state/identity.key")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "the private key must be owner-only");
        }
    }
}
