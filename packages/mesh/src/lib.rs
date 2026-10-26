//! swiftnest-mesh: the mesh core.
//!
//! A libp2p node that lets agents on different machines talk to each other. The sidecar binary
//! (`main.rs`) runs a [`node::MeshNode`] and exposes it to the TypeScript core over a local
//! Unix socket using line-delimited JSON (the same pattern as the dsh-tool-manager sidecar).
//!
//! Wire protocol (mesh): JSON over the libp2p request-response behaviour. A [`Request`] is a
//! request (text message, file transfer, or task); the recipient answers with a [`Response`].
//!
//! Socket protocol (TS <-> Rust): one JSON object per line. Commands are [`Command`]; the node
//! answers with a [`CmdResponse`].

pub mod codec;
pub mod node;
pub mod socket;

pub use base64;

use serde::{Deserialize, Serialize};

/// The mesh protocol name.
pub const PROTOCOL: &str = "/swiftnest/mesh/1.0.0";

/// A request sent between mesh nodes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    /// A text message.
    Message {
        /// The sender's peer id (or agent name).
        from: String,
        /// The recipient's peer id (or agent name).
        to: String,
        /// The message body.
        text: String,
        /// Unix timestamp in milliseconds.
        ts: u64,
    },
    /// Start a chunked file transfer. The receiver creates (or resumes) a partial file and
    /// answers with the next chunk it expects, so the sender can resume after a drop.
    FileStart {
        /// The sender's peer id (or agent name).
        from: String,
        /// The recipient's peer id (or agent name).
        to: String,
        /// A deterministic id for this transfer (hex of sha256 over name|size|file_sha256),
        /// so both sides can compute it and resume after a restart.
        transfer_id: String,
        /// The file name (the receiver writes to `inbound/<name>`).
        name: String,
        /// The total file size in bytes.
        size: u64,
        /// The hex sha256 of the whole file (for verification on completion).
        sha256: String,
        /// The raw byte size of each chunk.
        chunk_size: u64,
        /// Unix timestamp in milliseconds.
        ts: u64,
    },
    /// A chunk of a file transfer.
    FileChunk {
        /// The sender's peer id (or agent name).
        from: String,
        /// The recipient's peer id (or agent name).
        to: String,
        /// The transfer this chunk belongs to.
        transfer_id: String,
        /// The zero-based chunk sequence number.
        seq: u64,
        /// The chunk contents, base64-encoded.
        data_b64: String,
        /// Unix timestamp in milliseconds.
        ts: u64,
    },
    /// End a chunked file transfer. The receiver verifies the hash and finalizes the file.
    FileEnd {
        /// The sender's peer id (or agent name).
        from: String,
        /// The recipient's peer id (or agent name).
        to: String,
        /// The transfer this end belongs to.
        transfer_id: String,
        /// Unix timestamp in milliseconds.
        ts: u64,
    },
    /// A task delegated to the recipient's agent.
    Task {
        /// The sender's peer id (or agent name).
        from: String,
        /// The recipient's peer id (or agent name).
        to: String,
        /// A unique id for this task (chosen by the sender).
        task_id: String,
        /// The task to execute (a description, or a `shell:` / `echo:` command).
        task: String,
        /// Unix timestamp in milliseconds.
        ts: u64,
    },
}

/// A response to a [`Request`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    /// Acknowledgement for a received request.
    Ack {
        /// Whether the request was accepted.
        ok: bool,
        /// A short human-readable note (e.g. "delivered", "file saved").
        note: String,
        /// Unix timestamp in milliseconds.
        ts: u64,
    },
    /// The result of a delegated task.
    TaskResult {
        /// The task id this result is for.
        task_id: String,
        /// Whether the task succeeded.
        ok: bool,
        /// The task result (output, or an error message).
        result: String,
        /// Unix timestamp in milliseconds.
        ts: u64,
    },
    /// Acknowledgement of a `FileStart`. Carries the next chunk the receiver expects, so the
    /// sender can resume a transfer that was interrupted.
    FileStartAck {
        /// Whether the transfer was accepted.
        ok: bool,
        /// The transfer this ack is for.
        transfer_id: String,
        /// The next chunk sequence the receiver expects (0 for a fresh transfer).
        next_seq: u64,
        /// A short human-readable note.
        note: String,
        /// Unix timestamp in milliseconds.
        ts: u64,
    },
    /// Acknowledgement of a `FileChunk`.
    FileChunkAck {
        /// Whether the chunk was accepted.
        ok: bool,
        /// The transfer this ack is for.
        transfer_id: String,
        /// The chunk sequence that was acknowledged.
        seq: u64,
        /// Unix timestamp in milliseconds.
        ts: u64,
    },
    /// Acknowledgement of a `FileEnd`. The receiver has verified the hash and finalized the file.
    FileEndAck {
        /// Whether the file was finalized successfully.
        ok: bool,
        /// The transfer this ack is for.
        transfer_id: String,
        /// A short human-readable note (e.g. "file saved to ..." or "hash mismatch").
        note: String,
        /// Unix timestamp in milliseconds.
        ts: u64,
    },
}

/// A peer known to the node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    /// The peer's id.
    pub peer_id: String,
    /// Whether the peer is currently connected.
    pub connected: bool,
}

/// An in-progress file transfer (sending or receiving).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferInfo {
    /// The transfer id.
    pub transfer_id: String,
    /// The file name.
    pub name: String,
    /// The total file size in bytes.
    pub size: u64,
    /// The number of bytes received (receiving) or sent (sending) so far.
    pub done: u64,
    /// The direction: "sending" or "receiving".
    pub direction: String,
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
    /// Send a file to a peer (by peer id). The file is read from `path` and sent as a chunked,
    /// resumable transfer. If a transfer for the same file is already in progress, it resumes.
    SendFile { to: String, path: String },
    /// Delegate a task to a peer (by peer id). The task is executed on the remote node.
    DelegateTask { to: String, task: String },
    /// List in-progress file transfers (both sending and receiving).
    ListTransfers,
}

/// A response from the node to a [`Command`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CmdResponse {
    /// Whether the command succeeded.
    pub ok: bool,
    /// The node's own peer id (for `status`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_id: Option<String>,
    /// Connected peers (for `status` / `list_peers`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peers: Option<Vec<PeerInfo>>,
    /// The outbound request id (for `send_message` / `send_file` / `delegate_task`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<u64>,
    /// The task id (for `delegate_task`), so the sender can correlate the result.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// In-progress file transfers (for `list_transfers`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfers: Option<Vec<TransferInfo>>,
    /// An error message (when `ok` is false).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CmdResponse {
    /// A successful response with no extra fields.
    pub fn ok() -> Self {
        Self {
            ok: true,
            peer_id: None,
            peers: None,
            request_id: None,
            task_id: None,
            transfers: None,
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
            task_id: None,
            transfers: None,
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

/// Compute the deterministic transfer id for a file: hex of sha256 over `name|size|file_sha256`.
/// Both sender and receiver can compute it, so a transfer can be resumed after a restart.
pub fn transfer_id(name: &str, size: u64, file_sha256: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    hasher.update(b"|");
    hasher.update(size.to_string().as_bytes());
    hasher.update(b"|");
    hasher.update(file_sha256.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}