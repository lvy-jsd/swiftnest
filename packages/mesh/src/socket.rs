//! The Unix socket server: the TS <-> Rust interface.
//!
//! Accepts connections on a local Unix socket. Each connection speaks line-delimited JSON:
//! the client sends one [`Command`] per line, and the node answers with one [`CmdResponse`]
//! per line. Commands are forwarded to the mesh node over an mpsc channel; responses come
//! back over a per-command oneshot channel.
//!
//! After a `{"cmd":"subscribe"}` the connection also receives a [`MeshEvent`] line for every
//! event the node emits. Events carry an `event` key and responses do not, so a client tells
//! them apart by that key.

use std::path::Path;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc};

use crate::node::CommandEnvelope;
use crate::{CmdResponse, Command, MeshEvent};

/// Run the Unix socket server, forwarding commands to the node and writing responses back.
/// Returns when the listener is closed.
pub async fn run(
    socket_path: &Path,
    cmd_tx: mpsc::Sender<CommandEnvelope>,
    events: broadcast::Sender<MeshEvent>,
) -> anyhow::Result<()> {
    // Remove a stale socket file from a previous run.
    if socket_path.exists() {
        std::fs::remove_file(socket_path)?;
    }
    let listener = UnixListener::bind(socket_path)?;
    // The socket is a control channel to a node that can send files and run tasks on this
    // machine's behalf, so only the owner may open it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))?;
    }
    println!("unix socket listening on {}", socket_path.display());

    loop {
        let (stream, _) = listener.accept().await?;
        tokio::spawn(handle_connection(stream, cmd_tx.clone(), events.clone()));
    }
}

/// Handle a single client connection: read commands line by line, answer each.
async fn handle_connection(
    stream: UnixStream,
    cmd_tx: mpsc::Sender<CommandEnvelope>,
    events: broadcast::Sender<MeshEvent>,
) {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    // Responses and events share the one socket, so a single task owns the writer.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let writer_task = tokio::spawn(async move {
        while let Some(mut line) = out_rx.recv().await {
            line.push('\n');
            if writer.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let mut forwarder: Option<tokio::task::JoinHandle<()>> = None;

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
            Ok(Command::Subscribe) => {
                if forwarder.is_none() {
                    let mut rx = events.subscribe();
                    let tx = out_tx.clone();
                    forwarder = Some(tokio::spawn(async move {
                        loop {
                            match rx.recv().await {
                                Ok(ev) => {
                                    let Ok(json) = serde_json::to_string(&ev) else { continue };
                                    if tx.send(json).is_err() {
                                        break;
                                    }
                                }
                                // A slow client missed some events; keep going with the newer ones.
                                Err(broadcast::error::RecvError::Lagged(n)) => {
                                    tracing::warn!("socket client lagged, dropped {n} events");
                                }
                                Err(broadcast::error::RecvError::Closed) => break,
                            }
                        }
                    }));
                }
                CmdResponse::ok()
            }
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

        let out = serde_json::to_string(&resp).unwrap_or_else(|_| r#"{"ok":false}"#.to_string());
        if out_tx.send(out).is_err() {
            break;
        }
    }

    if let Some(f) = forwarder {
        f.abort();
    }
    drop(out_tx);
    let _ = writer_task.await;
}
