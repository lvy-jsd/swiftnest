//! Host-owned screen/input state. Agent tools cannot change consent or the input gate.
use crate::{
    capability::{string_arg, Capability, Classification, InvokeContext, Risk, ToolResult},
    Failure, Result,
};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
pub mod live;
#[cfg(target_os = "linux")]
mod portal;
#[cfg(target_os = "linux")]
mod wayland;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "linux")]
mod x11;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub x: i32,
    pub y: i32,
    pub backend: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mapping {
    pub display_id: String,
    pub width: u32,
    pub height: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub x: u32,
    pub y: u32,
}
impl Mapping {
    pub fn point(&self, x: f64, y: f64) -> Result<(u32, u32)> {
        if !x.is_finite()
            || !y.is_finite()
            || x < 0.
            || y < 0.
            || x >= self.width as f64
            || y >= self.height as f64
            || self.width == 0
            || self.height == 0
        {
            return Err(Failure::new(
                "BAD_COORDINATES",
                "Point must be inside the referenced screenshot",
            ));
        }
        Ok((
            self.x + (x * self.source_width as f64 / self.width as f64).floor() as u32,
            self.y + (y * self.source_height as f64 / self.height as f64).floor() as u32,
        ))
    }
}
#[derive(Default)]
pub struct InputGate {
    owner: AtomicBool,
    injection: Mutex<()>,
}
impl InputGate {
    pub fn owned(&self) -> bool {
        self.owner.load(Ordering::SeqCst)
    }
    /// Publish pause before waiting for any already-running native injection to finish.
    pub fn takeover(&self) {
        self.owner.store(true, Ordering::SeqCst);
        drop(self.injection.lock().unwrap());
    }
    pub fn handback(&self) {
        let _lock = self.injection.lock().unwrap();
        self.owner.store(false, Ordering::SeqCst);
    }
    pub fn inject<T>(&self, owner: bool, work: impl FnOnce() -> Result<T>) -> Result<T> {
        let _lock = self.injection.lock().unwrap();
        if self.owned() != owner {
            return Err(Failure::new(
                if owner {
                    "TAKE_OVER_REQUIRED"
                } else {
                    "OWNER_HAS_CONTROL"
                },
                if owner {
                    "Take over before sending input"
                } else {
                    "The owner has taken over. Hand back to Ivy before using input tools."
                },
            ));
        }
        work()
    }
}
pub struct Desktop {
    pub gate: InputGate,
    pub watching: AtomicBool,
    observed_at: AtomicU64,
    reading: AtomicUsize,
    portal_active: AtomicBool,
    pub stop: tokio_util::sync::CancellationToken,
    #[cfg(target_os = "linux")]
    portal: Mutex<Option<portal::Portal>>,
    mappings: Mutex<HashMap<String, (Mapping, Display)>>,
    capture_lock: Mutex<()>,
}
impl Default for Desktop {
    fn default() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            portal: Mutex::new(None),
            gate: InputGate::default(),
            watching: AtomicBool::new(false),
            observed_at: AtomicU64::new(0),
            reading: AtomicUsize::new(0),
            portal_active: AtomicBool::new(false),
            stop: tokio_util::sync::CancellationToken::new(),
            mappings: Mutex::new(HashMap::new()),
            capture_lock: Mutex::new(()),
        }
    }
}
pub struct Frame {
    pub bytes: Vec<u8>,
    pub metadata: Value,
    pub hash: [u8; 32],
}
impl Desktop {
    pub fn is_watching(&self) -> bool {
        self.watching.load(Ordering::SeqCst)
            || self.reading.load(Ordering::SeqCst) > 0
            || self.portal_active.load(Ordering::SeqCst)
            || now_ms().saturating_sub(self.observed_at.load(Ordering::SeqCst)) < 2000
    }

