//! The mesh node: a libp2p swarm that listens, dials, and exchanges messages.
//!
//! The node runs its event loop in a background task. Commands arrive over an mpsc channel
//! (from the Unix socket server) and are answered with a [`Response`] over a per-command
//! oneshot channel.

use futures::StreamExt;
use libp2p::{
    identity, multiaddr::Protocol, request_response, swarm::StreamProtocol, Multiaddr, PeerId,
    Swarm, SwarmBuilder,
};
use tokio::sync::{mpsc, oneshot};

use crate::{now_ms, Ack, Command, Message, PeerInfo, Response, PROTOCOL};

type RrBehaviour = request_response::json::Behaviour<Message, Ack>;
type MeshSwarm = Swarm<RrBehaviour>;

/// A command paired with the channel its response is sent on.
pub struct CommandEnvelope {
    pub cmd: Command,
    pub reply: oneshot::Sender<Response>,
}

/// A libp2p mesh node.
pub struct MeshNode {
    swarm: MeshSwarm,
    local_peer_id: PeerId,
}

impl MeshNode {
    /// Build a node (not listening yet; call [`Self::listen`] to start listening).
    pub fn new() -> anyhow::Result<Self> {
        let identity_key = identity::Keypair::generate_ed25519();
        let local_peer_id = PeerId::from(identity_key.public());
        let protocol = StreamProtocol::new(PROTOCOL);

        let swarm = SwarmBuilder::with_existing_identity(identity_key)
            .with_tokio()
            .with_tcp(
                Default::default(),
                libp2p::noise::Config::new,
                libp2p::yamux::Config::default,
            )?
            .with_quic()
            .with_behaviour(|_| {
                RrBehaviour::new(
                    [(
                        protocol.clone(),
                        request_response::ProtocolSupport::Full,
                    )],
                    request_response::Config::default(),
                )
            })?
            .with_swarm_config(|cfg| cfg)
            .build();

        Ok(Self {
            swarm,
            local_peer_id,
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
        let msg = Message {
            from: self.local_peer_id.to_string(),
            to: to.to_string(),
            text: text.to_string(),
            ts: now_ms(),
        };
        let req_id = self.swarm.behaviour_mut().send_request(to, msg);
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
                        Some(libp2p::swarm::SwarmEvent::Behaviour(rr_event)) => {
                            self.handle_rr_event(rr_event);
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

    /// Handle a request-response event: acknowledge incoming messages.
    fn handle_rr_event(&mut self, event: request_response::Event<Message, Ack>) {
        match event {
            request_response::Event::Message {
                peer,
                message: request_response::Message::Request { request, channel, .. },
                ..
            } => {
                println!(
                    "received message from {peer}: \"{}\" (from {})",
                    request.text, request.from
                );
                let ack = Ack {
                    ok: true,
                    note: "delivered".to_string(),
                    ts: now_ms(),
                };
                match self.swarm.behaviour_mut().send_response(channel, ack) {
                    Ok(()) => println!("sent ack to {peer}"),
                    Err(unsent) => println!("failed to send ack to {peer}: {unsent:?}"),
                }
            }
            request_response::Event::Message {
                peer,
                message: request_response::Message::Response { response, .. },
                ..
            } => {
                println!(
                    "received ack from {peer}: ok={} note=\"{}\"",
                    response.ok, response.note
                );
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

    /// Handle a command from the socket server.
    fn handle_command(&mut self, cmd: Command) -> Response {
        match cmd {
            Command::Status => Response {
                ok: true,
                peer_id: Some(self.local_peer_id.to_string()),
                peers: Some(self.connected_peers()),
                request_id: None,
                error: None,
            },
            Command::ListPeers => Response {
                ok: true,
                peer_id: None,
                peers: Some(self.connected_peers()),
                request_id: None,
                error: None,
            },
            Command::SendMessage { to, text } => match to.parse::<PeerId>() {
                Ok(peer_id) => {
                    let req_id = self.send_message(&peer_id, &text);
                    Response {
                        ok: true,
                        peer_id: None,
                        peers: None,
                        request_id: Some(req_id),
                        error: None,
                    }
                }
                Err(e) => Response::err(format!("invalid peer id {to}: {e}")),
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