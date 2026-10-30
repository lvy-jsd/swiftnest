//! Two real nodes in one process, talking over loopback TCP and QUIC.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use libp2p::PeerId;
use swiftnest_mesh::node::{CommandEnvelope, MeshNode};
use swiftnest_mesh::socket;
use swiftnest_mesh::task_policy::{PathGuard, TaskPolicy};
use swiftnest_mesh::{CmdResponse, Command, MeshEvent};
use tokio::sync::{broadcast, mpsc, oneshot};

const WAIT: Duration = Duration::from_secs(20);

struct TestNode {
    peer_id: PeerId,
    cmd: mpsc::Sender<CommandEnvelope>,
    events: broadcast::Receiver<MeshEvent>,
    events_tx: broadcast::Sender<MeshEvent>,
    inbound: PathBuf,
    _dir: tempfile::TempDir,
}

fn start(trusted: &[PeerId]) -> TestNode {
    let dir = tempfile::tempdir().unwrap();
    let inbound = dir.path().join("inbound");
    let policy = TaskPolicy::new(
        PathGuard::new(vec![], vec![]),
        trusted.iter().cloned().collect::<HashSet<_>>(),
    );
    let mut node = MeshNode::new(inbound.clone(), policy).unwrap();
    node.listen(0, 0).unwrap();
    let (cmd, rx) = mpsc::channel(16);
    let events_tx = node.events();
    let events = events_tx.subscribe();
    let peer_id = node.local_peer_id();
    tokio::spawn(async move { node.run(rx).await });
    TestNode { peer_id, cmd, events, events_tx, inbound, _dir: dir }
}

impl TestNode {
    async fn send(&self, cmd: Command) -> CmdResponse {
        let (reply, rx) = oneshot::channel();
        self.cmd.send(CommandEnvelope { cmd, reply }).await.unwrap();
        rx.await.unwrap()
    }

