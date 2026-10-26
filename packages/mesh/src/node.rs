//! The mesh node: a libp2p swarm that listens, dials, and exchanges messages and files.
//!
//! The node runs its event loop in a background task. Commands arrive over an mpsc channel
//! (from the Unix socket server) and are answered with a [`CmdResponse`] over a per-command
//! oneshot channel.

use futures::StreamExt;
use libp2p::{
    identity, multiaddr::Protocol, relay, request_response, swarm::StreamProtocol, Multiaddr,
    PeerId, Swarm, SwarmBuilder,
};
use libp2p::swarm::NetworkBehaviour;
use tokio::sync::{mpsc, oneshot};

use crate::{now_ms, base64, codec, CmdResponse, Command, PeerInfo, Request, Response, PROTOCOL};
use base64::Engine;

/// The mesh swarm behaviour: request-response (messages, files, tasks) + relay (so nodes can
/// reach each other through a relay when a direct connection is not possible).
#[derive(NetworkBehaviour)]
pub struct MeshBehaviour {
    rr: request_response::Behaviour<codec::JsonCodec<Request, Response>>,
    relay: relay::Behaviour,
}

impl MeshBehaviour {
    /// Build the behaviour for a node with the given identity.
    pub fn new(local_peer_id: PeerId) -> Self {
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
    inbound_dir: std::path::PathBuf,
}

impl MeshNode {
    /// Build a node (not listening yet; call [`Self::listen`] to start listening).
    pub fn new(inbound_dir: std::path::PathBuf) -> anyhow::Result<Self> {
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
            .with_behaviour(|kp| MeshBehaviour::new(PeerId::from(kp.public())))?
            .with_swarm_config(|cfg| cfg)
            .build();

        Ok(Self {
            swarm,
            local_peer_id,
            inbound_dir,
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

    /// Dial a peer at the given multiaddr.
    ///
    /// Also records the peer's address in the swarm's address book so that `send_request` can
    /// reach the peer (it dials using known addresses).
    pub fn dial(&mut self, addr: Multiaddr) -> anyhow::Result<()> {
        if let Some(peer_id) = peer_id_from_addr(&addr) {
            self.swarm.add_peer_address(peer_id, addr.clone());
        }
        self.swarm.dial(addr)?;
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

    /// Send a file to a peer. Reads the file from `path`, base64-encodes it, and sends it.
    /// Returns the outbound request id.
    pub fn send_file(&mut self, to: &PeerId, path: &str) -> anyhow::Result<u64> {
        let data = std::fs::read(path)?;
        let name = std::path::Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let req = Request::File {
            from: self.local_peer_id.to_string(),
            to: to.to_string(),
            name,
            data_b64: base64::engine::general_purpose::STANDARD.encode(&data),
            ts: now_ms(),
        };
        Ok(self.send_request(to, req))
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
        loop {
            tokio::select! {
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

    /// Process an inbound request (message, file, or task). Returns the response to send back.
    fn handle_inbound_request(&self, request: Request) -> Response {
        match request {
            Request::Message { text, from, .. } => {
                println!("received message from {from}: \"{}\"", text);
                Response::Ack {
                    ok: true,
                    note: "delivered".to_string(),
                    ts: now_ms(),
                }
            }
            Request::File { name, data_b64, from, .. } => {
                match base64::engine::general_purpose::STANDARD.decode(&data_b64) {
                    Ok(data) => {
                        let path = self.inbound_dir.join(&name);
                        match std::fs::write(&path, &data) {
                            Ok(()) => {
                                println!(
                                    "received file from {from}: {} ({} bytes) -> {}",
                                    name,
                                    data.len(),
                                    path.display()
                                );
                                Response::Ack {
                                    ok: true,
                                    note: format!("file saved to {}", path.display()),
                                    ts: now_ms(),
                                }
                            }
                            Err(e) => {
                                println!("failed to write file {}: {e}", path.display());
                                Response::Ack {
                                    ok: false,
                                    note: format!("failed to write file: {e}"),
                                    ts: now_ms(),
                                }
                            }
                        }
                    }
                    Err(e) => {
                        println!("failed to decode file from {from}: {e}");
                        Response::Ack {
                            ok: false,
                            note: format!("failed to decode file: {e}"),
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
                error: None,
            },
            Command::ListPeers => CmdResponse {
                ok: true,
                peer_id: None,
                peers: Some(self.connected_peers()),
                request_id: None,
                task_id: None,
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
                        error: None,
                    }
                }
                Err(e) => CmdResponse::err(format!("invalid peer id {to}: {e}")),
            },
        }
    }
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