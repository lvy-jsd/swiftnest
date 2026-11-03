use crate::{
    capability::{Capability, Classification, InvokeContext, Risk},
    channel::{is_final, Channel},
    files::Files,
    paths::PathGuard,
    screen::{Desktop, InputCapability, ScreenCapability},
    shell::Shell,
    store::{fingerprint, public_key, Settings, Store},
    stream::Offer,
    Failure, Result,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::{
    sync::{oneshot, Mutex as AsyncMutex},
    task::{JoinHandle, JoinSet},
    time::{timeout, Duration, Instant},
};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

const PLATFORM: &str = if cfg!(target_os = "android") {
    "android"
} else if cfg!(target_os = "ios") {
    "ios"
} else {
    "desktop"
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub settings: Settings,
    pub phase: String,
    pub fingerprint: String,
    pub nest_fingerprint: Option<String>,
    pub error: Option<Failure>,
    /// "desktop", "android" or "ios": the App shows the matching "This device" settings.
    pub platform: &'static str,
    pub confirmation_pending: bool,
    pub watching: bool,
    pub owner_control: bool,
}
struct Live {
    phase: String,
    nest_fingerprint: Option<String>,
    error: Option<Failure>,
    confirm: Option<oneshot::Sender<bool>>,
}
struct Run {
    cancel: CancellationToken,
    task: JoinHandle<()>,
}
pub struct Controller {
    store: Arc<Mutex<Store>>,
    live: Arc<Mutex<Live>>,
    run: AsyncMutex<Option<Run>>,
    desktop: Arc<Mutex<Arc<Desktop>>>,
    indicator_ready: std::sync::atomic::AtomicBool,
    /// Capabilities the host platform adds (e.g. Android services), offered alongside the built-in ones.
    platform: Mutex<Vec<Arc<dyn Capability>>>,
}
impl Controller {
    pub fn open(dir: impl AsRef<Path>) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            store: Arc::new(Mutex::new(Store::open(dir)?)),
            live: Arc::new(Mutex::new(Live {
                phase: "stopped".into(),
                nest_fingerprint: None,
                error: None,
                confirm: None,
            })),
            run: AsyncMutex::new(None),
            desktop: Arc::new(Mutex::new(Arc::new(Desktop::default()))),
            indicator_ready: std::sync::atomic::AtomicBool::new(false),
            platform: Mutex::new(Vec::new()),
        }))
    }
    /// Platform capabilities take effect from the next connection.
    pub fn add_platform_capabilities(&self, capabilities: Vec<Arc<dyn Capability>>) {
        self.platform.lock().unwrap().extend(capabilities);
    }
    /// Hosts must install visible observation UI before advertising screen/input.
    pub fn set_indicator_ready(&self, ready: bool) {
        self.indicator_ready
            .store(ready, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn snapshot(&self) -> Snapshot {
        let store = self.store.lock().unwrap();
        let live = self.live.lock().unwrap();
        let desktop = self.desktop.lock().unwrap().clone();
        Snapshot {
            watching: desktop.is_watching(),
            owner_control: desktop.gate.owned(),
            settings: store.settings.clone(),
            phase: live.phase.clone(),
            fingerprint: fingerprint(&public_key(&store.identity)).expect("own key"),
            nest_fingerprint: live.nest_fingerprint.clone(),
            error: live.error.clone(),
            confirmation_pending: live.confirm.is_some(),
            platform: PLATFORM,
        }
    }
    /// Changes always stop and drain the old session before publishing new permissions.
    pub async fn configure(&self, mut settings: Settings, code: Option<String>) -> Result<()> {
        if let Some(code) = &code {
            if code.len() != 6 || !code.bytes().all(|c| c.is_ascii_digit()) {
                return Err(Failure::new("BAD_ARGS", "Pairing code must be six digits"));
            }
        }
        if settings.name.trim().is_empty() || settings.name.len() > 128 {
            return Err(Failure::new(
                "BAD_ARGS",
                "Device name must have 1–128 bytes",
            ));
        }
        if settings.enabled {
            // Validation without dialing: never accept credentials or a non-WebSocket URL.
            let url = settings
                .url
                .parse::<tokio_tungstenite::tungstenite::http::Uri>()
                .map_err(|_| {
                    Failure::new(
                        "BAD_ARGS",
                        "Use ws://host:port/swiftnest or wss://host/swiftnest",
                    )
                })?;
            if !matches!(url.scheme_str(), Some("ws" | "wss"))
                || url.host().is_none()
                || settings.url.contains('@')
            {
                return Err(Failure::new(
                    "BAD_ARGS",
                    "Use a WebSocket URL without credentials",
                ));
            }
            if settings.roots.is_empty() {
                return Err(Failure::new(
                    "BAD_ARGS",
                    "Choose at least one shared folder",
                ));
            }
        }
        // Resolve roots once; protected descendants and host key storage are always denied.
        let dir = self.store.lock().unwrap().dir.clone();
        let guard = PathGuard::new(settings.roots.clone(), vec![dir]);
        settings.roots = guard
            .roots
            .iter()
            .map(|r| {
                let c = guard.check(r)?;
                if c.secret || !c.path.is_dir() {
                    return Err(Failure::new(
                        "PATH_REFUSED",
                        "Choose an existing folder outside protected storage",
                    ));
                }
                Ok(c.path)
            })
            .collect::<Result<Vec<_>>>()?;
        let mut run = self.run.lock().await;
        {
            let store = self.store.lock().unwrap();
            // Pin and slug are host-owned. A webview cannot replace trust via configuration.
            settings.nest_key = store.settings.nest_key.clone();
            settings.slug = store.settings.slug.clone();
            if settings.nest_key.is_some() && settings.url != store.settings.url && code.is_none() {
                return Err(Failure::new(
                    "BAD_ARGS",
                    "Pair again to change the Nest address",
                ));
            }
        }
        if let Some(old) = run.take() {
            old.cancel.cancel();
            let _ = old.task.await;
        }
        {
            let mut store = self.store.lock().unwrap();
            let previous = store.settings.clone();
            store.settings = settings;
            if let Err(e) = store.save() {
                store.settings = previous;
                return Err(e);
            }
        }
        self.set_phase("stopped", None);
        if self.store.lock().unwrap().settings.enabled {
            *run = Some(self.start(code));
        }
        Ok(())
    }
    pub async fn resume(&self) {
        let mut run = self.run.lock().await;
        if self.store.lock().unwrap().settings.enabled && run.is_none() {
            *run = Some(self.start(None));
        }
    }
    pub fn confirm(&self, accept: bool) -> Result<()> {
        self.live
            .lock()
            .unwrap()
            .confirm
            .take()
            .ok_or_else(|| {
                Failure::new("PAIRING_CLOSED", "No fingerprint confirmation is pending")
            })?
            .send(accept)
            .map_err(|_| Failure::new("PAIRING_CLOSED", "Pairing session ended"))
    }
    /// Emergency off is independent of unsaved names, paths or address validation.
    pub async fn disable(&self) -> Result<()> {
        let mut run = self.run.lock().await;
        if let Some(old) = run.take() {
            old.cancel.cancel();
            let _ = old.task.await;
        }
        {
            let mut store = self.store.lock().unwrap();
            store.settings.enabled = false;
            store.save()?;
        }
        self.set_phase("stopped", None);
        Ok(())
    }
    pub fn stop_view(&self) -> Result<()> {
        let mut store = self.store.lock().unwrap();
        store.settings.allow_live_view = false;
        store.save()?;
        self.desktop.lock().unwrap().stop_all();
        Ok(())
    }
    pub async fn unpair(&self) -> Result<()> {
        let mut run = self.run.lock().await;
        if let Some(old) = run.take() {
            old.cancel.cancel();
            let _ = old.task.await;
        }
        let mut store = self.store.lock().unwrap();
        store.settings.enabled = false;
        store.settings.nest_key = None;
        store.save()?;
        drop(store);
        self.set_phase("stopped", None);
        Ok(())
    }
    pub async fn shutdown(&self) {
        if let Some(old) = self.run.lock().await.take() {
            old.cancel.cancel();
            let _ = old.task.await;
        }
    }
    fn set_phase(&self, phase: &str, error: Option<Failure>) {
        let mut live = self.live.lock().unwrap();
        live.phase = phase.into();
        live.error = error;
        live.confirm = None;
        live.nest_fingerprint = None;
    }
    fn start(&self, code: Option<String>) -> Run {
        let store = self.store.clone();
        let live = self.live.clone();
        let host_desktop = self.desktop.clone();
        let screen_available = self
            .indicator_ready
            .load(std::sync::atomic::Ordering::SeqCst)
            && cfg!(any(target_os = "linux", target_os = "windows"));
        let platform = self.platform.lock().unwrap().clone();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let task = tokio::spawn(async move {
            let mut code = code;
            let mut delay = 1000u64;
            loop {
                if stop.is_cancelled() {
                    break;
                }
                {
                    let mut state = live.lock().unwrap();
                    state.phase = "connecting".into();
                    state.error = None;
                }
                let connected = tokio::select! {
                    biased;
                    _ = stop.cancelled() => break,
                    result = establish(&store, &live, code.as_deref(), screen_available, &platform) => result,
                };
                let result = match connected {
                    Ok(channel) => {
                        code = None;
                        delay = 1000;
                        {
                            let mut state = live.lock().unwrap();
                            state.phase = "online".into();
                            state.nest_fingerprint = None;
                        }
                        let (settings, dir, identity) = {
                            let s = store.lock().unwrap();
                            (s.settings.clone(), s.dir.clone(), public_key(&s.identity))
                        };
                        let guard = PathGuard::new(settings.roots, vec![dir.clone()]);
                        let transfers = crate::transfer::Transfers {
                            guard: guard.clone(),
                            dir: dir.join("transfers"),
                            identity,
                        };
                        let mut desktop = Desktop::default();
                        desktop.stop = stop.child_token();
                        let desktop = Arc::new(desktop);
                        *host_desktop.lock().unwrap() = desktop.clone();
                        session(
                            channel,
                            host_capabilities(
                                guard,
                                desktop.clone(),
                                screen_available,
                                transfers.clone(),
                                &platform,
                            ),
                            stop.clone(),
                            desktop,
                            settings.allow_live_view && screen_available,
                            settings.url,
                            transfers,
                        )
                        .await
                    }
                    Err(e) => Err(e),
                };
                if stop.is_cancelled() {
                    break;
                }
                if let Err(error) = result {
                    let final_error = is_final(&error.code) || code.is_some();
                    let mut state = live.lock().unwrap();
                    state.phase = if final_error { "stopped" } else { "offline" }.into();
                    state.error = Some(error);
                    state.confirm = None;
                    state.nest_fingerprint = None;
                    if final_error {
                        return;
                    }
                }
                let jitter = rand::random::<u64>() % (delay / 5 + 1);
                tokio::select! { _ = stop.cancelled() => break, _ = tokio::time::sleep(Duration::from_millis(delay + jitter)) => {} }
                delay = (delay * 2).min(30_000);
            }
            let mut state = live.lock().unwrap();
            state.phase = "stopped".into();
            state.confirm = None;
            state.nest_fingerprint = None;
        });
        Run { cancel, task }
    }
}
fn host_capabilities(
    guard: PathGuard,
    desktop: Arc<Desktop>,
    screen_available: bool,
    transfers: crate::transfer::Transfers,
    platform: &[Arc<dyn Capability>],
) -> Vec<Arc<dyn Capability>> {
    let mut caps: Vec<Arc<dyn Capability>> = vec![Arc::new(Files {
        guard: guard.clone(),
    })];
    // Mobile platforms have no shell we can confine, so the tool is not offered at all.
    if !cfg!(any(target_os = "android", target_os = "ios")) {
        caps.push(Arc::new(Shell { guard }));
    }
    caps.push(Arc::new(transfers));
    if screen_available {
        caps.push(Arc::new(ScreenCapability(desktop.clone())));
        caps.push(Arc::new(InputCapability(desktop)));
    }
    caps.extend(platform.iter().cloned());
    caps
}
async fn establish(
    store: &Arc<Mutex<Store>>,
    live: &Arc<Mutex<Live>>,
    code: Option<&str>,
    screen_available: bool,
    platform: &[Arc<dyn Capability>],
) -> Result<Channel> {
    let (settings, identity, dir) = {
        let store = store.lock().unwrap();
        (
            store.settings.clone(),
            store.identity.clone(),
            store.dir.clone(),
        )
    };
    if code.is_none() && settings.nest_key.is_none() {
        return Err(Failure::new(
            "NOT_PAIRED",
            "Enter the code from the server Devices page",
        ));
    }
    let mut channel = Channel::connect(
        &settings.url,
        &identity,
        &settings.slug,
        code.is_some(),
        settings.nest_key.as_deref(),
    )
    .await?;
    if let Some(code) = code {
        channel
            .send(&json!({"type":"pair","proof":channel.proof(code)?}))
            .await?;
        let status = expect(&mut channel, "pair_status", 10).await?;
        if status["status"] != "code_ok" {
            return Err(Failure::new(
                "PAIRING_REJECTED",
                "Wrong or expired pairing code.",
            ));
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut state = live.lock().unwrap();
            state.phase = "confirming".into();
            state.nest_fingerprint = Some(fingerprint(&channel.peer)?);
            state.confirm = Some(tx);
        }
        // Also watch the wire while the UI compares fingerprints, so server rejection is immediate.
        let accept = tokio::select! {
            decision = timeout(Duration::from_secs(300), rx) => decision.ok().and_then(|r| r.ok()).unwrap_or(false),
            message = channel.recv() => { let m = message?; return Err(Failure::new("PAIRING_REJECTED", m["message"].as_str().unwrap_or("Pairing ended on the server"))); },
        };
        channel
            .send(&json!({"type":"pair_confirm","accept":accept}))
            .await?;
        if !accept {
            return Err(Failure::new(
                "PAIRING_REJECTED",
                "Fingerprint was not confirmed",
            ));
        }
        let status = expect(&mut channel, "pair_status", 300).await?;
        if status["status"] != "paired" {
            return Err(Failure::new(
                "PAIRING_REJECTED",
                "Pairing was not confirmed on the server",
            ));
        }
        let mut store = store.lock().unwrap();
        store.settings.nest_key = Some(channel.peer.clone());
        store.save()?;
    }
    let guard = PathGuard::new(settings.roots, vec![dir.clone()]);
    let transfers = crate::transfer::Transfers {
        guard: guard.clone(),
        dir: dir.join("transfers"),
        identity: public_key(&identity),
    };
    let caps = host_capabilities(
        guard,
        Arc::new(Desktop::default()),
        screen_available,
        transfers,
        platform,
    )
    .iter()
    .map(|c| c.manifest())
    .collect::<Vec<_>>();
    channel.send(&json!({"type":"hello","protocol":1,"device":settings.slug,"name":settings.name,"kind":if cfg!(target_os="android") { "android" } else { "desktop" },"publicKey":public_key(&identity),"extensions":["streams-v1"],"capabilities":caps})).await?;
    expect(&mut channel, "welcome", 10).await?;
    Ok(channel)
}
async fn expect(channel: &mut Channel, kind: &str, seconds: u64) -> Result<Value> {
    let message = timeout(Duration::from_secs(seconds), channel.recv())
        .await
        .map_err(|_| Failure::new("TIMEOUT", format!("No {kind} response")))??;
    if message["type"] == "bye" {
        return Err(Failure::new(
            message["code"].as_str().unwrap_or("DISCONNECTED"),
            message["message"]
                .as_str()
                .unwrap_or("Nest closed the session"),
        ));
    }
    if message["type"] != kind {
        return Err(Failure::new("PROTOCOL_ERROR", format!("Expected {kind}")));
    }
    Ok(message)
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Incoming {
    #[serde(rename_all = "camelCase")]
    Invoke {
        task_id: String,
        capability: String,
        tool: String,
        args: serde_json::Map<String, Value>,
        timeout_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Classify {
        request_id: String,
        capability: String,
        tool: String,
        args: serde_json::Map<String, Value>,
    },
    #[serde(rename_all = "camelCase")]
    Cancel {
        task_id: String,
    },
    StreamOpen {
        #[serde(flatten)]
        offer: Box<Offer>,
    },
    StreamClose {
        id: String,
        reason: String,
    },
    Bye {
        code: String,
        message: String,
    },
}
fn lookup(caps: &[Arc<dyn Capability>], id: &str, tool: &str) -> Result<Arc<dyn Capability>> {
    caps.iter()
        .find(|c| {
            let m = c.manifest();
            m["id"] == id
                && m["tools"]
                    .as_array()
                    .is_some_and(|ts| ts.iter().any(|t| t["name"] == tool))
        })
        .cloned()
        .ok_or_else(|| Failure::new("UNKNOWN_TOOL", format!("No tool {id}.{tool}")))
}
async fn session(
    mut channel: Channel,
    caps: Vec<Arc<dyn Capability>>,
    stop: CancellationToken,
    desktop: Arc<Desktop>,
    allow_live_view: bool,
    url: String,
    transfers: crate::transfer::Transfers,
) -> Result<()> {
    let local_ip = match channel.socket.get_ref() {
        tokio_tungstenite::MaybeTlsStream::Plain(s) => s.local_addr().ok().map(|a| a.ip()),
        tokio_tungstenite::MaybeTlsStream::Rustls(s) => {
            s.get_ref().0.local_addr().ok().map(|a| a.ip())
        }
        _ => None,
    };
    let stream_root = channel.stream_root;
    let transcript = channel.transcript;
    let mut streams = JoinSet::<(String, Result<()>)>::new();
    let mut stream_stops = HashMap::<String, CancellationToken>::new();
    let (mut writer, mut reader) = channel.socket.split();
    let mut running = HashMap::<String, CancellationToken>::new();
    let mut jobs = JoinSet::new();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    let mut pong = Instant::now();
    // Every exit drains tasks. In particular disconnects never leave a shell running.
    let outcome = async {
        loop {
            tokio::select! {
                biased;
                _ = stop.cancelled() => {
                    let bye = channel.cipher.seal(&json!({"type":"bye","code":"DEVICE_DISCONNECTED","message":"Disconnected on this device."}))?;
                    let _ = timeout(Duration::from_secs(1), writer.send(Message::Text(bye.into()))).await;
                    return Ok(());
                },
                done=streams.join_next(),if !streams.is_empty()=>{
                    if let Some(Ok((id,result)))=done {stream_stops.remove(&id);let reason=result.err().map(|e:Failure|e.to_string()).unwrap_or_else(||"Viewer closed".into());
                        let msg=json!({"type":"stream_close","id":id,"reason":reason.chars().take(256).collect::<String>()});send_frame(&mut writer,Message::Text(channel.cipher.seal(&msg)?.into()),&stop).await?;}
                },
                done = jobs.join_next(), if !jobs.is_empty() => {
                    if let Some(Ok((id, response))) = done {
                        running.remove(&id);
                        send_frame(&mut writer, Message::Text(channel.cipher.seal(&response)?.into()), &stop).await?;
                    }
                },
                _ = heartbeat.tick() => {
                    if pong.elapsed() > Duration::from_secs(45) { return Err(Failure::new("DISCONNECTED", "Heartbeat timed out")); }
                    send_frame(&mut writer, Message::Ping(vec![1].into()), &stop).await?;
                },
                frame = reader.next() => {
                    let frame = frame.ok_or_else(|| Failure::new("DISCONNECTED", "Link dropped"))?.map_err(|e| Failure::new("DISCONNECTED", e.to_string()))?;
                    let text = match frame {
                        Message::Text(t) => t,
                        Message::Pong(_) => { pong = Instant::now(); continue; },
                        Message::Ping(payload) => { send_frame(&mut writer, Message::Pong(payload), &stop).await?; continue; },
                        Message::Close(c) => return Err(Failure::new(c.as_ref().map(|c| c.reason.as_str()).filter(|s| is_final(s)).unwrap_or("DISCONNECTED"), "Nest closed the link")),
                        _ => return Err(Failure::new("PROTOCOL_ERROR", "Unnegotiated binary stream")),
                    };
                    let incoming: Incoming = serde_json::from_value(channel.cipher.open(&text)?)?;
                    match incoming {
                        Incoming::StreamOpen{offer}=>{
                            let offer=*offer;
                            if offer.purpose == "file" && offer.verify(&stream_root).is_ok() && stream_stops.len() < 4 {
                                let file = offer.file.as_ref().expect("verified file offer");
                                let listener = crate::transfer::listener(file).await?;
                                let candidates: Vec<String> = listener.as_ref().and_then(|l| l.local_addr().ok()).zip(local_ip.filter(|ip| ip.is_ipv4())).map(|(a,ip)|vec![format!("ws://{}:{}/file",ip,a.port())]).unwrap_or_default();
                                let cancel=stop.child_token();stream_stops.insert(offer.id.clone(),cancel.clone());
                                let msg=json!({"type":"stream_accept","id":offer.id,"candidates":candidates});send_frame(&mut writer,Message::Text(channel.cipher.seal(&msg)?.into()),&stop).await?;
                                let host=transfers.clone();let url=url.clone();streams.spawn(async move {let id=offer.id.clone();(id,crate::transfer::run(host,url,offer,listener,cancel).await)});
                                continue;
                            }
                            if offer.purpose != "screen" || !allow_live_view || desktop.stop.is_cancelled() || !stream_stops.is_empty() || offer.verify(&stream_root).is_err() {
                                let msg=json!({"type":"stream_close","id":offer.id,"reason":"Live view is disabled, busy, or the offer is invalid"});send_frame(&mut writer,Message::Text(channel.cipher.seal(&msg)?.into()),&stop).await?;continue;
                            }
                            let cancel=stop.child_token();stream_stops.insert(offer.id.clone(),cancel.clone());
                            let msg=json!({"type":"stream_accept","id":offer.id});send_frame(&mut writer,Message::Text(channel.cipher.seal(&msg)?.into()),&stop).await?;
                            let desktop=desktop.clone();let url=url.clone();streams.spawn(async move {let id=offer.id.clone();(id,crate::screen::live::run(desktop,url,offer,stream_root,transcript,cancel).await)});
                        },
                        Incoming::StreamClose{id,reason}=>{let _=reason;if let Some(cancel)=stream_stops.remove(&id){cancel.cancel();}},
                        Incoming::Bye { code, message } => return Err(Failure::new(&code, message)),
                        Incoming::Cancel { task_id } => { if let Some(cancel) = running.get(&task_id) { cancel.cancel(); } },
                        Incoming::Classify { request_id, capability, tool, args } => {
                            let args = Value::Object(args);
                            let c = match lookup(&caps, &capability, &tool) { Ok(cap) => cap.classify(&tool, &args), Err(e) => Classification::new(Risk::Sensitive, e.to_string()) };
                            let mut reply = serde_json::to_value(c)?;
                            reply["type"] = json!("classified"); reply["requestId"] = json!(request_id);
                            send_frame(&mut writer, Message::Text(channel.cipher.seal(&reply)?.into()), &stop).await?;
                        },
                        Incoming::Invoke { task_id, capability, tool, args, timeout_ms } => {
                            if timeout_ms == 0 || timeout_ms > 3_600_000 || running.len() >= 32 || running.contains_key(&task_id) {
                                return Err(Failure::new("PROTOCOL_ERROR", "Invalid timeout, duplicate task or too many concurrent calls"));
                            }
                            let cap = lookup(&caps, &capability, &tool);
                            let cancel = CancellationToken::new(); running.insert(task_id.clone(), cancel.clone());
                            jobs.spawn(async move {
                                let context = InvokeContext { task_id: task_id.clone(), cancel: cancel.clone() };
                                let work = async { cap?.invoke(&tool, Value::Object(args), context).await };
                                let result = tokio::select! {
                                    biased;
                                    _ = cancel.cancelled() => Err(Failure::new("CANCELLED", "Cancelled by request.")),
                                    result = timeout(Duration::from_millis(timeout_ms), work) => result.unwrap_or_else(|_| Err(Failure::new("TIMEOUT", "Tool timed out; retry with a longer timeout"))),
                                };
                                cancel.cancel();
                                let response = match result {
                                    Ok(result) => json!({"type":"result","taskId":task_id,"ok":true,"result":result}),
                                    Err(error) => json!({"type":"result","taskId":task_id,"ok":false,"error":error}),
                                };
                                (task_id, response)
                            });
                        },
                    }
                },
            }
        }
    }.await;
    desktop.stop.cancel();
    for cancel in stream_stops.values() {
        cancel.cancel();
    }
    while streams.join_next().await.is_some() {}
    for cancel in running.values() {
        cancel.cancel();
    }
    while jobs.join_next().await.is_some() {}
    let d = desktop.clone();
    let _ = tokio::task::spawn_blocking(move || d.stop_all()).await;
    let _ = timeout(Duration::from_secs(1), writer.close()).await;
    outcome
}

async fn send_frame(
    writer: &mut futures_util::stream::SplitSink<crate::channel::Socket, Message>,
    message: Message,
    stop: &CancellationToken,
) -> Result<()> {
    tokio::select! {
        biased;
        _ = stop.cancelled() => Err(Failure::new("DEVICE_DISCONNECTED", "Disconnected on this device.")),
        result = timeout(Duration::from_secs(5), writer.send(message)) => {
            result.map_err(|_| Failure::new("DISCONNECTED", "Nest stopped reading the link"))?
                .map_err(|e| Failure::new("DISCONNECTED", e.to_string()))
        }
    }
}
