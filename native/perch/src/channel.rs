//! Wire format mirrors packages/core/src/channel.ts, including exact transcript bytes.
use crate::{store::public_key, Failure, Result};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    net::TcpStream,
    time::{timeout, Duration},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};
use x25519_dalek::{PublicKey, StaticSecret};

pub const MAX_FRAME: usize = 16 * 1024 * 1024;
pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
fn transport(e: impl std::fmt::Display) -> Failure {
    Failure::new("DISCONNECTED", e.to_string())
}

pub struct Cipher {
    send: Aes256Gcm,
    recv: Aes256Gcm,
    sent: u64,
    received: u64,
}
impl Cipher {
    pub fn new(send: &[u8], recv: &[u8]) -> Self {
        Self {
            send: Aes256Gcm::new_from_slice(send).expect("32 byte key"),
            recv: Aes256Gcm::new_from_slice(recv).expect("32 byte key"),
            sent: 0,
            received: 0,
        }
    }
    pub fn seal(&mut self, value: &Value) -> Result<String> {
        let plain = serde_json::to_vec(value)?;
        // Also respect link-lan's encoded WebSocket payload cap.
        if (plain.len() + 24).div_ceil(3) * 4 > MAX_FRAME {
            return Err(Failure::new("FRAME_TOO_LARGE", "Frame exceeds 16 MiB"));
        }
        let next = self
            .sent
            .checked_add(1)
            .ok_or_else(|| Failure::new("CHANNEL_CLOSED", "Counter exhausted"))?;
        let mut nonce = [0u8; 12];
        nonce[4..].copy_from_slice(&self.sent.to_be_bytes());
        let body = self
            .send
            .encrypt(Nonce::from_slice(&nonce), plain.as_slice())
            .map_err(|_| Failure::new("INTEGRITY_FAILED", "Encryption failed"))?;
        let mut frame = self.sent.to_be_bytes().to_vec();
        frame.extend(body);
        self.sent = next;
        Ok(B64.encode(frame))
    }
    pub fn open(&mut self, text: &str) -> Result<Value> {
        if text.len() > MAX_FRAME {
            return Err(Failure::new("FRAME_TOO_LARGE", "Frame exceeds 16 MiB"));
        }
        let frame = B64
            .decode(text)
            .map_err(|_| Failure::new("INTEGRITY_FAILED", "Invalid frame encoding"))?;
        if frame.len() < 24 || frame.len() > MAX_FRAME {
            return Err(Failure::new("INTEGRITY_FAILED", "Invalid frame size"));
        }
        if frame[..8] != self.received.to_be_bytes() {
            return Err(Failure::new(
                "INTEGRITY_FAILED",
                "Replayed or out-of-order frame",
            ));
        }
        let mut nonce = [0u8; 12];
        nonce[4..].copy_from_slice(&frame[..8]);
        let plain = self
            .recv
            .decrypt(Nonce::from_slice(&nonce), &frame[8..])
            .map_err(|_| Failure::new("INTEGRITY_FAILED", "Invalid authentication tag"))?;
        self.received = self
            .received
            .checked_add(1)
            .ok_or_else(|| Failure::new("CHANNEL_CLOSED", "Counter exhausted"))?;
        Ok(serde_json::from_slice(&plain)?)
    }
}
pub struct Channel {
    pub socket: Socket,
    pub cipher: Cipher,
    pub peer: String,
    pub transcript: [u8; 32],
    pub stream_root: [u8; 32],
}
impl Channel {
    pub async fn connect(
        url: &str,
        identity: &SigningKey,
        device: &str,
        pairing: bool,
        pin: Option<&str>,
    ) -> Result<Self> {
        let cfg = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME))
            .max_frame_size(Some(MAX_FRAME));
        let (mut socket, _) = timeout(
            Duration::from_secs(10),
            connect_async_with_config(url, Some(cfg), false),
        )
        .await
        .map_err(|_| Failure::new("NEST_UNREACHABLE", "Connection timed out"))?
        .map_err(transport)?;
        let secret = StaticSecret::random_from_rng(OsRng);
        let mut nonce = [0u8; 16];
        OsRng.fill_bytes(&mut nonce);
        let hs1 = json!({"t":"hs1","v":1,"role":"perch","device":device,"id":public_key(identity),"eph":B64.encode(PublicKey::from(&secret).as_bytes()),"nonce":B64.encode(nonce),"pairing":pairing}).to_string();
        socket
            .send(Message::Text(hs1.clone().into()))
            .await
            .map_err(transport)?;
        let hs2_raw = timeout(Duration::from_secs(10), next_text(&mut socket))
            .await
            .map_err(|_| Failure::new("HANDSHAKE_TIMEOUT", "Nest handshake timed out"))??;
        let hs2: Value = serde_json::from_str(&hs2_raw)?;
        if hs2["t"] != "hs2" || hs2["v"] != 1 {
            return Err(Failure::new("PROTOCOL_MISMATCH", "Expected channel v1 hs2"));
        }
        let peer = hs2["id"]
            .as_str()
            .ok_or_else(|| Failure::new("HANDSHAKE_FAILED", "Missing Nest key"))?
            .to_string();
        let key: [u8; 32] = decode32(&peer)?;
        let eph = decode32(hs2["eph"].as_str().unwrap_or(""))?;
        if !pairing && Some(peer.as_str()) != pin {
            return Err(Failure::new(
                "NEST_KEY_CHANGED",
                "Nest identity differs from the pinned key. Compare fingerprints and pair again.",
            ));
        }
        let mut hash = Sha256::new();
        hash.update(b"swiftnest/handshake/v1\0");
        hash.update(hs1.as_bytes());
        hash.update(b"\0");
        hash.update(hs2_raw.as_bytes());
        let transcript: [u8; 32] = hash.finalize().into();
        let shared = secret.diffie_hellman(&PublicKey::from(eph));
        if !shared.was_contributory() {
            return Err(Failure::new(
                "HANDSHAKE_FAILED",
                "Invalid X25519 shared secret",
            ));
        }
        let mut keys = zeroize::Zeroizing::new([0u8; 64]);
        Hkdf::<Sha256>::new(Some(&transcript), shared.as_bytes())
            .expand(b"swiftnest/keys/v1", &mut *keys)
            .map_err(|_| Failure::new("HANDSHAKE_FAILED", "Key derivation failed"))?;
        let mut stream_root = [0; 32];
        Hkdf::<Sha256>::new(Some(&transcript), shared.as_bytes())
            .expand(b"swiftnest/streams/v1", &mut stream_root)
            .map_err(|_| Failure::new("BAD_STREAM", "Exporter failed"))?;
        let mut channel = Self {
            socket,
            cipher: Cipher::new(&keys[..32], &keys[32..]),
            peer,
            transcript,
            stream_root,
        };
        let mut payload = b"swiftnest/auth/v1/perch\0".to_vec();
        payload.extend(transcript);
        channel
            .send(&json!({"type":"auth","sig":B64.encode(identity.sign(&payload).to_bytes())}))
            .await?;
        let auth = timeout(Duration::from_secs(10), channel.recv())
            .await
            .map_err(|_| Failure::new("HANDSHAKE_TIMEOUT", "Authentication timed out"))??;
        let signature = B64
            .decode(auth["sig"].as_str().unwrap_or(""))
            .map_err(|_| Failure::new("AUTH_FAILED", "Bad signature encoding"))?;
        let mut payload = b"swiftnest/auth/v1/nest\0".to_vec();
        payload.extend(transcript);
        let verifying = VerifyingKey::from_bytes(&key)
            .map_err(|_| Failure::new("AUTH_FAILED", "Invalid identity key"))?;
        let sig = Signature::from_slice(&signature)
            .map_err(|_| Failure::new("AUTH_FAILED", "Invalid signature"))?;
        if auth["type"] != "auth" || verifying.verify_strict(&payload, &sig).is_err() {
            return Err(Failure::new(
                "AUTH_FAILED",
                "Nest cannot prove its identity",
            ));
        }
        Ok(channel)
    }
    pub async fn send(&mut self, value: &Value) -> Result<()> {
        self.socket
            .send(Message::Text(self.cipher.seal(value)?.into()))
            .await
            .map_err(transport)
    }
    pub async fn recv(&mut self) -> Result<Value> {
        self.cipher.open(&next_text(&mut self.socket).await?)
    }
    pub fn proof(&self, code: &str) -> Result<String> {
        if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Failure::new("BAD_ARGS", "Pairing code must be six digits"));
        }
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(code.as_bytes())
            .expect("HMAC accepts any length");
        mac.update(b"swiftnest/pair/v1\0");
        mac.update(&self.transcript);
        Ok(B64.encode(mac.finalize().into_bytes()))
    }
}
fn decode32(s: &str) -> Result<[u8; 32]> {
    B64.decode(s)
        .map_err(|_| Failure::new("HANDSHAKE_FAILED", "Invalid key encoding"))?
        .try_into()
        .map_err(|_| Failure::new("HANDSHAKE_FAILED", "Invalid key length"))
}
async fn next_text(socket: &mut Socket) -> Result<String> {
    loop {
        match socket
            .next()
            .await
            .ok_or_else(|| transport("Socket closed"))?
            .map_err(transport)?
        {
            Message::Text(t) => return Ok(t.to_string()),
            Message::Ping(_) => socket.flush().await.map_err(transport)?,
            Message::Pong(_) => {}
            Message::Close(c) => {
                let code = c
                    .as_ref()
                    .map(|c| c.reason.as_str())
                    .unwrap_or("DISCONNECTED");
                return Err(Failure::new(
                    if is_final(code) { code } else { "DISCONNECTED" },
                    "Nest closed the connection",
                ));
            }
            _ => {
                return Err(Failure::new(
                    "PROTOCOL_ERROR",
                    "Binary streams have not been negotiated",
                ))
            }
        }
    }
}
pub fn is_final(code: &str) -> bool {
    matches!(
        code,
        "REVOKED"
            | "NOT_PAIRED"
            | "NEST_KEY_CHANGED"
            | "PAIRING_REJECTED"
            | "PAIRING_CLOSED"
            | "DEVICE_NAME_TAKEN"
            | "PROTOCOL_MISMATCH"
            | "PROTOCOL_ERROR"
            | "DEVICE_DISCONNECTED"
            | "AUTH_FAILED"
            | "INTEGRITY_FAILED"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tls_provider_is_available_without_host_feature_unification() {
        let _ = rustls::ClientConfig::builder();
    }
    #[test]
    fn counters_tamper_and_cap() {
        let mut a = Cipher::new(&[1; 32], &[2; 32]);
        let mut b = Cipher::new(&[2; 32], &[1; 32]);
        let frame = a.seal(&json!({"a":1})).unwrap();
        assert_eq!(b.open(&frame).unwrap()["a"], 1);
        assert!(b.open(&frame).is_err());
        let frame = a.seal(&json!({"a":2})).unwrap();
        let mut bytes = B64.decode(&frame).unwrap();
        bytes[10] ^= 1;
        assert!(b.open(&B64.encode(bytes)).is_err());
        assert!(b.open(&"a".repeat(MAX_FRAME + 1)).is_err());
        assert!(a.seal(&json!("a".repeat(MAX_FRAME))).is_err());
    }
}
