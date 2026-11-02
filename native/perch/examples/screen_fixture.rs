//! Headless compositor fixture; reports actual wl_pointer events, never used by the App.
#[cfg(target_os = "linux")]
mod linux {
    use std::{io::Write, os::fd::AsFd};
    use wayland_client::{
        protocol::{
            wl_buffer, wl_compositor, wl_pointer, wl_registry, wl_seat, wl_shm, wl_shm_pool,
            wl_surface,
        },
        Connection, Dispatch, QueueHandle,
    };
    use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};
    use wayland_protocols_wlr::virtual_pointer::v1::client::{
        zwlr_virtual_pointer_manager_v1, zwlr_virtual_pointer_v1,
    };
    #[derive(Default)]
    struct State {
        compositor: Option<wl_compositor::WlCompositor>,
        wm: Option<xdg_wm_base::XdgWmBase>,
        shm: Option<wl_shm::WlShm>,
        surface: Option<wl_surface::WlSurface>,
        file: Option<std::fs::File>,
        configured: bool,
        position: (f64, f64),
        pointer: Option<zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1>,
        size: (i32, i32),
    }
    impl Dispatch<wl_registry::WlRegistry, ()> for State {
        fn event(
            s: &mut Self,
            r: &wl_registry::WlRegistry,
            e: wl_registry::Event,
            _: &(),
            _: &Connection,
            q: &QueueHandle<Self>,
        ) {
            if let wl_registry::Event::Global {
                name,
                interface,
                version,
            } = e
            {
                match interface.as_str() {
                    "wl_compositor" => s.compositor = Some(r.bind(name, version.min(4), q, ())),
                    "xdg_wm_base" => s.wm = Some(r.bind(name, 1, q, ())),
                    "wl_shm" => s.shm = Some(r.bind(name, 1, q, ())),
                    "zwlr_virtual_pointer_manager_v1" => {
                        let manager: zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1 =
                            r.bind(name, version.min(2), q, ());
                        s.pointer = Some(manager.create_virtual_pointer(None, q, ()));
                    }
                    "wl_seat" => {
                        let seat: wl_seat::WlSeat = r.bind(name, version.min(5), q, ());
                        let _ = seat;
                    }
                    _ => {}
                }
            }
        }
    }
    impl Dispatch<xdg_wm_base::XdgWmBase, ()> for State {
        fn event(
            _: &mut Self,
            p: &xdg_wm_base::XdgWmBase,
            e: xdg_wm_base::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let xdg_wm_base::Event::Ping { serial } = e {
                p.pong(serial);
            }
        }
    }
    impl Dispatch<xdg_toplevel::XdgToplevel, ()> for State {
        fn event(
            s: &mut Self,
            _: &xdg_toplevel::XdgToplevel,
            e: xdg_toplevel::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let xdg_toplevel::Event::Configure { width, height, .. } = e {
                if width > 0 && height > 0 {
                    s.size = (width, height);
                }
            }
        }
    }
    impl Dispatch<xdg_surface::XdgSurface, ()> for State {
        fn event(
            s: &mut Self,
            p: &xdg_surface::XdgSurface,
            e: xdg_surface::Event,
            _: &(),
            _: &Connection,
            q: &QueueHandle<Self>,
        ) {
            if let xdg_surface::Event::Configure { serial } = e {
                p.ack_configure(serial);
                if !s.configured {
                    let (w, h) = s.size;
                    let mut file = tempfile::tempfile().unwrap();
                    let bytes = [32, 32, 220, 255].repeat((w * h) as usize);
                    file.write_all(&bytes).unwrap();
                    let pool = s
                        .shm
                        .as_ref()
                        .unwrap()
                        .create_pool(file.as_fd(), w * h * 4, q, ());
                    let buffer =
                        pool.create_buffer(0, w, h, w * 4, wl_shm::Format::Argb8888, q, ());
                    let surface = s.surface.as_ref().unwrap();
                    surface.attach(Some(&buffer), 0, 0);
                    surface.damage_buffer(0, 0, w, h);
                    surface.commit();
                    s.file = Some(file);
                    s.configured = true;
                    println!("{{\"ready\":true}}");
                }
            }
        }
    }
    impl Dispatch<wl_pointer::WlPointer, ()> for State {
        fn event(
            s: &mut Self,
            _: &wl_pointer::WlPointer,
            e: wl_pointer::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            match e {
                wl_pointer::Event::Enter {
                    surface_x,
                    surface_y,
                    ..
                }
                | wl_pointer::Event::Motion {
                    surface_x,
                    surface_y,
                    ..
                } => s.position = (surface_x, surface_y),
                wl_pointer::Event::Button {
                    state: wayland_client::WEnum::Value(wl_pointer::ButtonState::Pressed),
                    button,
                    ..
                } => println!(
                    "{{\"click\":{button},\"x\":{},\"y\":{}}}",
                    s.position.0, s.position.1
                ),
                _ => {}
            }
        }
    }
    wayland_client::delegate_noop!(State: ignore wl_compositor::WlCompositor);
    wayland_client::delegate_noop!(State: ignore wl_surface::WlSurface);
    wayland_client::delegate_noop!(State: ignore wl_shm::WlShm);
    wayland_client::delegate_noop!(State: ignore wl_shm_pool::WlShmPool);
    wayland_client::delegate_noop!(State: ignore wl_buffer::WlBuffer);
    impl Dispatch<wl_seat::WlSeat, ()> for State {
        fn event(
            _: &mut Self,
            p: &wl_seat::WlSeat,
            e: wl_seat::Event,
            _: &(),
            _: &Connection,
            q: &QueueHandle<Self>,
        ) {
            if let wl_seat::Event::Capabilities {
                capabilities: wayland_client::WEnum::Value(c),
            } = e
            {
                if c.contains(wl_seat::Capability::Pointer) {
                    p.get_pointer(q, ());
                }
            }
        }
    }
    wayland_client::delegate_noop!(State: ignore zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1);
    wayland_client::delegate_noop!(State: ignore zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1);
    pub fn run() -> Result<(), Box<dyn std::error::Error>> {
        let c = Connection::connect_to_env()?;
        let mut q = c.new_event_queue();
        let h = q.handle();
        c.display().get_registry(&h, ());
        let mut s = State {
            size: (1280, 720),
            ..Default::default()
        };
        q.roundtrip(&mut s)?;
        let surface = s.compositor.as_ref().unwrap().create_surface(&h, ());
        let shell = s.wm.as_ref().unwrap().get_xdg_surface(&surface, &h, ());
        let toplevel = shell.get_toplevel(&h, ());
        toplevel.set_title("Perch headless fixture".into());
        toplevel.set_fullscreen(None);
        surface.commit();
        s.surface = Some(surface);
        loop {
            q.blocking_dispatch(&mut s)?;
        }
    }
}
#[cfg(target_os = "linux")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    linux::run()
}
#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("screen_fixture requires Linux");
}
