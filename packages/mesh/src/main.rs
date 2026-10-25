//! swiftnest-mesh: the mesh core sidecar.
//!
//! Runs a libp2p mesh node (QUIC + TCP + Noise + yamux) and exposes it to the TypeScript core
//! over a local Unix socket (line-delimited JSON). If given a peer address, it dials it.
//!
//! Configuration (environment variables):
//!   MESH_LISTEN_TCP   (default 30001)  this node's TCP listen port
//!   MESH_LISTEN_QUIC  (default 30000)  this node's QUIC listen port
//!   MESH_DIAL_TCP     (default 30001)  the TCP port to dial when a peer is given
//!   MESH_SOCKET       (default /tmp/swiftnest-mesh.sock)  the Unix socket path
//!   MESH_INBOUND_DIR  (default /tmp/swiftnest-mesh-inbound)  where received files are written
//!   MESH_RUN_SECS     (default 0)      run for this many seconds, then exit (0 = run forever)

use std::path::PathBuf;
use std::time::Duration;

use libp2p::{multiaddr::Protocol, Multiaddr, PeerId};
use tokio::sync::mpsc;

use swiftnest_mesh::node::{CommandEnvelope, MeshNode};
use swiftnest_mesh::socket;

fn env_or(name: &str, default: u16) -> u16 {
    std::env::var(name).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();
    let dial_peer = args.get(1).cloned();

    let listen_tcp = env_or("MESH_LISTEN_TCP", 30001);
    let listen_quic = env_or("MESH_LISTEN_QUIC", 30000);
    let dial_tcp = env_or("MESH_DIAL_TCP", 30001);
    let socket_path = std::env::var("MESH_SOCKET")
        .unwrap_or_else(|_| "/tmp/swiftnest-mesh.sock".to_string());
    let inbound_dir = std::env::var("MESH_INBOUND_DIR")
        .unwrap_or_else(|_| "/tmp/swiftnest-mesh-inbound".to_string());
    let run_secs: u64 = std::env::var("MESH_RUN_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // Make sure the inbound directory exists so received files can be written.
    std::fs::create_dir_all(&inbound_dir)?;

    // Build the node and start listening.
    let mut node = MeshNode::new(PathBuf::from(inbound_dir))?;
    let local_peer_id = node.local_peer_id();
    println!("local peer id: {local_peer_id}");
    node.listen(listen_tcp, listen_quic)?;

    // Dial a peer if given.
    if let Some(peer) = dial_peer {
        let peer_id: PeerId = peer.parse()?;
        let mut addr = Multiaddr::empty();
        addr.push(Protocol::Ip4([127, 0, 0, 1].into()));
        addr.push(Protocol::Tcp(dial_tcp));
        addr = addr.with_p2p(peer_id).expect("valid peer id");
        println!("dialing {addr}");
        node.dial(addr)?;
    }

    // Channel for commands from the socket server to the node.
    let (cmd_tx, cmd_rx) = mpsc::channel::<CommandEnvelope>(64);

    // Run the node event loop in a background task.
    let node_task = tokio::spawn(async move {
        node.run(cmd_rx).await;
    });

    // Run the Unix socket server.
    let socket_path = PathBuf::from(socket_path);
    let socket_task = tokio::spawn({
        let tx = cmd_tx;
        async move { socket::run(&socket_path, tx).await }
    });

    // Run for the configured duration, or forever until interrupted.
    if run_secs > 0 {
        tokio::time::sleep(Duration::from_secs(run_secs)).await;
    } else {
        tokio::signal::ctrl_c().await?;
    }

    // Shut down.
    socket_task.abort();
    node_task.abort();
    println!("done");
    Ok(())
}