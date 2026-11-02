//! Reliable file records over stream-v1. One 4 MiB chunk is in flight; ACK means fsync + journal.
use crate::{
    capability::*,
    paths::PathGuard,
    stream::{Offer, StreamCipher, MAX},
    Failure, Result,
};
use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{timeout, Duration},
};
use tokio_tungstenite::{
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};
use tokio_util::sync::CancellationToken;

pub const CHUNK: usize = 4 * 1024 * 1024;
const PREFIX: usize = 1024 * 1024;
fn bad(message: impl Into<String>) -> Failure {
    Failure::new("TRANSFER_FAILED", message)
}
pub fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub size: u64,
    pub mtime: u64,
    pub prefix: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub source: String,
    pub destination: String,
    pub source_path: String,
    pub destination_path: String,
    pub meta: Metadata,
}
impl Binding {
    pub fn id(&self) -> String {
        hex(Sha256::digest(
            serde_json::to_vec(&json!([
                "swiftnest/file/v1",
                self.source,
                self.destination,
                self.source_path,
                self.destination_path,
                self.meta.size,
                self.meta.mtime,
                self.meta.prefix
            ]))
            .unwrap(),
        ))
    }
    fn validate(&self) -> Result<()> {
        if self.source.is_empty()
            || self.destination.is_empty()
            || self.source_path.is_empty()
            || self.destination_path.is_empty()
            || self.meta.size > 9_007_199_254_740_991
            || self.meta.mtime > 9_007_199_254_740_991
            || self.meta.prefix.len() != 64
            || !self.meta.prefix.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(bad("Invalid file identity"));
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub binding: Binding,
    pub offset: u64,
    pub state: String,
    pub hash: Option<String>,
    pub route: String,
}
#[derive(Clone)]
pub struct Transfers {
    pub guard: PathGuard,
    pub dir: PathBuf,
    pub identity: String,
}
impl Transfers {
    fn state_path(&self, id: &str) -> Result<PathBuf> {
        if id.len() != 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(bad("Invalid transfer id"));
        }
        Ok(self.dir.join(format!("{id}.json")))
    }
    pub fn load(&self, id: &str) -> Result<Journal> {
        Ok(serde_json::from_slice(&std::fs::read(
            self.state_path(id)?,
        )?)?)
    }
    pub fn save(&self, journal: &Journal) -> Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let mut tmp = tempfile::NamedTempFile::new_in(&self.dir)?;
        tmp.write_all(&serde_json::to_vec(journal)?)?;
        tmp.as_file().sync_all()?;
        tmp.persist(self.state_path(&journal.binding.id())?)
            .map_err(|e| bad(e.to_string()))?;
        #[cfg(unix)]
        std::fs::File::open(&self.dir)?.sync_all()?;
        Ok(())
    }
    fn target(&self, binding: &Binding) -> Result<PathBuf> {
        self.guard.allowed(Path::new(&binding.destination_path))
    }
    fn part(&self, binding: &Binding) -> Result<PathBuf> {
        let target = self.target(binding)?;
        self.guard
            .allowed(&target.with_file_name(format!(".swiftnest-{}.part", binding.id())))
    }
    fn check_binding(&self, binding: &Binding, sender: bool) -> Result<()> {
        binding.validate()?;
        if (if sender {
            &binding.source
        } else {
            &binding.destination
        }) != &self.identity
        {
            return Err(bad("Transfer belongs to a different paired identity"));
        }
        Ok(())
    }
    pub fn prepare(&self, binding: Binding) -> Result<Journal> {
        self.check_binding(&binding, false)?;
        let target = self.target(&binding)?;
        if let Ok(old) = self.load(&binding.id()) {
            if old.binding == binding {
                return Ok(old);
            }
            return Err(bad("Resume binding changed"));
        }
        if target.exists() {
            return Err(bad("Destination exists; choose another name"));
        }
        let parent = target.parent().ok_or_else(|| bad("Invalid destination"))?;
        // Existing folder only: the approval identifies exactly where the temporary file goes.
        if !parent.is_dir() {
            return Err(bad("Destination folder must exist"));
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(self.part(&binding)?)?.sync_all()?;
        let journal = Journal {
            binding,
            offset: 0,
            state: "ready".into(),
            hash: None,
            route: "relay".into(),
        };
        self.save(&journal)?;
        Ok(journal)
    }
}
pub fn inspect(path: &Path) -> Result<Metadata> {
    let m = std::fs::metadata(path)?;
    if !m.is_file() {
        return Err(bad("Source must be a regular file"));
    }
    let mut data = Vec::with_capacity(PREFIX);
    std::fs::File::open(path)?
        .take(PREFIX as u64)
        .read_to_end(&mut data)?;
    Ok(Metadata {
        size: m.len(),
        mtime: m
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| bad(e.to_string()))?
            .as_millis() as u64,
        prefix: hex(Sha256::digest(data)),
    })
}
#[async_trait]
impl Capability for Transfers {
    fn manifest(&self) -> Value {
        serde_json::from_str(include_str!("manifests/transfer.json")).unwrap()
    }
    fn classify(&self, tool: &str, args: &Value) -> Classification {
        let path = if tool == "receive" {
            args["binding"]["destinationPath"].as_str()
        } else {
            args["path"].as_str()
        };
        if let Some(path) = path {
            if self.guard.allowed(Path::new(path)).is_err() {
                return Classification::new(
                    Risk::Sensitive,
                    "Path is outside shared folders or protected and will be refused",
                );
            }
        }
        Classification::new(
            if tool == "receive" {
                Risk::Write
            } else if matches!(tool, "inspect" | "status") {
                Risk::Read
            } else {
                Risk::Sensitive
            },
            format!("File transfer {tool}: {}", args),
        )
    }
    async fn invoke(&self, tool: &str, args: Value, context: InvokeContext) -> Result<ToolResult> {
        let this = self.clone();
        let tool = tool.to_string();
        tokio::task::spawn_blocking(move || {
            if context.cancel.is_cancelled() {
                return Err(bad("Cancelled"));
            }
            let data = match tool.as_str() {
                "inspect" => serde_json::to_value(inspect(
                    &this.guard.allowed(Path::new(string_arg(&args, "path")?))?,
                )?)?,
                "receive" => serde_json::to_value(
                    this.prepare(serde_json::from_value(args["binding"].clone())?)?,
                )?,
                "status" => serde_json::to_value(this.load(string_arg(&args, "id")?)?)?,
                _ => return Err(bad("Unknown transfer tool")),
            };
            Ok(ToolResult::data("File transfer", data, false))
        })
        .await
        .map_err(|e| bad(e.to_string()))?
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOffer {
    pub binding: Binding,
    pub sender: bool,
    pub key: String,
    pub cipher_id: String,
    #[serde(default)]
    pub candidates: Vec<String>,
    pub direct_ticket: String,
    #[serde(default)]
    pub listen: bool,
}

pub async fn listener(file: &FileOffer) -> Result<Option<TcpListener>> {
    if file.sender && file.listen {
        Ok(Some(TcpListener::bind("0.0.0.0:0").await?))
    } else {
        Ok(None)
    }
}
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub async fn run(
    host: Transfers,
    url: String,
    offer: Offer,
    listener: Option<TcpListener>,
    cancel: CancellationToken,
) -> Result<()> {
    let file = offer
        .file
        .as_ref()
        .ok_or_else(|| bad("Missing file offer"))?
        .clone();
    host.check_binding(&file.binding, file.sender)?;
    let key: [u8; 32] = B64
        .decode(&file.key)
        .map_err(|_| bad("Invalid file key"))?
        .try_into()
        .map_err(|_| bad("Invalid file key"))?;
    let mut cipher = StreamCipher::new(&key, &[0; 32], &file.cipher_id, file.sender)?;
    let operation = async {
        let cfg = WebSocketConfig::default()
            .max_message_size(Some(MAX + 46))
            .max_frame_size(Some(MAX + 46));
        let mut socket = None;
        let mut route = "relay";
        if let Some(listener) = listener {
            // A random per-attempt ticket admits only the other paired endpoint. No plaintext file records.
            let ticket = file.direct_ticket.clone();
            let accept = async {
                loop {
                    let (stream, _) = listener.accept().await?;
                    let expected = format!("/file?ticket={ticket}");
                    // tungstenite fixes this callback's ErrorResponse type (it cannot be boxed).
                    #[allow(clippy::result_large_err)]
                    let admission=move |req:&tokio_tungstenite::tungstenite::handshake::server::Request,response:tokio_tungstenite::tungstenite::handshake::server::Response| {
                        if req.uri().to_string()==expected {Ok(response)} else {Err(tokio_tungstenite::tungstenite::http::Response::builder().status(403).body(Some("Forbidden".into())).unwrap())}
                    };
                    let result = timeout(
                        Duration::from_secs(1),
                        tokio_tungstenite::accept_hdr_async_with_config(
                            MaybeTlsStream::Plain(stream),
                            admission,
                            Some(cfg),
                        ),
                    )
                    .await;
                    if let Ok(Ok(ws)) = result {
                        return Ok::<Socket, Failure>(ws);
                    }
                }
            };
            if let Ok(Ok(ws)) = timeout(Duration::from_secs(4), accept).await {
                socket = Some(ws);
                route = "direct";
            }
        } else if !file.sender {
            for candidate in file.candidates.iter().take(3) {
                let uri = candidate
                    .parse::<tokio_tungstenite::tungstenite::http::Uri>()
                    .map_err(|_| bad("Invalid candidate"))?;
                if uri.scheme_str() != Some("ws")
                    || uri.path() != "/file"
                    || uri.host().is_none()
                    || candidate.contains('@')
                {
                    continue;
                }
                if let Ok(Ok((ws, _))) = timeout(
                    Duration::from_millis(800),
                    tokio_tungstenite::connect_async_with_config(
                        format!("{candidate}?ticket={}", file.direct_ticket),
                        Some(cfg),
                        false,
                    ),
                )
                .await
                {
                    socket = Some(ws);
                    route = "direct";
                    break;
                }
            }
        }
        let mut socket = match socket {
            Some(ws) => ws,
            None => {
                let address = format!(
                    "{}?stream={}&ticket={}",
                    url.split('?').next().unwrap_or(&url),
                    offer.id,
                    offer.ticket
                );
                timeout(
                    Duration::from_secs(10),
                    tokio_tungstenite::connect_async_with_config(address, Some(cfg), false),
                )
                .await
                .map_err(|_| bad("Relay timeout"))?
                .map_err(|e| bad(e.to_string()))?
                .0
            }
        };
        let outcome = if file.sender {
            send(&host, &file, &mut socket, &mut cipher).await
        } else {
            receive(&host, &file, &mut socket, &mut cipher, route).await
        };
        let _ = socket.close(None).await;
        outcome
    };
    tokio::select! { biased; _=cancel.cancelled()=>Err(bad("Paused or disconnected")), result=operation=>result }
}
async fn put(ws: &mut Socket, cipher: &mut StreamCipher, flag: u8, bytes: &[u8]) -> Result<()> {
    timeout(
        Duration::from_secs(30),
        ws.send(Message::Binary(cipher.seal(flag, bytes)?.into())),
    )
    .await
    .map_err(|_| bad("Write timeout"))?
    .map_err(|e| bad(e.to_string()))
}
async fn control(ws: &mut Socket, cipher: &mut StreamCipher, value: Value) -> Result<()> {
    put(ws, cipher, 4, &serde_json::to_vec(&value)?).await
}
async fn get(ws: &mut Socket, cipher: &mut StreamCipher) -> Result<(u8, Vec<u8>)> {
    loop {
        let msg = timeout(Duration::from_secs(1800), ws.next())
            .await
            .map_err(|_| bad("Read timeout"))?
            .ok_or_else(|| bad("Link dropped"))?
            .map_err(|e| bad(e.to_string()))?;
        match msg {
            Message::Binary(data) => return cipher.open(&data),
            Message::Ping(_) => ws.flush().await.map_err(|e| bad(e.to_string()))?,
            Message::Pong(_) => {}
            _ => return Err(bad("Link closed")),
        }
    }
}
async fn message(ws: &mut Socket, cipher: &mut StreamCipher) -> Result<Value> {
    let (flag, data) = get(ws, cipher).await?;
    if flag != 4 || data.len() > 8192 {
        return Err(bad("Expected file control record"));
    }
    Ok(serde_json::from_slice(&data)?)
}
async fn hash_prefix(file: &mut fs::File, size: u64) -> Result<Sha256> {
    file.seek(std::io::SeekFrom::Start(0)).await?;
    let mut hash = Sha256::new();
    let mut remaining = size;
    let mut buf = vec![0; 256 * 1024];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..want]).await?;
        if n == 0 {
            return Err(bad("File truncated"));
        }
        hash.update(&buf[..n]);
        remaining -= n as u64;
    }
    Ok(hash)
}
async fn send(
    host: &Transfers,
    offer: &FileOffer,
    ws: &mut Socket,
    cipher: &mut StreamCipher,
) -> Result<()> {
    let path = host.guard.allowed(Path::new(&offer.binding.source_path))?;
    if inspect(&path)? != offer.binding.meta {
        return Err(bad("Source changed; start a new transfer"));
    }
    let ready = message(ws, cipher).await?;
    if ready["type"] == "complete" {
        return Ok(());
    }
    let mut offset = ready["offset"]
        .as_u64()
        .ok_or_else(|| bad("Missing offset"))?;
    validate_offset(offset, offer.binding.meta.size)?;
    let mut input = fs::File::open(&path).await?;
    let mut hash = hash_prefix(&mut input, offset).await?;
    if ready["prefix"] != hex(hash.clone().finalize()) {
        control(ws, cipher, json!({"type":"reset"})).await?;
        return Err(bad("Partial file hash changed; retry from zero"));
    }
    let mut buffer = vec![0; CHUNK];
    while offset < offer.binding.meta.size {
        let size = (offer.binding.meta.size - offset).min(CHUNK as u64) as usize;
        input.read_exact(&mut buffer[..size]).await?;
        let mut accepted = false;
        for _ in 0..3 {
            control(ws,cipher,json!({"type":"chunk","offset":offset,"length":size,"hash":hex(Sha256::digest(&buffer[..size]))})).await?;
            put(ws, cipher, 5, &buffer[..size]).await?;
            let ack = message(ws, cipher).await?;
            if ack["type"] == "ack" && ack["offset"] == offset + size as u64 {
                accepted = true;
                break;
            }
            if ack["type"] != "retry" || ack["offset"] != offset {
                return Err(bad("Invalid acknowledgement"));
            }
        }
        if !accepted {
            return Err(bad("Repeated bad chunk"));
        }
        hash.update(&buffer[..size]);
        offset += size as u64;
    }
    if inspect(&path)? != offer.binding.meta {
        return Err(bad("Source changed during transfer"));
    }
    control(
        ws,
        cipher,
        json!({"type":"finish","hash":hex(hash.finalize())}),
    )
    .await?;
    if message(ws, cipher).await?["type"] != "complete" {
        return Err(bad("Final verification failed"));
    }
    Ok(())
}
pub fn validate_offset(offset: u64, size: u64) -> Result<()> {
    if offset > size || (offset != size && !offset.is_multiple_of(CHUNK as u64)) {
        Err(bad("Invalid acknowledged offset"))
    } else {
        Ok(())
    }
}
async fn receive(
    host: &Transfers,
    offer: &FileOffer,
    ws: &mut Socket,
    cipher: &mut StreamCipher,
    route: &str,
) -> Result<()> {
    let mut state = host.load(&offer.binding.id())?;
    if state.binding != offer.binding {
        return Err(bad("Unapproved transfer"));
    }
    if state.state == "complete" {
        control(ws, cipher, json!({"type":"complete"})).await?;
        return Ok(());
    }
    validate_offset(state.offset, state.binding.meta.size)?;
    let part = host.part(&state.binding)?;
    if state.state == "committing" && !part.exists() {
        let mut target = fs::File::open(host.target(&state.binding)?).await?;
        if state.hash.as_deref()
            != Some(
                hex(hash_prefix(&mut target, state.binding.meta.size)
                    .await?
                    .finalize())
                .as_str(),
            )
        {
            return Err(bad("Committed file hash changed"));
        }
        state.state = "complete".into();
        host.save(&state)?;
        control(ws, cipher, json!({"type":"complete","hash":state.hash})).await?;
        return Ok(());
    }
    if std::fs::symlink_metadata(&part)?.file_type().is_symlink() {
        return Err(bad("Temporary file is a symlink"));
    }
    let mut output = fs::OpenOptions::new()
        .write(true)
        .read(true)
        .open(&part)
        .await?;
    if output.metadata().await?.len() < state.offset {
        state.offset = 0;
    }
    output.set_len(state.offset).await?;
    let mut hash = hash_prefix(&mut output, state.offset).await?;
    state.route = route.into();
    state.state = "running".into();
    host.save(&state)?;
    control(
        ws,
        cipher,
        json!({"type":"ready","offset":state.offset,"prefix":hex(hash.clone().finalize())}),
    )
    .await?;
    loop {
        let message = message(ws, cipher).await?;
        if message["type"] == "reset" {
            state.offset = 0;
            state.state = "ready".into();
            output.set_len(0).await?;
            output.sync_all().await?;
            host.save(&state)?;
            return Err(bad("Resume prefix reset"));
        }
        if message["type"] == "finish" {
            if state.offset != state.binding.meta.size
                || message["hash"] != hex(hash.clone().finalize())
            {
                state.offset = 0;
                state.state = "ready".into();
                host.save(&state)?;
                return Err(bad("Whole file hash mismatch; retry from zero"));
            }
            output.sync_all().await?;
            let target = host.target(&state.binding)?;
            if target.exists() {
                return Err(bad("Destination exists; choose another name"));
            }
            state.state = "committing".into();
            state.hash = message["hash"].as_str().map(str::to_string);
            host.save(&state)?;
            // Same-folder rename publishes only a verified complete file. Same-user directory swaps
            // have the same trust boundary as files_write (see DESIGN.md).
            drop(output);
            fs::rename(&part, &target).await?;
            #[cfg(unix)]
            std::fs::File::open(target.parent().unwrap())?.sync_all()?;
            state.state = "complete".into();
            host.save(&state)?;
            control(ws, cipher, json!({"type":"complete","hash":state.hash})).await?;
            return Ok(());
        }
        let length = message["length"]
            .as_u64()
            .ok_or_else(|| bad("Missing chunk length"))?;
        let expected = (state.binding.meta.size - state.offset).min(CHUNK as u64);
        if message["type"] != "chunk"
            || message["offset"] != state.offset
            || length != expected
            || length == 0
        {
            return Err(bad("Invalid chunk offset or size"));
        }
        let (flag, data) = get(ws, cipher).await?;
        if flag != 5 || data.len() as u64 != length || message["hash"] != hex(Sha256::digest(&data))
        {
            control(ws, cipher, json!({"type":"retry","offset":state.offset})).await?;
            continue;
        }
        output.write_all(&data).await?;
        output.sync_data().await?;
        hash.update(&data);
        state.offset += length;
        host.save(&state)?;
        control(ws, cipher, json!({"type":"ack","offset":state.offset})).await?;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hash_chunk_boundaries_and_binding() {
        assert_eq!(
            hex(Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(validate_offset(CHUNK as u64, CHUNK as u64 + 1).is_ok());
        assert!(validate_offset(1, CHUNK as u64).is_err());
        assert!(validate_offset(2, 1).is_err());
        assert!(validate_offset(0, 0).is_ok());
        let mut binding = Binding {
            source: "a".into(),
            destination: "b".into(),
            source_path: "x".into(),
            destination_path: "y".into(),
            meta: Metadata {
                size: 4,
                mtime: 1,
                prefix: "0".repeat(64),
            },
        };
        let id = binding.id();
        binding.meta.mtime += 1;
        assert_ne!(id, binding.id());
        binding.meta.mtime -= 1;
        binding.destination = "c".into();
        assert_ne!(id, binding.id());
    }
    #[test]
    fn durable_approval_and_protected_resume() {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let host = Transfers {
            guard: PathGuard::new(
                vec![root.path().into()],
                vec![root.path().join("protected")],
            ),
            dir: state.path().into(),
            identity: "b".into(),
        };
        let binding = Binding {
            source: "a".into(),
            destination: "b".into(),
            source_path: "x".into(),
            destination_path: root.path().join("y").to_string_lossy().into(),
            meta: Metadata {
                size: CHUNK as u64 + 1,
                mtime: 1,
                prefix: "0".repeat(64),
            },
        };
        let mut journal = host.prepare(binding.clone()).unwrap();
        journal.offset = CHUNK as u64;
        host.save(&journal).unwrap();
        assert_eq!(host.prepare(binding.clone()).unwrap().offset, CHUNK as u64);
        let mut wrong = binding.clone();
        wrong.destination = "other".into();
        assert!(host.prepare(wrong).is_err());
        let mut denied = binding;
        denied.destination_path = root.path().join("protected/x").to_string_lossy().into();
        assert!(host.prepare(denied).is_err());
    }
    async fn socket_pair() -> (Socket, Socket) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(MaybeTlsStream::Plain(tcp))
                .await
                .unwrap()
        });
        let client = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap()
            .0;
        (client, server.await.unwrap())
    }
    #[tokio::test]
    async fn corrupt_chunk_retry_final_hash_reset_and_resume() {
        let root = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let input = root.path().join("source");
        std::fs::write(&input, b"data").unwrap();
        let binding = Binding {
            source: "a".into(),
            destination: "b".into(),
            source_path: input.to_string_lossy().into(),
            destination_path: root.path().join("destination").to_string_lossy().into(),
            meta: inspect(&input).unwrap(),
        };
        let host = Transfers {
            guard: PathGuard::new(vec![root.path().into()], vec![]),
            dir: dir.path().into(),
            identity: "b".into(),
        };
        host.prepare(binding.clone()).unwrap();
        let offer = FileOffer {
            binding: binding.clone(),
            sender: false,
            key: B64.encode([1; 32]),
            cipher_id: "ab".repeat(16),
            candidates: vec![],
            direct_ticket: "ticket".into(),
            listen: false,
        };
        let (mut client, mut server) = socket_pair().await;
        let mut sender = StreamCipher::new(&[1; 32], &[0; 32], &offer.cipher_id, true).unwrap();
        let mut receiver = StreamCipher::new(&[1; 32], &[0; 32], &offer.cipher_id, false).unwrap();
        let h = host.clone();
        let o = offer.clone();
        let task =
            tokio::spawn(async move { receive(&h, &o, &mut server, &mut receiver, "relay").await });
        assert_eq!(
            message(&mut client, &mut sender).await.unwrap()["offset"],
            0
        );
        control(
            &mut client,
            &mut sender,
            json!({"type":"chunk","offset":0,"length":4,"hash":"bad"}),
        )
        .await
        .unwrap();
        put(&mut client, &mut sender, 5, b"data").await.unwrap();
        assert_eq!(
            message(&mut client, &mut sender).await.unwrap()["type"],
            "retry"
        );
        assert_eq!(host.load(&binding.id()).unwrap().offset, 0);
        control(
            &mut client,
            &mut sender,
            json!({"type":"chunk","offset":0,"length":4,"hash":hex(Sha256::digest(b"data"))}),
        )
        .await
        .unwrap();
        put(&mut client, &mut sender, 5, b"data").await.unwrap();
        assert_eq!(
            message(&mut client, &mut sender).await.unwrap()["offset"],
            4
        );
        control(
            &mut client,
            &mut sender,
            json!({"type":"finish","hash":"incorrect"}),
        )
        .await
        .unwrap();
        assert!(task.await.unwrap().is_err());
        assert_eq!(host.load(&binding.id()).unwrap().offset, 0);
        assert!(!Path::new(&binding.destination_path).exists());
        let (mut client, mut server) = socket_pair().await;
        let mut sender = StreamCipher::new(&[2; 32], &[0; 32], &offer.cipher_id, true).unwrap();
        let mut receiver = StreamCipher::new(&[2; 32], &[0; 32], &offer.cipher_id, false).unwrap();
        let h = host.clone();
        let o = offer.clone();
        let task =
            tokio::spawn(
                async move { receive(&h, &o, &mut server, &mut receiver, "direct").await },
            );
        send(&host, &offer, &mut client, &mut sender).await.unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(std::fs::read(&binding.destination_path).unwrap(), b"data");
        assert_eq!(host.load(&binding.id()).unwrap().state, "complete");
    }
}
