//! Windows GDI fallback and SendInput. DXGI duplication can replace capture without changing the stream.
use super::*;
use windows_sys::core::BOOL;
use windows_sys::Win32::{
    Foundation::{LPARAM, RECT},
    Graphics::Gdi::*,
    UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};
fn failure() -> Failure {
    Failure::new("NATIVE_INPUT_FAILED",format!("Windows desktop access failed ({}). Secure/UAC desktops and higher-integrity windows cannot be controlled.",std::io::Error::last_os_error()))
}
unsafe extern "system" fn monitor(handle: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
    let mut info: MONITORINFO = std::mem::zeroed();
    info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if GetMonitorInfoW(handle, &mut info) == 0 {
        return 1;
    }
    let mut dpi_x = 96;
    let mut dpi_y = 96;
    GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
    let r = info.rcMonitor;
    let out = &mut *(data as *mut Vec<Display>);
    out.push(Display {
        id: format!("monitor-{:x}", handle as usize),
        width: (r.right - r.left) as u32,
        height: (r.bottom - r.top) as u32,
        scale: dpi_x as f64 / 96.,
        x: r.left,
        y: r.top,
        backend: "windows-gdi".into(),
    });
    1
}
pub fn displays() -> Result<Vec<Display>> {
    unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let mut displays = vec![];
        if EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(monitor),
            &mut displays as *mut _ as isize,
        ) == 0
        {
            return Err(failure());
        }
        Ok(displays)
    }
}
pub fn capture(d: &Display) -> Result<image::DynamicImage> {
    unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err(failure());
        }
        let memory = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, d.width as i32, d.height as i32);
        if memory.is_null() || bitmap.is_null() {
            if !memory.is_null() {
                DeleteDC(memory);
            }
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err(failure());
        }
        let previous = SelectObject(memory, bitmap);
        let result = (|| {
            if BitBlt(
                memory,
                0,
                0,
                d.width as i32,
                d.height as i32,
                screen,
                d.x,
                d.y,
                SRCCOPY | CAPTUREBLT,
            ) == 0
            {
                return Err(failure());
            }
            SelectObject(memory, previous);
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = d.width as i32;
            info.bmiHeader.biHeight = -(d.height as i32);
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB;
            let mut raw = vec![0u8; d.width as usize * d.height as usize * 4];
            if GetDIBits(
                memory,
                bitmap,
                0,
                d.height,
                raw.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            ) == 0
            {
                return Err(failure());
            }
            let mut rgb = image::RgbImage::new(d.width, d.height);
            for (p, b) in rgb.pixels_mut().zip(raw.chunks_exact(4)) {
                *p = image::Rgb([b[2], b[1], b[0]]);
            }
            Ok(image::DynamicImage::ImageRgb8(rgb))
        })();
        SelectObject(memory, previous);
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(std::ptr::null_mut(), screen);
        result
    }
}
fn mouse(flags: u32, x: i32, y: i32, data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: x,
                dy: y,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}
fn keyboard(vk: u16, scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}
pub fn input(
    d: &Display,
    tool: &str,
    args: &Value,
    point: Option<(u32, u32)>,
    end: Option<(u32, u32)>,
) -> Result<()> {
    unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let mut events = vec![];
        let absolute = |x: u32, y: u32| {
            let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let width = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2);
            let height = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2);
            mouse(
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                ((d.x + x as i32 - left) as i64 * 65535 / (width - 1) as i64) as i32,
                ((d.y + y as i32 - top) as i64 * 65535 / (height - 1) as i64) as i32,
                0,
            )
        };
        if let Some((x, y)) = point {
            events.push(absolute(x, y));
        }
        if tool == "input_click" || tool == "input_drag" {
            let (down, up) = if args["button"] == "right" {
                (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
            } else {
                (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
            };
            events.push(mouse(down, 0, 0, 0));
            if let Some((x, y)) = end {
                events.push(absolute(x, y));
            }
            events.push(mouse(up, 0, 0, 0));
        }
        if tool == "input_scroll" {
            for (key, flag, sign) in [
                ("dx", MOUSEEVENTF_HWHEEL, 1.),
                ("dy", MOUSEEVENTF_WHEEL, -1.),
            ] {
                let delta = (number(args, key)?.clamp(-2000., 2000.) * 3. * sign) as i32;
                if delta != 0 {
                    events.push(mouse(flag, 0, 0, delta as u32));
                }
            }
        }
        if tool == "input_type" {
            for unit in string_arg(args, "text")?.encode_utf16() {
                events.push(keyboard(0, unit, KEYEVENTF_UNICODE));
                events.push(keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
        }
        if tool == "input_key" {
            let keys = string_arg(args, "key")?
                .split('+')
                .map(|k| match k {
                    "ctrl" => Some(VK_CONTROL),
                    "alt" => Some(VK_MENU),
                    "shift" => Some(VK_SHIFT),
                    "super" => Some(VK_LWIN),
                    "Return" | "Enter" => Some(VK_RETURN),
                    "Escape" => Some(VK_ESCAPE),
                    "BackSpace" => Some(VK_BACK),
                    "Tab" => Some(VK_TAB),
                    "Delete" => Some(VK_DELETE),
                    "Left" => Some(VK_LEFT),
                    "Right" => Some(VK_RIGHT),
                    "Up" => Some(VK_UP),
                    "Down" => Some(VK_DOWN),
                    "Home" => Some(VK_HOME),
                    "End" => Some(VK_END),
                    k if k.len() == 1 && k.as_bytes()[0].is_ascii_alphanumeric() => {
                        Some(k.as_bytes()[0].to_ascii_uppercase() as u16)
                    }
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| Failure::new("BAD_ARGS", "Unsupported Windows key"))?;
            if keys.len() > 5 {
                return Err(Failure::new("BAD_ARGS", "Too many keys"));
            }
            for &key in &keys {
                events.push(keyboard(key, 0, 0));
            }
            for key in keys.into_iter().rev() {
                events.push(keyboard(key, 0, KEYEVENTF_KEYUP));
            }
        }
        // Short text chunks keep each native call bounded; paired press/releases remain adjacent.
        for chunk in events.chunks(128) {
            if SendInput(
                chunk.len() as u32,
                chunk.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            ) != chunk.len() as u32
            {
                return Err(failure());
            }
        }
        Ok(())
    }
}
