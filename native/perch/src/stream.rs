//! Stream v1: authenticated header (version/id/sequence/flags/length), then AEAD payload.
use crate::{Failure, Result};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;

pub const MAX: usize = 4 * 1024 * 1024;
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub id: String,
    pub purpose: String,
    pub direction: String,
    pub transport_candidates: Vec<String>,
    pub ticket: String,
    pub expires: u64,
    pub max_frame: usize,
    pub max_dimension: u32,
    pub display_id: String,
    pub file: Option<crate::transfer::FileOffer>,
}
impl Offer {
    pub fn verify(&self, root: &[u8; 32]) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if self.id.len() != 32
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || !matches!(self.purpose.as_str(), "screen" | "file")
            || (self.purpose == "file" && self.file.is_none())
            || self.direction != "duplex"
            || self.transport_candidates != ["websocket-relay-v1"]
            || self.max_frame < 1024
            || self.max_frame > MAX
            || !(320..=2560).contains(&self.max_dimension)
            || self.display_id.len() > 128
            || self.expires < now
            || self.expires > now + 30000
        {
            return Err(Failure::new(
                "BAD_STREAM",
                "Invalid or expired stream offer",
            ));
        }
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(root).expect("key");
        mac.update(format!("swiftnest/ticket/v1\0{}\0{}", self.id, self.expires).as_bytes());
        let ticket = B64
            .decode(&self.ticket)
            .map_err(|_| Failure::new("BAD_STREAM", "Invalid stream ticket"))?;
        mac.verify_slice(&ticket)
            .map_err(|_| Failure::new("BAD_STREAM", "Stream ticket does not match parent"))
    }
}
pub struct StreamCipher {
    id: [u8; 16],
    send: Aes256Gcm,
    recv: Aes256Gcm,
    sent: u64,
    received: u64,
}
impl StreamCipher {
    pub fn new(root: &[u8; 32], transcript: &[u8; 32], id: &str, initiator: bool) -> Result<Self> {
        let mut raw = [0; 16];
        if id.len() != 32 {
            return Err(Failure::new("BAD_STREAM", "Invalid stream id"));
        }
        for (i, b) in raw.iter_mut().enumerate() {
            *b = u8::from_str_radix(&id[i * 2..i * 2 + 2], 16)
                .map_err(|_| Failure::new("BAD_STREAM", "Invalid stream id"))?;
        }
        let mut keys = zeroize::Zeroizing::new([0u8; 64]);
        Hkdf::<Sha256>::new(Some(transcript), root)
            .expand(format!("swiftnest/stream/v1/{id}").as_bytes(), &mut *keys)
            .map_err(|_| Failure::new("BAD_STREAM", "Key derivation failed"))?;
        let (a, b) = if initiator {
            (&keys[..32], &keys[32..])
        } else {
            (&keys[32..], &keys[..32])
        };
        Ok(Self {
            id: raw,
            send: Aes256Gcm::new_from_slice(a).unwrap(),
            recv: Aes256Gcm::new_from_slice(b).unwrap(),
            sent: 0,
            received: 0,
        })
    }
    pub fn seal(&mut self, flag: u8, plain: &[u8]) -> Result<Vec<u8>> {
        if plain.len() > MAX || self.sent == u64::MAX {
            return Err(Failure::new("BAD_STREAM", "Stream record limit"));
        }
        let mut h = vec![1];
        h.extend(self.id);
        h.extend(self.sent.to_be_bytes());
        h.push(flag);
        h.extend((plain.len() as u32).to_be_bytes());
        let mut nonce = [0; 12];
        nonce[4..].copy_from_slice(&self.sent.to_be_bytes());
        let body = self
            .send
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plain,
                    aad: &h,
                },
            )
            .map_err(|_| Failure::new("BAD_STREAM", "Encryption failed"))?;
        self.sent += 1;
        h.extend(body);
        Ok(h)
    }
    pub fn open(&mut self, frame: &[u8]) -> Result<(u8, Vec<u8>)> {
        let bad = || {
            Failure::new(
                "BAD_STREAM",
                "Invalid stream record, replay or authentication tag",
            )
        };
        if frame.len() < 46
            || frame.len() > MAX + 46
            || frame[0] != 1
            || frame[1..17] != self.id
            || frame[17..25] != self.received.to_be_bytes()
            || self.received == u64::MAX
            || u32::from_be_bytes(frame[26..30].try_into().unwrap()) as usize != frame.len() - 46
        {
            return Err(bad());
        }
        let mut nonce = [0; 12];
        nonce[4..].copy_from_slice(&frame[17..25]);
        let plain = self
            .recv
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &frame[30..],
                    aad: &frame[..30],
                },
            )
            .map_err(|_| bad())?;
        self.received += 1;
        Ok((frame[25], plain))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn integrity_domains_and_replays() {
        let id = "0123456789abcdef0123456789abcdef";
        let mut a = StreamCipher::new(&[1; 32], &[2; 32], id, true).unwrap();
        let mut b = StreamCipher::new(&[1; 32], &[2; 32], id, false).unwrap();
        let f = a.seal(1, b"jpeg").unwrap();
        assert_eq!(b.open(&f).unwrap(), (1, b"jpeg".to_vec()));
        assert!(b.open(&f).is_err());
        let mut c = StreamCipher::new(&[1; 32], &[3; 32], id, false).unwrap();
        assert!(c.open(&f).is_err());
        let mut f = a.seal(2, b"input").unwrap();
        f[25] ^= 1;
        assert!(b.open(&f).is_err());
        assert!(a.seal(1, &vec![0; MAX + 1]).is_err());
        let f = b.seal(3, b"ack").unwrap();
        assert_eq!(a.open(&f).unwrap().1, b"ack");
    }
}
