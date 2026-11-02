//! wl_output discovery and zwlr_virtual_pointer_v1. Keyboard uses wtype's virtual keyboard implementation.
use super::*;
use wayland_client::{
    protocol::{wl_output, wl_registry},
    Connection, Dispatch, Proxy, QueueHandle, WEnum,
};
use wayland_protocols::xdg::xdg_output::zv1::client::{
    zxdg_output_manager_v1 as xdg_manager, zxdg_output_v1 as xdg_output,
};
use wayland_protocols_wlr::virtual_pointer::v1::client::{
    zwlr_virtual_pointer_manager_v1 as manager, zwlr_virtual_pointer_v1 as pointer,
};
#[derive(Default)]
struct State {
    outputs: Vec<(wl_output::WlOutput, Display)>,
    capture: bool,
    xdg: Option<xdg_manager::ZxdgOutputManagerV1>,
    logical: HashMap<wayland_client::backend::ObjectId, (i32, i32)>,
    rotated: std::collections::HashSet<wayland_client::backend::ObjectId>,
    keyboard: bool,
    manager: Option<manager::ZwlrVirtualPointerManagerV1>,
}
impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            if interface == "zxdg_output_manager_v1" {
                state.xdg = Some(registry.bind(name, version.min(3), qh, ()));
            }
            if interface == "zwlr_screencopy_manager_v1"
                || interface == "ext_image_copy_capture_manager_v1"
            {
                state.capture = true;
            }
            if interface == "zwp_virtual_keyboard_manager_v1" {
                state.keyboard = true;
            }
            if interface == "wl_output" {
                let output =
                    registry.bind::<wl_output::WlOutput, _, _>(name, version.min(4), qh, ());
                state.outputs.push((
                    output,
                    Display {
                        id: format!("output-{name}"),
                        width: 0,
                        height: 0,
                        scale: 1.,
                        x: 0,
                        y: 0,
                        backend: "wlroots".into(),
                    },
                ));
            }
            if interface == "zwlr_virtual_pointer_manager_v1" {
                state.manager = Some(registry.bind(name, version.min(2), qh, ()));
            }
        }
    }
}
impl Dispatch<wl_output::WlOutput, ()> for State {
    fn event(
        state: &mut Self,
        proxy: &wl_output::WlOutput,
        event: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some((_, d)) = state.outputs.iter_mut().find(|(p, _)| p == proxy) else {
            return;
        };
        match event {
            wl_output::Event::Geometry {
                x, y, transform, ..
            } => {
                if matches!(
                    transform,
                    WEnum::Value(
                        wl_output::Transform::_90
                            | wl_output::Transform::_270
                            | wl_output::Transform::Flipped90
                            | wl_output::Transform::Flipped270
                    )
                ) {
                    state.rotated.insert(proxy.id());
                }
                d.x = x;
                d.y = y;
            }
            wl_output::Event::Mode {
                flags: WEnum::Value(flags),
                width,
                height,
                ..
            } if flags.contains(wl_output::Mode::Current) => {
                (d.width, d.height) = if state.rotated.contains(&proxy.id()) {
                    (height as u32, width as u32)
                } else {
                    (width as u32, height as u32)
                };
            }
            wl_output::Event::Scale { factor } => d.scale = factor.max(1) as f64,
            wl_output::Event::Name { name } => d.id = name,
            _ => {}
        }
    }
}
impl Dispatch<xdg_manager::ZxdgOutputManagerV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &xdg_manager::ZxdgOutputManagerV1,
        _: xdg_manager::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<xdg_output::ZxdgOutputV1, wl_output::WlOutput> for State {
    fn event(
        s: &mut Self,
        _: &xdg_output::ZxdgOutputV1,
        e: xdg_output::Event,
        output: &wl_output::WlOutput,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some((_, d)) = s.outputs.iter_mut().find(|(p, _)| p == output) else {
            return;
        };
        match e {
            xdg_output::Event::LogicalSize { width, height } => {
                s.logical.insert(output.id(), (width, height));
            }
            xdg_output::Event::LogicalPosition { x, y } => {
                d.x = x;
                d.y = y;
            }
            xdg_output::Event::Name { name } => d.id = name,
            _ => {}
        }
    }
}
impl Dispatch<manager::ZwlrVirtualPointerManagerV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &manager::ZwlrVirtualPointerManagerV1,
        _: manager::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<pointer::ZwlrVirtualPointerV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &pointer::ZwlrVirtualPointerV1,
        _: pointer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
