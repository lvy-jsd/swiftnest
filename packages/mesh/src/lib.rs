//! swiftnest-mesh: the mesh core.
//!
//! A libp2p node that lets agents on different machines talk to each other. The sidecar binary
//! (`main.rs`) runs a [`node::MeshNode`] and exposes it to the TypeScript core over a local
//! Unix socket using line-delimited JSON (the same pattern as the dsh-tool-manager sidecar).
//!
//! Wire protocol (mesh): JSON over the libp2p request-response behaviour. A [`Message`] is a
//! request; the recipient answers with an [`Ack`].
//!
//! Socket protocol (TS <-> Rust): one JSON object per line. Commands are [`Command`]; the node
//! answers with a [`Response`].

pub mod node;
pub mod socket;

use serde::{Deserialize, Serialize};

/// The mesh protocol name.
pub const PROTOCOL: &str = "/swiftnest/mesh/1.0.0";

/// A text message sent between mesh nodes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// The sender's peer id (or agent name).
    pub from: String,
    /// The recipient's peer id (or agent name).
    pub to: String,
    /// The message body.
    pub text: String,
    /// Unix timestamp in milliseconds.
    pub ts: u64,
}

/// Acknowledgement for a received message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ack {
    /// Whether the message was accepted.
    pub ok: bool,
    /// A short human-readable note (e.g. "delivered").
    pub note: String,
    /// Unix timestamp in milliseconds.
    pub ts: u64,
}

/// A peer known to the node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    /// The peer's id.
    pub peer_id: String,
    /// Whether the peer is currently connected.
    pub connected: bool,
}

/// A command sent from the TypeScript core over the Unix socket.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    /// Report the node's own peer id and currently connected peers.
    Status,
    /// List currently connected peers.
    ListPeers,
    /// Send a text message to a peer (by peer id).
    SendMessage { to: String, text: String },
}

/// A response from the node to a [`Command`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    /// Whether the command succeeded.
    pub ok: bool,
    /// The node's own peer id (for `status`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_id: Option<String>,
    /// Connected peers (for `status` / `list_peers`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peers: Option<Vec<PeerInfo>>,
    /// The outbound request id (for `send_message`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<u64>,
    /// An error message (when `ok` is false).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    /// A successful response with no extra fields.
    pub fn ok() -> Self {
        Self {
            ok: true,
            peer_id: None,
            peers: None,
            request_id: None,
            error: None,
        }
    }

    /// An error response.
    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            peer_id: None,
            peers: None,
            request_id: None,
            error: Some(msg.into()),
        }
    }
}

/// Current Unix time in milliseconds.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}