    /// A loopback address of this node whose multiaddr contains `needle` (`/tcp/` or `/quic-v1`).
    async fn addr(&self, needle: &str) -> String {
        tokio::time::timeout(WAIT, async {
            loop {
                let status = self.send(Command::Status).await;
                let found = status
                    .addrs
                    .unwrap_or_default()
                    .into_iter()
                    .find(|a| a.starts_with("/ip4/127.0.0.1/") && a.contains(needle));
                if let Some(a) = found {
                    return format!("{a}/p2p/{}", self.peer_id);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("no loopback address matching {needle}"))
    }

    /// Wait for the first event the predicate maps to `Some`; earlier events are skipped.
    async fn expect<T>(&mut self, what: &str, mut f: impl FnMut(&MeshEvent) -> Option<T>) -> T {
        tokio::time::timeout(WAIT, async {
            loop {
                match self.events.recv().await {
                    Ok(ev) => {
                        if let Some(v) = f(&ev) {
                            return v;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(e) => panic!("event stream ended while waiting for {what}: {e}"),
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
    }
}

/// Dial `b` from `a` and wait until both sides report the connection.
async fn connect(a: &mut TestNode, b: &mut TestNode, transport: &str) {
    let addr = b.addr(transport).await;
    assert!(a.send(Command::Dial { addr: addr.clone() }).await.ok, "dial {addr}");
    let want_b = b.peer_id.to_string();
    let want_a = a.peer_id.to_string();
    a.expect("a connected to b", |e| matches!(e, MeshEvent::PeerConnected { peer_id } if *peer_id == want_b).then_some(())).await;
    b.expect("b sees a", |e| matches!(e, MeshEvent::PeerConnected { peer_id } if *peer_id == want_a).then_some(())).await;
}

/// Not random, but not a repeating block either, so a misplaced chunk changes the hash.
fn sample_bytes(len: usize) -> Vec<u8> {
    (0..len as u64).map(|i| (i.wrapping_mul(2654435761) >> 7) as u8).collect()
}

#[tokio::test]
async fn the_node_listens_on_quic_as_well_as_tcp() {
    let n = start(&[]);
    n.addr("/tcp/").await;
    let quic = n.addr("/udp/").await;
    assert!(quic.contains("/quic-v1/"), "{quic}");
}

#[tokio::test]
async fn a_message_arrives_with_the_real_sender() {
    let (mut a, mut b) = (start(&[]), start(&[]));
    connect(&mut a, &mut b, "/tcp/").await;
    assert!(a.send(Command::SendMessage { to: b.peer_id.to_string(), text: "hello".into() }).await.ok);
    let (from, text) = b
        .expect("the message", |e| match e {
            MeshEvent::Message { from, text, .. } => Some((from.clone(), text.clone())),
            _ => None,
        })
        .await;
    assert_eq!((from, text), (a.peer_id.to_string(), "hello".to_string()));
}

#[tokio::test]
async fn nodes_can_connect_over_quic() {
    let (mut a, mut b) = (start(&[]), start(&[]));
    connect(&mut a, &mut b, "/quic-v1").await;
    a.send(Command::SendMessage { to: b.peer_id.to_string(), text: "over quic".into() }).await;
    let text = b.expect("the message", |e| match e {
        MeshEvent::Message { text, .. } => Some(text.clone()),
        _ => None,
    }).await;
    assert_eq!(text, "over quic");
}

#[tokio::test]
async fn a_multi_chunk_file_arrives_intact() {
    let (mut a, mut b) = (start(&[]), start(&[]));
    connect(&mut a, &mut b, "/tcp/").await;

    // 2.5 MiB: three chunks, the last one partial.
    let data = sample_bytes(2 * 1024 * 1024 + 512 * 1024);
    let src = a._dir.path().join("big.bin");
    std::fs::write(&src, &data).unwrap();
    let r = a.send(Command::SendFile { to: b.peer_id.to_string(), path: src.display().to_string() }).await;
    assert!(r.ok, "{:?}", r.error);

    let (name, size, path) = b
        .expect("the file", |e| match e {
            MeshEvent::FileReceived { name, size, path, .. } => Some((name.clone(), *size, path.clone())),
            _ => None,
        })
        .await;
    assert_eq!((name.as_str(), size), ("big.bin", data.len() as u64));
    assert_eq!(std::fs::read(&path).unwrap(), data);
    assert_eq!(PathBuf::from(&path), b.inbound.join("big.bin"));

    let ok = a.expect("the sender's completion", |e| match e {
        MeshEvent::FileSent { ok, .. } => Some(*ok),
        _ => None,
    }).await;
    assert!(ok);
}

#[tokio::test]
async fn an_empty_file_arrives() {
    let (mut a, mut b) = (start(&[]), start(&[]));
    connect(&mut a, &mut b, "/tcp/").await;
    let src = a._dir.path().join("empty.txt");
    std::fs::write(&src, b"").unwrap();
    a.send(Command::SendFile { to: b.peer_id.to_string(), path: src.display().to_string() }).await;
    let size = b.expect("the file", |e| match e {
        MeshEvent::FileReceived { size, .. } => Some(*size),
        _ => None,
    }).await;
    assert_eq!(size, 0);
    assert!(b.inbound.join("empty.txt").exists());
}

#[tokio::test]
async fn a_delegated_task_returns_its_result_to_the_sender() {
    let (mut a, mut b) = (start(&[]), start(&[]));
    connect(&mut a, &mut b, "/tcp/").await;
    let r = a.send(Command::DelegateTask { to: b.peer_id.to_string(), task: "echo:hi from a".into() }).await;
    let task_id = r.task_id.expect("a task id");
    let (id, ok, result) = a
        .expect("the task result", |e| match e {
            MeshEvent::TaskResult { task_id, ok, result, .. } => Some((task_id.clone(), *ok, result.clone())),
            _ => None,
        })
        .await;
    assert_eq!((id, ok, result.as_str()), (task_id, true, "hi from a"));
}

#[tokio::test]
async fn an_untrusted_peer_cannot_run_a_shell_pipeline_remotely() {
    let (mut a, mut b) = (start(&[]), start(&[]));
    connect(&mut a, &mut b, "/tcp/").await;
    let marker = b._dir.path().join("pwned");
    a.send(Command::DelegateTask {
        to: b.peer_id.to_string(),
        task: format!("shell:echo x && touch {}", marker.display()),
    })
    .await;
    let (ok, result) = a.expect("the task result", |e| match e {
        MeshEvent::TaskResult { ok, result, .. } => Some((*ok, result.clone())),
        _ => None,
    }).await;
    assert!(!ok, "{result}");
    assert!(!marker.exists());
}

#[tokio::test]
async fn a_trusted_peer_runs_the_shell_it_is_trusted_with() {
    // The node needs to know a's id before it exists, so start a first and trust it on b.
    let mut a = start(&[]);
    let mut b = start(&[a.peer_id]);
    connect(&mut a, &mut b, "/tcp/").await;
    a.send(Command::DelegateTask { to: b.peer_id.to_string(), task: "shell:echo 1 && echo 2".into() }).await;
    let (ok, result) = a.expect("the task result", |e| match e {
        MeshEvent::TaskResult { ok, result, .. } => Some((*ok, result.clone())),
        _ => None,
    }).await;
    assert!(ok, "{result}");
    assert_eq!(result, "1\n2");
}

#[tokio::test]
async fn sending_to_an_unreachable_peer_fails_loudly_and_can_be_retried() {
    let mut a = start(&[]);
    let nobody = PeerId::random();
    let src = a._dir.path().join("f.bin");
    std::fs::write(&src, b"data").unwrap();

    a.send(Command::SendFile { to: nobody.to_string(), path: src.display().to_string() }).await;
    let note = a.expect("the failed transfer", |e| match e {
        MeshEvent::FileSent { ok: false, note, .. } => Some(note.clone()),
        _ => None,
    }).await;
    assert!(note.contains("delivery failed"), "{note}");

    // The transfer is not left hanging: it can be started again.
    let again = a.send(Command::SendFile { to: nobody.to_string(), path: src.display().to_string() }).await;
    assert!(again.ok);
    a.expect("the second failure", |e| matches!(e, MeshEvent::FileSent { ok: false, .. }).then_some(())).await;
}

#[tokio::test]
async fn socket_clients_receive_events_after_subscribing() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (mut a, mut b) = (start(&[]), start(&[]));
    let sock = b._dir.path().join("mesh.sock");
    tokio::spawn({
        let (sock, tx, events) = (sock.clone(), b.cmd.clone(), b.events_tx.clone());
        async move { socket::run(&sock, tx, events).await }
    });
    tokio::time::timeout(WAIT, async { while !sock.exists() { tokio::time::sleep(Duration::from_millis(20)).await } })
        .await
        .expect("socket created");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777, 0o600);
    }

    let stream = tokio::net::UnixStream::connect(&sock).await.unwrap();
    let (r, mut w) = stream.into_split();
    let mut lines = BufReader::new(r).lines();
    w.write_all(b"{\"cmd\":\"subscribe\"}\n").await.unwrap();
    let first = lines.next_line().await.unwrap().unwrap();
    assert!(serde_json::from_str::<serde_json::Value>(&first).unwrap()["ok"].as_bool().unwrap());

    connect(&mut a, &mut b, "/tcp/").await;
    a.send(Command::SendMessage { to: b.peer_id.to_string(), text: "via socket".into() }).await;

    // Read until the message event shows up; connection events come first.
    let from = tokio::time::timeout(WAIT, async {
        loop {
            let line = lines.next_line().await.unwrap().expect("socket closed");
            let v: serde_json::Value = serde_json::from_str(&line).unwrap();
            if v["event"] == "message" {
                assert_eq!(v["text"], "via socket");
                return v["from"].as_str().unwrap().to_string();
            }
        }
    })
    .await
    .expect("message event on the socket");
    assert_eq!(from, a.peer_id.to_string());

    // Commands still work on the subscribed connection and answer in order.
    w.write_all(b"{\"cmd\":\"status\"}\n").await.unwrap();
    loop {
        let line = lines.next_line().await.unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        if v.get("event").is_none() {
            assert_eq!(v["peer_id"], b.peer_id.to_string());
            break;
        }
    }
}
