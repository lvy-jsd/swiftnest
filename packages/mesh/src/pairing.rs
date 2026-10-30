//! Who may talk to this node, and how a new peer gets in.
//!
//! A node answers only peers in its [`PeerBook`]. A peer gets into the book in one of two ways:
//! the owner adds it directly (`trust`, for headless set-ups where the key is already known), or
//! it presents a one-time pairing code that the owner opened a [`PairingWindow`] for.
//!
//! The transport already proves *who* a peer is (libp2p's Noise handshake authenticates the
//! peer id, and a dial to `/p2p/<id>` fails if the other end is not that id). The code proves the
//! owner *meant* to let this peer in, so it is sent only to a peer whose id the pairing string
//! already named.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use libp2p::PeerId;
use serde::{Deserialize, Serialize};

/// How long a pairing code stays valid.
pub const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
/// Wrong guesses allowed before the window closes.
pub const MAX_TRIES: u8 = 5;

/// A peer this node has agreed to talk to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairedPeer {
    pub peer_id: String,
    /// A label the peer gave itself (or the owner gave it); for people, never for decisions.
    pub name: String,
    /// Unix time in milliseconds when it was added.
    pub added: u64,
}

/// The set of paired peers, kept in `peers.json` (mode 600, replaced atomically) when the node
/// has a state directory.
pub struct PeerBook {
    path: Option<PathBuf>,
    peers: BTreeMap<String, PairedPeer>,
}

impl PeerBook {
    /// Load the book from `path`, or start empty if the file does not exist. With no path the
    /// book lives in memory only.
    pub fn load(path: Option<PathBuf>) -> anyhow::Result<Self> {
        let peers = match &path {
            Some(p) => match std::fs::read(p) {
                Ok(bytes) => serde_json::from_slice::<Vec<PairedPeer>>(&bytes)?
                    .into_iter()
                    .map(|p| (p.peer_id.clone(), p))
                    .collect(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
                Err(e) => return Err(e.into()),
            },
            None => BTreeMap::new(),
        };
        Ok(Self { path, peers })
    }

    pub fn contains(&self, peer: &PeerId) -> bool {
        self.peers.contains_key(&peer.to_string())
    }

    pub fn list(&self) -> Vec<PairedPeer> {
        self.peers.values().cloned().collect()
    }

    /// Add (or rename) a peer and save.
    pub fn add(&mut self, peer: &PeerId, name: &str) -> anyhow::Result<()> {
        let id = peer.to_string();
        let added = self.peers.get(&id).map(|p| p.added).unwrap_or_else(crate::now_ms);
        self.peers.insert(id.clone(), PairedPeer { peer_id: id, name: name.to_string(), added });
        self.save()
    }

    /// Remove a peer and save. Returns whether it was there.
    pub fn remove(&mut self, peer: &PeerId) -> anyhow::Result<bool> {
        let had = self.peers.remove(&peer.to_string()).is_some();
        if had {
            self.save()?;
        }
        Ok(had)
    }

    fn save(&self) -> anyhow::Result<()> {
        if let Some(path) = &self.path {
            write_private(path, &serde_json::to_vec_pretty(&self.list())?)?;
        }
        Ok(())
    }
}

/// An open invitation: one code, a deadline, and a limited number of wrong guesses.
pub struct PairingWindow {
    code: String,
    expires: Instant,
    tries: u8,
}

/// The verdict on a presented code.
#[derive(Debug, PartialEq, Eq)]
pub enum PairCheck {
    Accepted,
    Wrong,
    /// Too many wrong guesses, or past the deadline: the window is spent.
    Closed,
}

impl PairingWindow {
    pub fn open(now: Instant) -> Self {
        Self { code: format!("{:06}", rand::random::<u32>() % 1_000_000), expires: now + PAIRING_TTL, tries: 0 }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn seconds_left(&self, now: Instant) -> u64 {
        self.expires.saturating_duration_since(now).as_secs()
    }

    pub fn check(&mut self, offered: &str, now: Instant) -> PairCheck {
        if now >= self.expires || self.tries >= MAX_TRIES {
            return PairCheck::Closed;
        }
        if constant_time_eq(self.code.as_bytes(), offered.as_bytes()) {
            return PairCheck::Accepted;
        }
        self.tries += 1;
        if self.tries >= MAX_TRIES {
            PairCheck::Closed
        } else {
            PairCheck::Wrong
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Write `bytes` to `path` readable by the owner only, replacing any old file atomically.
pub fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> PeerId {
        PeerId::from(libp2p::identity::Keypair::generate_ed25519().public())
    }

    #[test]
    fn the_right_code_is_accepted_once_it_is_consumed_by_the_caller() {
        let now = Instant::now();
        let mut w = PairingWindow::open(now);
        let code = w.code().to_string();
        assert_eq!(code.len(), 6);
        assert_eq!(w.check(&code, now), PairCheck::Accepted);
    }

    #[test]
    fn five_wrong_guesses_close_the_window_even_for_the_right_code() {
        let now = Instant::now();
        let mut w = PairingWindow::open(now);
        let right = w.code().to_string();
        let wrong = if right == "000000" { "111111" } else { "000000" };
        for _ in 0..MAX_TRIES - 1 {
            assert_eq!(w.check(wrong, now), PairCheck::Wrong);
        }
        assert_eq!(w.check(wrong, now), PairCheck::Closed);
        assert_eq!(w.check(&right, now), PairCheck::Closed);
    }

    #[test]
    fn an_expired_code_is_refused() {
        let now = Instant::now();
        let mut w = PairingWindow::open(now);
        let code = w.code().to_string();
        assert_eq!(w.check(&code, now + PAIRING_TTL), PairCheck::Closed);
        assert_eq!(w.seconds_left(now + PAIRING_TTL), 0);
    }

    #[test]
    fn codes_of_the_wrong_length_never_match() {
        let now = Instant::now();
        let mut w = PairingWindow::open(now);
        assert_eq!(w.check("", now), PairCheck::Wrong);
        assert_eq!(w.check(&format!("{}0", w.code()), now), PairCheck::Wrong);
    }

    #[test]
    fn the_book_survives_a_restart_and_forgets_revoked_peers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join("peers.json");
        let (a, b) = (id(), id());
        let mut book = PeerBook::load(Some(path.clone())).unwrap();
        book.add(&a, "laptop").unwrap();
        book.add(&b, "server").unwrap();
        assert!(book.remove(&b).unwrap());
        assert!(!book.remove(&b).unwrap());

        let again = PeerBook::load(Some(path.clone())).unwrap();
        assert!(again.contains(&a) && !again.contains(&b));
        assert_eq!(again.list()[0].name, "laptop");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn re_adding_a_peer_keeps_its_first_seen_time() {
        let mut book = PeerBook::load(None).unwrap();
        let a = id();
        book.add(&a, "old").unwrap();
        let first = book.list()[0].added;
        book.add(&a, "new").unwrap();
        let p = &book.list()[0];
        assert_eq!((p.name.as_str(), p.added), ("new", first));
    }
}