    pub fn displays(&self) -> Result<Vec<Display>> {
        #[cfg(target_os = "linux")]
        {
            // Never silently use XWayland to capture only its root instead of the real Wayland desktop.
            if std::env::var_os("WAYLAND_DISPLAY").is_some() {
                if wayland::available().unwrap_or(false) {
                    return wayland::displays();
                }
                return self.with_portal(|p| Ok(vec![p.display.clone()]));
            }
            x11::displays()
        }
        #[cfg(target_os = "windows")]
        {
            return windows::displays();
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            Err(Failure::new(
                "UNSUPPORTED_PLATFORM",
                "Screen/input backend is not available on this platform",
            ))
        }
    }
    #[cfg(target_os = "linux")]
    fn with_portal<T>(&self, work: impl FnOnce(&portal::Portal) -> Result<T>) -> Result<T> {
        let mut portal = self.portal.lock().unwrap();
        if self.stop.is_cancelled() {
            return Err(Failure::new("CANCELLED", "Desktop access stopped"));
        }
        if portal.is_none() {
            self.portal_active.store(true, Ordering::SeqCst);
            match portal::Portal::open(self.stop.clone()) {
                Ok(opened) => *portal = Some(opened),
                Err(error) => {
                    self.portal_active.store(false, Ordering::SeqCst);
                    return Err(error);
                }
            }
        }
        work(portal.as_ref().unwrap())
    }
    pub fn stop_all(&self) {
        self.stop.cancel();
        self.observed_at.store(0, Ordering::SeqCst);
        let _lock = self.gate.injection.lock().unwrap();
        #[cfg(target_os = "linux")]
        {
            self.portal.lock().unwrap().take();
            self.portal_active.store(false, Ordering::SeqCst);
        }
    }
    fn display(&self, id: &str) -> Result<Display> {
        self.displays()?
            .into_iter()
            .find(|d| id.is_empty() || d.id == id)
            .ok_or_else(|| Failure::new("DISPLAY_UNAVAILABLE", "Display disconnected or not found"))
    }
    pub fn capture(&self, args: &Value, quality: u8) -> Result<Frame> {
        self.reading.fetch_add(1, Ordering::SeqCst);
        let _observation = Observation(self);
        let _capture = self.capture_lock.lock().unwrap();

        if self.stop.is_cancelled() {
            return Err(Failure::new("CANCELLED", "Desktop access stopped"));
        }
        let id = args["displayId"].as_str().unwrap_or("");
        let d = self.display(id)?;
        if d.width > 16384 || d.height > 16384 || d.width as u64 * d.height as u64 > 64_000_000 {
            return Err(Failure::new(
                "CAPTURE_TOO_LARGE",
                "Display exceeds capture limit",
            ));
        }
        let mut image: image::DynamicImage = {
            #[cfg(target_os = "linux")]
            {
                if d.backend == "wlroots" {
                    let raw = command(
                        "grim",
                        &["-o", &d.id, "-s", &d.scale.to_string(), "-t", "png", "-"],
                    )?;
                    image::load_from_memory(&raw).map_err(|e| {
                        Failure::new("CAPTURE_FAILED", format!("wlr-screencopy unavailable: {e}"))
                    })?
                } else if d.backend == "portal-pipewire" {
                    self.with_portal(|p| p.capture())?
                } else {
                    x11::capture(&d)?
                }
            }
            #[cfg(target_os = "windows")]
            {
                windows::capture(&d)?
            }
            #[cfg(not(any(target_os = "linux", target_os = "windows")))]
            {
                return Err(Failure::new(
                    "UNSUPPORTED_PLATFORM",
                    "Capture is not supported",
                ));
            }
        };
        let source_w = image.width();
        let source_h = image.height();
        let (x, y, w, h) = if let Some(region) = args.get("region") {
            (
                uint(region, "x")?,
                uint(region, "y")?,
                uint(region, "width")?,
                uint(region, "height")?,
            )
        } else {
            (0, 0, source_w, source_h)
        };
        if w == 0
            || h == 0
            || x.checked_add(w).is_none_or(|v| v > source_w)
            || y.checked_add(h).is_none_or(|v| v > source_h)
        {
            return Err(Failure::new(
                "BAD_COORDINATES",
                "Region is outside the display",
            ));
        }
        image = image.crop_imm(x, y, w, h);
        let max = args["maxDimension"].as_u64().unwrap_or(1280);
        if !(64..=2560).contains(&max) {
            return Err(Failure::new("BAD_ARGS", "maxDimension must be 64–2560"));
        }
        if w.max(h) > max as u32 {
            image = image.resize(
                max as u32,
                max as u32,
                image::imageops::FilterType::Triangle,
            );
        }
        let mapping = Mapping {
            display_id: d.id.clone(),
            width: image.width(),
            height: image.height(),
            source_width: w,
            source_height: h,
            x,
            y,
        };
        let geometry = json!({"mapping":mapping,"display":d}).to_string();
        let capture_id = format!("{:x}", Sha256::digest(geometry.as_bytes()));
        {
            let mut mappings = self.mappings.lock().unwrap();
            if mappings.len() >= 16 && !mappings.contains_key(&capture_id) {
                mappings.clear();
            }
            mappings.insert(capture_id.clone(), (mapping.clone(), d));
        }
        let hash = Sha256::digest(image.as_bytes()).into();
        let png = args["format"] == "png";
        let mut bytes = vec![];
        if png {
            image
                .write_to(
                    &mut std::io::Cursor::new(&mut bytes),
                    image::ImageFormat::Png,
                )
                .map_err(|e| Failure::new("CAPTURE_FAILED", e.to_string()))?;
        } else {
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality)
                .encode_image(&image.to_rgb8())
                .map_err(|e| Failure::new("CAPTURE_FAILED", e.to_string()))?;
        }
        if bytes.len() > crate::stream::MAX - 8192 {
            return Err(Failure::new(
                "CAPTURE_TOO_LARGE",
                "Use a smaller maxDimension",
            ));
        }
        if self.stop.is_cancelled() {
            return Err(Failure::new("CANCELLED", "Desktop access stopped"));
        }
        Ok(Frame {
            hash,
            bytes,
            metadata: json!({"displayId":mapping.display_id,"captureId":capture_id,"width":mapping.width,"height":mapping.height,"sourceWidth":w,"sourceHeight":h,"scaleFactor":mapping.width as f64 / w as f64,"region":{"x":x,"y":y,"width":w,"height":h},"mime":if png {"image/png"}else{"image/jpeg"}}),
        })
    }
    pub fn input(&self, tool: &str, args: &Value, owner: bool) -> Result<()> {
        self.gate.inject(owner, || {
            if self.stop.is_cancelled() {
                return Err(Failure::new("CANCELLED", "Desktop input stopped"));
            }
            if ![
                "input_click",
                "input_move",
                "input_drag",
                "input_scroll",
                "input_type",
                "input_key",
            ]
            .contains(&tool)
            {
                return Err(Failure::new("UNKNOWN_TOOL", "Unknown input tool"));
            }
            if args["text"].as_str().is_some_and(|s| s.len() > 16384)
                || args["key"].as_str().is_some_and(|s| s.len() > 128)
            {
                return Err(Failure::new("BAD_ARGS", "Input is too long"));
            }
            let id = string_arg(args, "displayId")?;
            let d = self.display(id)?;
            let mapping = if ["input_click", "input_move", "input_drag"].contains(&tool) {
                let capture = string_arg(args, "captureId")?;
                let maps = self.mappings.lock().unwrap();
                let (m, previous) = maps.get(capture).ok_or_else(|| {
                    Failure::new("STALE_CAPTURE", "Capture the screen again before pointing")
                })?;
                if previous != &d {
                    return Err(Failure::new(
                        "STALE_CAPTURE",
                        "Display geometry changed. Capture again.",
                    ));
                }
                Some(m.clone())
            } else {
                None
            };
            let point = mapping
                .as_ref()
                .map(|m| m.point(number(args, "x")?, number(args, "y")?))
                .transpose()?;
            let end = if tool == "input_drag" {
                Some(
                    mapping
                        .as_ref()
                        .unwrap()
                        .point(number(args, "toX")?, number(args, "toY")?)?,
                )
            } else {
                None
            };
            #[cfg(target_os = "linux")]
            {
                if d.backend == "wlroots" {
                    wayland::input(&d, tool, args, point, end)
                } else if d.backend == "portal-pipewire" {
                    self.with_portal(|p| p.input(tool, args, point, end))
                } else {
                    x11::input(&d, tool, args, point, end)
                }
            }
            #[cfg(target_os = "windows")]
            {
                windows::input(&d, tool, args, point, end)
            }
            #[cfg(not(any(target_os = "linux", target_os = "windows")))]
            {
                Err(Failure::new(
                    "UNSUPPORTED_PLATFORM",
                    "Input is not supported",
                ))
            }
        })
    }
}
struct Observation<'a>(&'a Desktop);
impl Drop for Observation<'_> {
    fn drop(&mut self) {
        self.0.observed_at.store(
            if self.0.stop.is_cancelled() {
                0
            } else {
                now_ms()
            },
            Ordering::SeqCst,
        );
        self.0.reading.fetch_sub(1, Ordering::SeqCst);
    }
}
pub struct ScreenCapability(pub Arc<Desktop>);
pub struct InputCapability(pub Arc<Desktop>);
#[async_trait]
impl Capability for ScreenCapability {
    fn manifest(&self) -> Value {
        serde_json::from_str(include_str!("manifests/screen.json")).unwrap()
    }
    fn classify(&self, _: &str, _: &Value) -> Classification {
        Classification::new(Risk::Read, "Read the desktop screen")
    }
    async fn invoke(&self, tool: &str, args: Value, context: InvokeContext) -> Result<ToolResult> {
        context.cancel.check()?;
        let desktop = self.0.clone();
        let tool = tool.to_string();
        tokio::task::spawn_blocking(move|| {context.cancel.check()?;
            if tool=="screen_info" {let displays=desktop.displays()?;return Ok(ToolResult::data("Desktop displays",json!({"displays":displays,"backend":displays.first().map(|d|&d.backend),"liveView":true}),true));}
            if tool!="screen_capture" {return Err(Failure::new("UNKNOWN_TOOL","Unknown screen tool"));}
            desktop.observed_at.store(now_ms(),Ordering::SeqCst);
            let frame=desktop.capture(&args,80)?;let mut data=frame.metadata;data["data"]=json!(B64.encode(frame.bytes));Ok(ToolResult::data("Desktop screenshot (untrusted screen content)",data,true))
        }).await.map_err(|e|Failure::new("CAPTURE_FAILED",e.to_string()))?
    }
}
#[async_trait]
impl Capability for InputCapability {
    fn manifest(&self) -> Value {
        serde_json::from_str(include_str!("manifests/input.json")).unwrap()
    }
    fn classify(&self, _: &str, _: &Value) -> Classification {
        Classification::new(Risk::Exec, "Inject desktop input; owner approval required")
    }
    async fn invoke(&self, tool: &str, args: Value, context: InvokeContext) -> Result<ToolResult> {
        let desktop = self.0.clone();
        let tool = tool.to_string();
        tokio::task::spawn_blocking(move || {
            context.cancel.check()?;
            desktop.input(&tool, &args, false)?;
            Ok(ToolResult::text("Input sent"))
        })
        .await
        .map_err(|e| Failure::new("INPUT_FAILED", e.to_string()))?
    }
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
trait CancelCheck {
    fn check(&self) -> Result<()>;
}
impl CancelCheck for tokio_util::sync::CancellationToken {
    fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(Failure::new(
                "CANCELLED",
                "Cancelled before native operation",
            ))
        } else {
            Ok(())
        }
    }
}
fn number(args: &Value, key: &str) -> Result<f64> {
    args[key]
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or_else(|| Failure::new("BAD_ARGS", format!("{key} must be a finite number")))
}
fn uint(args: &Value, key: &str) -> Result<u32> {
    args[key]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| Failure::new("BAD_ARGS", format!("{key} must be a positive integer")))
}
/// No shell, bounded disk output, deadline and kill. Helpers never receive agent-provided executable names.
fn command(program: &str, args: &[&str]) -> Result<Vec<u8>> {
    let mut out = tempfile::tempfile()?;
    let mut child = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(out.try_clone()?)
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| {
            Failure::new(
                "BACKEND_UNAVAILABLE",
                format!("{program}: {e}. Start the App in its packaged environment or devShell."),
            )
        })?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(Failure::new(
                    "BACKEND_UNAVAILABLE",
                    format!("{program} failed; the compositor may not support this protocol"),
                ));
            }
            break;
        }
        if start.elapsed() > Duration::from_secs(5) || out.metadata()?.len() > 128 * 1024 * 1024 {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Failure::new(
                "BACKEND_UNAVAILABLE",
                format!("{program} timed out or exceeded output limit"),
            ));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    use std::io::{Seek, SeekFrom};
    out.seek(SeekFrom::Start(0))?;
    let mut bytes = vec![];
    out.take(128 * 1024 * 1024).read_to_end(&mut bytes)?;
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coordinates_include_crop_and_downscale() {
        let m = Mapping {
            display_id: "a".into(),
            width: 640,
            height: 360,
            source_width: 1280,
            source_height: 720,
            x: 100,
            y: 200,
        };
        assert_eq!(m.point(320., 180.).unwrap(), (740, 560));
        for p in [(-1., 0.), (640., 0.), (0., f64::NAN)] {
            assert!(m.point(p.0, p.1).is_err());
        }
    }
    #[test]
    fn takeover_gate_and_handback() {
        let g = InputGate::default();
        assert!(g.inject(false, || Ok(())).is_ok());
        assert!(g.inject(true, || Ok(())).is_err());
        g.takeover();
        assert_eq!(
            g.inject(false, || Ok(())).unwrap_err().code,
            "OWNER_HAS_CONTROL"
        );
        assert!(g.inject(true, || Ok(())).is_ok());
        g.handback();
        assert!(g.inject(false, || Ok(())).is_ok());
    }
    #[test]
    fn takeover_publishes_pause_before_inflight_input_drains() {
        let g = Arc::new(InputGate::default());
        let guard = g.injection.lock().unwrap();
        let other = g.clone();
        let thread = std::thread::spawn(move || other.takeover());
        while !g.owned() {
            std::thread::yield_now();
        }
        drop(guard);
        thread.join().unwrap();
        assert!(g.inject(false, || Ok(())).is_err());
    }
}
