//! GNOME/KDE: the portal chooser remains the authority. No persisted restore token.
use super::*;
use ashpd::desktop::{
    remote_desktop::{DeviceType, KeyState, RemoteDesktop},
    screencast::{CursorMode, Screencast, SourceType},
    PersistMode, Session,
};
use futures_util::StreamExt;
use std::{
    os::{fd::AsRawFd, unix::process::CommandExt},
    process::{Child, Stdio},
};
fn failure(e: impl std::fmt::Display) -> Failure {
    Failure::new(
        "PORTAL_UNAVAILABLE",
        format!("ScreenCast/RemoteDesktop portal: {e}"),
    )
}
struct PortalSession(Arc<Session<'static, RemoteDesktop<'static>>>);
impl std::ops::Deref for PortalSession {
    type Target = Session<'static, RemoteDesktop<'static>>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl Drop for PortalSession {
    fn drop(&mut self) {
        let session = self.0.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = session.close().await;
            });
        }
    }
}
type LatestFrame = Arc<Mutex<Option<(Instant, Vec<u8>)>>>;
pub struct Portal {
    remote: RemoteDesktop<'static>,
    session: PortalSession,
    pub display: Display,
    node: u32,
    child: Child,
    reader: Option<std::thread::JoinHandle<()>>,
    latest: LatestFrame,
    closed: Arc<AtomicBool>,
    watch: tokio::task::JoinHandle<()>,
}
impl Portal {
    pub fn open(stop: tokio_util::sync::CancellationToken) -> Result<Self> {
        tokio::runtime::Handle::current().block_on(async {
        tokio::select!{biased;_=stop.cancelled()=>Err(failure("Desktop session stopped")), result=tokio::time::timeout(Duration::from_secs(60),async {
        let remote=RemoteDesktop::new().await.map_err(failure)?;let cast=Screencast::new().await.map_err(failure)?;
        let session=PortalSession(Arc::new(remote.create_session().await.map_err(failure)?));
        remote.select_devices(&session,DeviceType::Keyboard|DeviceType::Pointer,None,PersistMode::DoNot).await.map_err(failure)?.response().map_err(failure)?;
        cast.select_sources(&session,CursorMode::Embedded,SourceType::Monitor.into(),false,None,PersistMode::DoNot).await.map_err(failure)?.response().map_err(failure)?;
        let response=remote.start(&session,None).await.map_err(failure)?.response().map_err(failure)?;
        if !response.devices().contains(DeviceType::Keyboard) || !response.devices().contains(DeviceType::Pointer) {return Err(failure("Owner did not grant pointer and keyboard access"));}
        let stream=response.streams().and_then(|v|v.first()).ok_or_else(||failure("No monitor selected"))?;
        let (width,height)=stream.size().ok_or_else(||failure("Portal did not return monitor size"))?;
        if width<=0 || height<=0 || width as u64*height as u64>16_000_000 {return Err(failure("Portal monitor size exceeds limit"));}
        let node=stream.pipe_wire_node_id();let display=Display{id:format!("portal-{node}"),width:width as u32,height:height as u32,scale:1.,x:0,y:0,backend:"portal-pipewire".into()};
        let fd=cast.open_pipe_wire_remote(&session).await.map_err(failure)?;let raw=fd.as_raw_fd();
        let mut command=std::process::Command::new("gst-launch-1.0");
        command.args(["-q","pipewiresrc",&format!("fd={raw}"),&format!("path={node}"),"do-timestamp=true","!","queue","leaky=downstream","max-size-buffers=1","!","videoconvert","!","videoscale","!",&format!("video/x-raw,format=RGB,width={width},height={height}"),"!","fdsink","fd=1","sync=false"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        // Only the child clears CLOEXEC on its inherited portal fd.
        unsafe {command.pre_exec(move|| {if libc::fcntl(raw,libc::F_SETFD,0)<0 {return Err(std::io::Error::last_os_error());}Ok(())});}
        let mut child=command.spawn().map_err(failure)?;let mut stdout=child.stdout.take().unwrap();
        let latest=Arc::new(Mutex::new(None));let slot=latest.clone();
        // RGB GStreamer rows are aligned to four bytes.
        let stride=(width as usize*3).div_ceil(4)*4;let size=stride*height as usize;
        let closed=Arc::new(AtomicBool::new(false));let ended=closed.clone();let watched=session.0.clone();
        let watch=tokio::spawn(async move{if let Ok(mut events)=watched.receive_closed().await{events.next().await;}ended.store(true,Ordering::SeqCst);});
        let ended=closed.clone();
        let reader=std::thread::spawn(move|| {let mut frame=vec![0;size];while stdout.read_exact(&mut frame).is_ok() {*slot.lock().unwrap()=Some((Instant::now(),frame.clone()));}ended.store(true,Ordering::SeqCst);});
        Ok(Self{remote,session,display,node,child,reader:Some(reader),latest,closed,watch})
        })=>result.map_err(|_|failure("Portal permission timed out"))?}
    })
    }
    pub fn capture(&self) -> Result<image::DynamicImage> {
        let start = Instant::now();
        loop {
            if self.closed.load(Ordering::SeqCst) {
                return Err(failure("Portal session ended"));
            }
            if let Some((_time, frame)) = &*self.latest.lock().unwrap() {
                {
                    let w = self.display.width as usize;
                    let h = self.display.height as usize;
                    let stride = (w * 3).div_ceil(4) * 4;
                    let mut rgb = Vec::with_capacity(w * h * 3);
                    for y in 0..h {
                        rgb.extend_from_slice(&frame[y * stride..y * stride + w * 3]);
                    }
                    return image::RgbImage::from_raw(w as u32, h as u32, rgb)
                        .map(image::DynamicImage::ImageRgb8)
                        .ok_or_else(|| failure("Invalid PipeWire frame"));
                }
            }
            if start.elapsed() > Duration::from_secs(5) {
                return Err(failure(
                    "No PipeWire frame. Check GStreamer pipewiresrc and portal permission.",
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    pub fn input(
        &self,
        tool: &str,
        args: &Value,
        point: Option<(u32, u32)>,
        end: Option<(u32, u32)>,
    ) -> Result<()> {
        tokio::runtime::Handle::current().block_on(async {
            if let Some((x, y)) = point {
                self.remote
                    .notify_pointer_motion_absolute(&self.session, self.node, x as f64, y as f64)
                    .await
                    .map_err(failure)?;
            }
            let button = if args["button"] == "right" {
                0x111
            } else {
                0x110
            };
            if tool == "input_click" || tool == "input_drag" {
                self.remote
                    .notify_pointer_button(&self.session, button, KeyState::Pressed)
                    .await
                    .map_err(failure)?;
                let result = if let Some((x, y)) = end {
                    self.remote
                        .notify_pointer_motion_absolute(
                            &self.session,
                            self.node,
                            x as f64,
                            y as f64,
                        )
                        .await
                } else {
                    Ok(())
                };
                let release = self
                    .remote
                    .notify_pointer_button(&self.session, button, KeyState::Released)
                    .await;
                result.map_err(failure)?;
                release.map_err(failure)?;
            }
            if tool == "input_scroll" {
                self.remote
                    .notify_pointer_axis(
                        &self.session,
                        number(args, "dx")?.clamp(-2000., 2000.),
                        number(args, "dy")?.clamp(-2000., 2000.),
                        true,
                    )
                    .await
                    .map_err(failure)?;
            }
            let key = async |sym: i32, state| {
                self.remote
                    .notify_keyboard_keysym(&self.session, sym, state)
                    .await
                    .map_err(failure)
            };
            if tool == "input_type" {
                for c in string_arg(args, "text")?.chars() {
                    let sym = if (c as u32) < 256 {
                        c as i32
                    } else {
                        0x1000000 | c as i32
                    };
                    key(sym, KeyState::Pressed).await?;
                    key(sym, KeyState::Released).await?;
                }
            }
            if tool == "input_key" {
                let mut keys = vec![];
                for name in string_arg(args, "key")?.split('+') {
                    keys.push(
                        keysym(name)
                            .ok_or_else(|| Failure::new("BAD_ARGS", "Unsupported key combo"))?,
                    );
                }
                if keys.len() > 5 {
                    return Err(Failure::new("BAD_ARGS", "Too many keys"));
                }
                let mut pressed = vec![];
                let mut error = None;
                for sym in keys {
                    match key(sym, KeyState::Pressed).await {
                        Ok(()) => pressed.push(sym),
                        Err(e) => {
                            error = Some(e);
                            break;
                        }
                    }
                }
                for sym in pressed.into_iter().rev() {
                    if let Err(e) = key(sym, KeyState::Released).await {
                        error = Some(e);
                    }
                }
                if let Some(e) = error {
                    return Err(e);
                }
            }
            Ok(())
        })
    }
}
fn keysym(name: &str) -> Option<i32> {
    Some(match name {
        "ctrl" => 0xffe3,
        "alt" => 0xffe9,
        "shift" => 0xffe1,
        "super" => 0xffeb,
        "Return" | "Enter" => 0xff0d,
        "Tab" => 0xff09,
        "Escape" => 0xff1b,
        "BackSpace" => 0xff08,
        "Delete" => 0xffff,
        "Left" => 0xff51,
        "Up" => 0xff52,
        "Right" => 0xff53,
        "Down" => 0xff54,
        "Home" => 0xff50,
        "End" => 0xff57,
        "space" => 32,
        s if s.chars().count() == 1 => s.chars().next()? as i32,
        _ => return None,
    })
}
impl Drop for Portal {
    fn drop(&mut self) {
        self.watch.abort();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
