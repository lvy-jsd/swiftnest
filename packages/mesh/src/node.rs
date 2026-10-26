//! The mesh node: a libp2p swarm that listens, dials, and exchanges messages and files.
//!
//! The node runs its event loop in a background task. Commands arrive over an mpsc channel
//! (from the Unix socket server) and are answered with a [`CmdResponse`] over a per-command
//! oneshot channel.

use std::collections::HashMap;
use std::path::PathBuf;

use futures::StreamExt;
use libp2p::{
    autonat, dcutr, identify, identity, multiaddr::Protocol, relay, request_response,
    swarm::StreamProtocol, Multiaddr, PeerId, Swarm, SwarmBuilder,
};
use libp2p::swarm::NetworkBehaviour;
use tokio::sync::{mpsc, oneshot};

use crate::{
    now_ms, transfer_id, base64, codec, CmdResponse, Command, PeerInfo, Request, Response,
    TransferInfo, PROTOCOL,
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
    path: PathBuf,
}

/// The state of a file transfer being sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SendState {
    WaitingStartAck,
    WaitingChunkAck,
    WaitingEndAck,
    Done,
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
    relay: relay::Behaviour,
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
            relay: relay::Behaviour::new(local_peer_id, relay::Config::default()),
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
}

impl MeshNode {
    /// Build a node (not listening yet; call [`Self::listen`] to start listening).
    pub fn new(inbound_dir: PathBuf) -> anyhow::Result<Self> {
        let identity_key = identity::Keypair::generate_ed25519();
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
                MeshBehaviour::new(pid, kp.public(), relay_client)
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
        })
    }

    /// Start listening on the given ports.
    pub fn listen(&mut self, tcp: u16, quic: u16) -> anyhow::Result<()> {
        let tcp_addr = listen_addr(tcp);
        self.swarm.listen_on(tcp_addr.clone())?;
        println!("listening on {tcp_addr}");
        let quic_addr = listen_addr(quic);
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
        Ok(self.send_request(to, req))
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
                match read_chunk(&path, offset as u64, len) {
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
        let req_id = self.send_request(to, req);
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
        let task_id = format!("task-{}", now_ms());
        let req = Request::Task {
            from: self.local_peer_id.to_string(),
            to: to.to_string(),
            task_id: task_id.clone(),
            task: task.to_string(),
            ts: now_ms(),
        };
        (self.send_request(to, req), task_id)
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
                let resp = self.handle_inbound_request(request);
                match self.swarm.behaviour_mut().rr.send_response(channel, resp) {
                    Ok(()) => println!("sent response to {peer}"),
                    Err(unsent) => println!("failed to send response to {peer}: {unsent:?}"),
                }
            }
            request_response::Event::Message {
                peer,
                message: request_response::Message::Response { response, .. },
                ..
            } => {
                match response {
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
                    }
                }
            }
            request_response::Event::OutboundFailure { peer, error, .. } => {
                println!("outbound request to {peer} failed: {error}");
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
    fn handle_inbound_request(&mut self, request: Request) -> Response {
        match request {
            Request::Message { text, from, .. } => {
                println!("received message from {from}: \"{}\"", text);
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
                from: _,
                ..
            } => {
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
                from,
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
                        if seq == t.next_seq {
                            // Append the chunk.
                            match append_chunk(&t.path, &data) {
                                Ok(()) => {
                                    t.next_seq += 1;
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
            Request::FileEnd { transfer_id, from, .. } => {
                let Some(t) = self.inbound.get_mut(&transfer_id) else {
                    println!("file {transfer_id}: end for unknown transfer (from {from})");
                    return Response::FileEndAck {
                        ok: false,
                        transfer_id,
                        note: "unknown transfer".to_string(),
                        ts: now_ms(),
                    };
                };
                let done = std::fs::metadata(&t.path).map(|m| m.len()).unwrap_or(0);
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
                        self.inbound.remove(&transfer_id);
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
            Request::Task {
                task_id, task, from, ..
            } => {
                println!("received task {task_id} from {from}: \"{}\"", task);
                let (ok, result) = self.execute_task(&task);
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

    /// Execute a delegated task. For the first cut the Rust core runs simple built-in tasks;
    /// the TS layer will take over real task execution later.
    ///
    /// Supported task forms:
    /// - `shell:<command>` — run a shell command, return its output.
    /// - `echo:<text>` — return the text.
    /// - anything else — acknowledge receipt (echo the task back).
    fn execute_task(&self, task: &str) -> (bool, String) {
        if let Some(cmd) = task.strip_prefix("shell:") {
            match std::process::Command::new("sh").arg("-c").arg(cmd).output() {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    let result = if stderr.trim().is_empty() {
                        stdout.to_string()
                    } else {
                        format!("{stdout}{stderr}")
                    };
                    (out.status.success(), result.trim().to_string())
                }
                Err(e) => (false, format!("failed to run shell: {e}")),
            }
        } else if let Some(text) = task.strip_prefix("echo:") {
            (true, text.to_string())
        } else {
            (true, format!("task received: {task}"))
        }
    }

    /// Handle a command from the socket server.
    fn handle_command(&mut self, cmd: Command) -> CmdResponse {
        match cmd {
            Command::Status => CmdResponse {
                ok: true,
                peer_id: Some(self.local_peer_id.to_string()),
                peers: Some(self.connected_peers()),
                request_id: None,
                task_id: None,
                transfers: None,
                error: None,
            },
            Command::ListPeers => CmdResponse {
                ok: true,
                peer_id: None,
                peers: Some(self.connected_peers()),
                request_id: None,
                task_id: None,
                transfers: None,
                error: None,
            },
            Command::ListTransfers => CmdResponse {
                ok: true,
                peer_id: None,
                peers: None,
                request_id: None,
                task_id: None,
                transfers: Some(self.list_transfers()),
                error: None,
            },
            Command::SendMessage { to, text } => match to.parse::<PeerId>() {
                Ok(peer_id) => {
                    let req_id = self.send_message(&peer_id, &text);
                    CmdResponse {
                        ok: true,
                        peer_id: None,
                        peers: None,
                        request_id: Some(req_id),
                        task_id: None,
                        transfers: None,
                        error: None,
                    }
                }
                Err(e) => CmdResponse::err(format!("invalid peer id {to}: {e}")),
            },
            Command::SendFile { to, path } => match to.parse::<PeerId>() {
                Ok(peer_id) => match self.send_file(&peer_id, &path) {
                    Ok(req_id) => CmdResponse {
                        ok: true,
                        peer_id: None,
                        peers: None,
                        request_id: Some(req_id),
                        task_id: None,
                        transfers: None,
                        error: None,
                    },
                    Err(e) => CmdResponse::err(format!("failed to read file {path}: {e}")),
                },
                Err(e) => CmdResponse::err(format!("invalid peer id {to}: {e}")),
            },
            Command::DelegateTask { to, task } => match to.parse::<PeerId>() {
                Ok(peer_id) => {
                    let (req_id, task_id) = self.send_task(&peer_id, &task);
                    CmdResponse {
                        ok: true,
                        peer_id: None,
                        peers: None,
                        request_id: Some(req_id),
                        task_id: Some(task_id),
                        transfers: None,
                        error: None,
                    }
                }
                Err(e) => CmdResponse::err(format!("invalid peer id {to}: {e}")),
            },
        }
    }
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

/// Extract the peer id from a multiaddr's `p2p` component, if present.
fn peer_id_from_addr(addr: &Multiaddr) -> Option<PeerId> {
    for protocol in addr.iter() {
        if let Protocol::P2p(multihash) = protocol {
            return PeerId::from_multihash(multihash.into()).ok();
        }
    }
    None
}