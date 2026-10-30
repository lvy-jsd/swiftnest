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
//!   MESH_TRUSTED_PEERS (default empty) comma-separated peer ids that may run any `shell:` task
//!                        through `sh -c`; everyone else is limited to read-only commands
//!   MESH_TASK_ROOTS   (default: the home directory) comma-separated folders shared for task paths
//!   MESH_TASK_DENY    (default empty) comma-separated extra paths refused for task paths

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use libp2p::{multiaddr::Protocol, Multiaddr, PeerId};
use tokio::sync::mpsc;

use swiftnest_mesh::node::{CommandEnvelope, MeshNode};
use swiftnest_mesh::socket;
use swiftnest_mesh::task_policy::{PathGuard, TaskPolicy};

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

    // Build the task policy: the execution boundary for delegated tasks.
    let trusted_peers: HashSet<PeerId> = std::env::var("MESH_TRUSTED_PEERS")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .filter_map(|s| s.trim().parse::<PeerId>().ok())
        .collect();
    let task_roots: Vec<PathBuf> = std::env::var("MESH_TASK_ROOTS")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|s| PathBuf::from(s.trim()))
        .collect();
    let task_deny: Vec<PathBuf> = std::env::var("MESH_TASK_DENY")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|s| PathBuf::from(s.trim()))
        .collect();
    let task_policy = TaskPolicy::new(PathGuard::new(task_roots, task_deny), trusted_peers);

    // Build the node and start listening.
    let mut node = MeshNode::new(PathBuf::from(inbound_dir), task_policy)?;
    let local_peer_id = node.local_peer_id();
    let events = node.events();
    println!("local peer id: {local_peer_id}");
    node.listen(listen_tcp, listen_quic)?;

    // Optionally listen on a relayed address (/ip4/.../tcp/.../p2p/<relay>/p2p-circuit/p2p/<me>).
    // Listening on a relayed address makes the relay client reserve a slot on that relay, so
    // other peers can reach us through it.
    if let Ok(relay_addr) = std::env::var("MESH_RELAY_LISTEN") {
        let addr: Multiaddr = relay_addr.parse()?;
        println!("listening on relayed addr {addr}");
        node.listen_on(addr)?;
    }

    // Dial peers if given. Each argument is either a full multiaddr (contains '/') or a bare
    // peer id (dialled over 127.0.0.1/tcp/MESH_DIAL_TCP). This lets a node dial a relay and,
    // through it, a peer's relayed address (/ip4/.../tcp/.../p2p/<relay>/p2p/<peer>).
    for target in args.iter().skip(1) {
        let addr = if target.contains('/') {
            target.parse::<Multiaddr>()?
        } else {
            let peer_id: PeerId = target.parse()?;
            let mut a = Multiaddr::empty();
            a.push(Protocol::Ip4([127, 0, 0, 1].into()));
            a.push(Protocol::Tcp(dial_tcp));
            a.with_p2p(peer_id).expect("valid peer id")
        };
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
        async move { socket::run(&socket_path, tx, events).await }
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