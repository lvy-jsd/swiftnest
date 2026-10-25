//! The Unix socket server: the TS <-> Rust interface.
//!
//! Accepts connections on a local Unix socket. Each connection speaks line-delimited JSON:
//! the client sends one [`Command`] per line, and the node answers with one [`CmdResponse`]
//! per line. Commands are forwarded to the mesh node over an mpsc channel; responses come
//! back over a per-command oneshot channel.

use std::path::Path;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

use crate::node::CommandEnvelope;
use crate::{CmdResponse, Command};

/// Run the Unix socket server, forwarding commands to the node and writing responses back.
/// Returns when the listener is closed.
pub async fn run(
    socket_path: &Path,
    cmd_tx: mpsc::Sender<CommandEnvelope>,
) -> anyhow::Result<()> {
    // Remove a stale socket file from a previous run.
    if socket_path.exists() {
        std::fs::remove_file(socket_path)?;
    }
    let listener = UnixListener::bind(socket_path)?;
    println!("unix socket listening on {}", socket_path.display());

    loop {
        let (stream, _) = listener.accept().await?;
        let tx = cmd_tx.clone();
        tokio::spawn(handle_connection(stream, tx));
    }
}

/// Handle a single client connection: read commands line by line, answer each.
async fn handle_connection(stream: UnixStream, cmd_tx: mpsc::Sender<CommandEnvelope>) {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break, // EOF: the client closed the connection.
            Err(e) => {
                tracing::debug!("socket read error: {e}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let resp = match serde_json::from_str::<Command>(&line) {
            Ok(cmd) => {
                let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                if cmd_tx
                    .send(CommandEnvelope { cmd, reply: reply_tx })
                    .await
                    .is_err()
                {
                    CmdResponse::err("node is shutting down")
                } else {
                    match reply_rx.await {
                        Ok(resp) => resp,
                        Err(_) => CmdResponse::err("node stopped before responding"),
                    }
                }
            }
            Err(e) => CmdResponse::err(format!("invalid command: {e}")),
        };

        let mut out = serde_json::to_string(&resp).unwrap_or_else(|_| r#"{"ok":false}"#.to_string());
        out.push('\n');
        if writer.write_all(out.as_bytes()).await.is_err() {
            break;
        }
    }
}