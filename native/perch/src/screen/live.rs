use super::*;
use crate::stream::{Offer, StreamCipher};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};
use tokio_util::sync::CancellationToken;

struct Watching(Arc<Desktop>);
impl Drop for Watching {
    fn drop(&mut self) {
        self.0.gate.handback();
        self.0.watching.store(false, Ordering::SeqCst);
    }
}
pub async fn run(
    desktop: Arc<Desktop>,
    url: String,
    offer: Offer,
    root: [u8; 32],
    transcript: [u8; 32],
    stop: CancellationToken,
) -> Result<()> {
    offer.verify(&root)?;
    if desktop
        .watching
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(Failure::new("VIEWER_BUSY", "A viewer is already connected"));
    }
    let _watching = Watching(desktop.clone());
    let mut cipher = StreamCipher::new(&root, &transcript, &offer.id, true)?;
    let separator = if url.contains('?') { "&" } else { "?" };
    let url = format!(
        "{url}{separator}stream={}&ticket={}",
        offer.id, offer.ticket
    );
    let cfg = WebSocketConfig::default()
        .max_message_size(Some(65536))
        .max_frame_size(Some(65536))
        .max_write_buffer_size(crate::stream::MAX * 2);
    let (mut socket, _) = tokio::select! {biased;
        _=stop.cancelled()=>return Ok(()),_=desktop.stop.cancelled()=>return Ok(()),
        result=tokio::time::timeout(Duration::from_secs(10),connect_async_with_config(url,Some(cfg),false))=>result.map_err(|_|Failure::new("TIMEOUT","Stream dial timed out"))?.map_err(|e|Failure::new("DISCONNECTED",e.to_string()))?
    };
    // Owner proves possession of its directional key before the first capture leaves this machine.
    let ready = tokio::select! {biased;
        _=stop.cancelled()=>return Ok(()),_=desktop.stop.cancelled()=>return Ok(()),
        result=tokio::time::timeout(Duration::from_secs(15),socket.next())=>result.map_err(|_|Failure::new("TIMEOUT","Owner did not authenticate"))?.ok_or_else(||Failure::new("DISCONNECTED","Owner disconnected"))?.map_err(|e|Failure::new("DISCONNECTED",e.to_string()))?
    };
    let Message::Binary(ready) = ready else {
        return Err(Failure::new(
            "BAD_STREAM",
            "Expected encrypted owner authentication",
        ));
    };
    let (flag, plain) = cipher.open(&ready)?;
    if flag != 2 || serde_json::from_slice::<Value>(&plain)?["type"] != "ready" {
        return Err(Failure::new("BAD_STREAM", "Owner authentication failed"));
    }
    let mut interval = tokio::time::interval(Duration::from_millis(80));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut quality = 75u8;
    let mut previous = Vec::new();
    let mut frame_number = 0u64;
    let mut pending: Option<(u64, Instant)> = None;
    let mut last_input = Instant::now();
    let mut input_count = 0u32;
    let mut captures = tokio::task::JoinSet::<Result<Frame>>::new();
    let outcome=async { loop {
        tokio::select! {biased;
            _=stop.cancelled()=>break,
            _=desktop.stop.cancelled()=>break,
            message=socket.next()=>{
                let Some(Ok(Message::Binary(bytes)))=message else{break;};
                let (flag,plain)=cipher.open(&bytes)?;if flag!=2 {return Err(Failure::new("BAD_STREAM","Only owner input records are accepted"));}
                if last_input.elapsed()>Duration::from_secs(1) {last_input=Instant::now();input_count=0;}input_count+=1;
                if input_count>120 {return Err(Failure::new("BAD_STREAM","Owner input rate exceeded"));}
                let event:Value=serde_json::from_slice(&plain)?;
                if event["type"]=="frame_ack" {
                    let Some((seq,started))=pending.take() else{return Err(Failure::new("BAD_STREAM","Unexpected frame acknowledgement"));};
                    if event["frame"].as_u64()!=Some(seq) {return Err(Failure::new("BAD_STREAM","Invalid frame acknowledgement"));}
                    let elapsed=started.elapsed();
                    quality=if elapsed>Duration::from_millis(150){quality.saturating_sub(10).max(35)}else{quality.saturating_add(1).min(80)};
                    let period=elapsed.clamp(Duration::from_millis(80),Duration::from_secs(1));interval=tokio::time::interval_at(tokio::time::Instant::now()+period,period);interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);continue;
                }
                let d=desktop.clone();
                let result=tokio::task::spawn_blocking(move||match event["type"].as_str() {
                    Some("takeover")=>{d.gate.takeover();Ok(())},
                    Some("handback")=>{d.gate.handback();Ok(())},
                    Some("input")=>d.input(string_arg(&event,"tool")?,&event["args"],true),
                    _=>Err(Failure::new("BAD_STREAM","Unknown owner event"))
                }).await.map_err(|e|Failure::new("INPUT_FAILED",e.to_string()))?;
                let state=json!({"control":if desktop.gate.owned(){"owner"}else{"ivy"},"error":result.err()});
                send(&mut socket,cipher.seal(3,&serde_json::to_vec(&state)?)?,&stop).await?;
            },
            captured=captures.join_next(),if !captures.is_empty()=>{
                let mut frame=captured.ok_or_else(||Failure::new("CAPTURE_FAILED","Capture task ended"))?.map_err(|e|Failure::new("CAPTURE_FAILED",e.to_string()))??;
                let hash=frame.hash.to_vec();if hash==previous {continue;}previous=hash;
                frame_number+=1;frame.metadata["frameSeq"]=json!(frame_number);
                let meta=serde_json::to_vec(&frame.metadata)?;let mut payload=(meta.len() as u32).to_be_bytes().to_vec();payload.extend(meta);payload.extend(frame.bytes);
                pending=Some((frame_number,Instant::now()));
                send(&mut socket,cipher.seal(1,&payload)?,&stop).await?;
            },
            _=interval.tick()=>{
                if let Some((_,started))=pending {if started.elapsed()>Duration::from_secs(5){return Err(Failure::new("TIMEOUT","Viewer stopped acknowledging frames"));}continue;}
                if !captures.is_empty(){continue;}
                let d=desktop.clone();let args=json!({"displayId":offer.display_id,"maxDimension":offer.max_dimension});
                captures.spawn(async move{tokio::task::spawn_blocking(move||d.capture(&args,quality)).await.map_err(|e|Failure::new("CAPTURE_FAILED",e.to_string()))?});
            }

        }
    }
    Ok(()) }.await;
    while captures.join_next().await.is_some() {}
    let _ = socket.close(None).await;
    outcome
}
async fn send(
    socket: &mut crate::channel::Socket,
    bytes: Vec<u8>,
    stop: &CancellationToken,
) -> Result<()> {
    tokio::select! {biased;_=stop.cancelled()=>Err(Failure::new("CANCELLED","Viewer stopped")),result=tokio::time::timeout(Duration::from_secs(3),socket.send(Message::Binary(bytes.into())))=>result.map_err(|_|Failure::new("TIMEOUT","Viewer is too slow"))?.map_err(|e|Failure::new("DISCONNECTED",e.to_string()))}
}