fn connect() -> Result<(Connection, wayland_client::EventQueue<State>, State)> {
    let conn = Connection::connect_to_env()
        .map_err(|e| Failure::new("BACKEND_UNAVAILABLE", e.to_string()))?;
    let mut queue = conn.new_event_queue();
    let qh = queue.handle();
    conn.display().get_registry(&qh, ());
    let mut state = State::default();
    queue
        .roundtrip(&mut state)
        .map_err(|e| Failure::new("BACKEND_UNAVAILABLE", e.to_string()))?;
    if let Some(manager) = &state.xdg {
        for (output, _) in &state.outputs {
            manager.get_xdg_output(output, &qh, output.clone());
        }
    }
    queue
        .roundtrip(&mut state)
        .map_err(|e| Failure::new("BACKEND_UNAVAILABLE", e.to_string()))?;
    Ok((conn, queue, state))
}
pub fn displays() -> Result<Vec<Display>> {
    let (_, _, s) = connect()?;
    Ok(s.outputs
        .into_iter()
        .map(|(output, mut d)| {
            if let Some((w, _)) = s.logical.get(&output.id()) {
                if *w > 0 {
                    d.scale = d.width as f64 / (*w as f64);
                }
            }
            d
        })
        .filter(|d| d.width > 0 && d.height > 0)
        .collect())
}
pub fn input(
    d: &Display,
    tool: &str,
    args: &Value,
    point: Option<(u32, u32)>,
    end: Option<(u32, u32)>,
) -> Result<()> {
    if tool == "input_type" {
        let text = string_arg(args, "text")?;
        return command("wtype", &["--", text]).map(|_| ());
    }
    if tool == "input_key" {
        let keys = string_arg(args, "key")?;
        let parts = keys.split('+').collect::<Vec<_>>();
        if parts.len() > 5
            || parts
                .iter()
                .any(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        {
            return Err(Failure::new(
                "BAD_ARGS",
                "Use a key or combo such as ctrl+c",
            ));
        }
        let mut a = vec![];
        for modifier in &parts[..parts.len() - 1] {
            if !["ctrl", "alt", "shift", "super", "logo"].contains(modifier) {
                return Err(Failure::new("BAD_ARGS", "Unknown modifier"));
            }
            a.extend(["-M", *modifier]);
        }
        a.extend(["-k", parts[parts.len() - 1]]);
        return command("wtype", &a).map(|_| ());
    }
    let (_conn, mut q, s) = connect()?;
    let m = s.manager.as_ref().ok_or_else(|| {
        Failure::new(
            "BACKEND_UNAVAILABLE",
            "Compositor lacks virtual pointer; RemoteDesktop portal required",
        )
    })?;
    let output = s
        .outputs
        .iter()
        .find(|(_, out)| out.id == d.id)
        .map(|(p, _)| p);
    if m.version() < 2 {
        return Err(Failure::new(
            "BACKEND_UNAVAILABLE",
            "Output-bound virtual pointer v2 required",
        ));
    }
    let p = m.create_virtual_pointer_with_output(None, output, &q.handle(), ());
    let motion = |x, y| {
        p.motion_absolute(0, x, y, d.width, d.height);
        p.frame();
    };
    if let Some((x, y)) = point {
        motion(x, y);
    }
    let button = if args["button"] == "right" {
        0x111
    } else {
        0x110
    };
    if tool == "input_click" || tool == "input_drag" {
        p.button(
            0,
            button,
            wayland_client::protocol::wl_pointer::ButtonState::Pressed,
        );
        p.frame();
        if let Some((x, y)) = end {
            motion(x, y);
        }
        p.button(
            0,
            button,
            wayland_client::protocol::wl_pointer::ButtonState::Released,
        );
        p.frame();
    }
    if tool == "input_scroll" {
        let dx = number(args, "dx")?.clamp(-2000., 2000.);
        let dy = number(args, "dy")?.clamp(-2000., 2000.);
        p.axis(
            0,
            wayland_client::protocol::wl_pointer::Axis::VerticalScroll,
            dy,
        );
        p.axis(
            0,
            wayland_client::protocol::wl_pointer::Axis::HorizontalScroll,
            dx,
        );
        p.frame();
    }
    let mut state = s;
    q.roundtrip(&mut state)
        .map_err(|e| Failure::new("INPUT_FAILED", e.to_string()))?;
    p.destroy();
    q.roundtrip(&mut state)
        .map_err(|e| Failure::new("INPUT_FAILED", e.to_string()))?;
    Ok(())
}

pub fn available() -> Result<bool> {
    let (_, _, s) = connect()?;
    Ok(s.capture && s.keyboard && s.manager.is_some_and(|m| m.version() >= 2))
}
