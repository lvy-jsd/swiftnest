use super::*;
use x11rb::{
    connection::Connection,
    protocol::{
        randr::ConnectionExt as _,
        xproto::{ConnectionExt, ImageFormat},
    },
};
pub fn displays() -> Result<Vec<Display>> {
    let (c, n) =
        x11rb::connect(None).map_err(|e| Failure::new("BACKEND_UNAVAILABLE", e.to_string()))?;
    let root = &c.setup().roots[n];
    let monitors = c
        .randr_get_monitors(root.root, true)
        .map_err(|e| Failure::new("CAPTURE_FAILED", e.to_string()))?
        .reply()
        .map_err(|e| Failure::new("CAPTURE_FAILED", e.to_string()))?;
    let mut displays = vec![];
    for m in monitors.monitors {
        displays.push(Display {
            id: m.name.to_string(),
            width: m.width as u32,
            height: m.height as u32,
            scale: 1.,
            x: m.x as i32,
            y: m.y as i32,
            backend: "x11".into(),
        });
    }
    if displays.is_empty() {
        displays.push(Display {
            id: "root".into(),
            width: root.width_in_pixels as u32,
            height: root.height_in_pixels as u32,
            scale: 1.,
            x: 0,
            y: 0,
            backend: "x11".into(),
        });
    }
    Ok(displays)
}
pub fn capture(d: &Display) -> Result<image::DynamicImage> {
    let (c, n) =
        x11rb::connect(None).map_err(|e| Failure::new("BACKEND_UNAVAILABLE", e.to_string()))?;
    let root = &c.setup().roots[n];
    let reply = c
        .get_image(
            ImageFormat::Z_PIXMAP,
            root.root,
            d.x as i16,
            d.y as i16,
            d.width as u16,
            d.height as u16,
            u32::MAX,
        )
        .map_err(|e| Failure::new("CAPTURE_FAILED", e.to_string()))?
        .reply()
        .map_err(|e| Failure::new("CAPTURE_FAILED", e.to_string()))?;
    let fmt = c
        .setup()
        .pixmap_formats
        .iter()
        .find(|f| f.depth == reply.depth)
        .ok_or_else(|| Failure::new("CAPTURE_FAILED", "Unknown X11 pixel format"))?;
    if fmt.bits_per_pixel != 32 {
        return Err(Failure::new("CAPTURE_FAILED", "X11 requires 32-bit pixels"));
    }
    let visual = root
        .allowed_depths
        .iter()
        .flat_map(|d| &d.visuals)
        .find(|v| v.visual_id == reply.visual)
        .ok_or_else(|| Failure::new("CAPTURE_FAILED", "Unknown X11 visual"))?;
    let mut img = image::RgbImage::new(d.width, d.height);
    let stride = (d.width as usize * 4).div_ceil(fmt.scanline_pad as usize / 8)
        * (fmt.scanline_pad as usize / 8);
    for (x, y, p) in img.enumerate_pixels_mut() {
        let at = y as usize * stride + x as usize * 4;
        let b: &[u8; 4] = reply
            .data
            .get(at..at + 4)
            .ok_or_else(|| Failure::new("CAPTURE_FAILED", "Truncated X11 image"))?
            .try_into()
            .unwrap();
        let value = if c.setup().image_byte_order == x11rb::protocol::xproto::ImageOrder::LSB_FIRST
        {
            u32::from_le_bytes(*b)
        } else {
            u32::from_be_bytes(*b)
        };
        let component = |mask: u32| ((value & mask) >> mask.trailing_zeros()) as u8;
        *p = image::Rgb([
            component(visual.red_mask),
            component(visual.green_mask),
            component(visual.blue_mask),
        ]);
    }
    Ok(image::DynamicImage::ImageRgb8(img))
}
pub fn input(
    d: &Display,
    tool: &str,
    args: &Value,
    point: Option<(u32, u32)>,
    end: Option<(u32, u32)>,
) -> Result<()> {
    if let Some((x, y)) = point {
        command(
            "xdotool",
            &[
                "mousemove",
                "--sync",
                &(d.x + x as i32).to_string(),
                &(d.y + y as i32).to_string(),
            ],
        )?;
    }
    let button = if args["button"] == "right" { "3" } else { "1" };
    match tool {
        "input_click" => {
            command("xdotool", &["click", button])?;
        }
        "input_drag" => {
            command("xdotool", &["mousedown", button])?;
            let result = if let Some((x, y)) = end {
                command(
                    "xdotool",
                    &[
                        "mousemove",
                        "--sync",
                        &(d.x + x as i32).to_string(),
                        &(d.y + y as i32).to_string(),
                    ],
                )
            } else {
                Ok(vec![])
            };
            let release = command("xdotool", &["mouseup", button]);
            result?;
            release?;
        }
        "input_scroll" => {
            for (key, positive, negative) in [("dy", "5", "4"), ("dx", "7", "6")] {
                let n = number(args, key)?.clamp(-2000., 2000.);
                let count = (n.abs() / 40.).ceil().min(50.) as u32;
                if count > 0 {
                    command(
                        "xdotool",
                        &[
                            "click",
                            "--repeat",
                            &count.to_string(),
                            "--delay",
                            "0",
                            if n > 0. { positive } else { negative },
                        ],
                    )?;
                }
            }
        }
        "input_type" => {
            command(
                "xdotool",
                &["type", "--clearmodifiers", "--", string_arg(args, "text")?],
            )?;
        }
        "input_key" => {
            let key = string_arg(args, "key")?;
            if !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'_')
            {
                return Err(Failure::new("BAD_ARGS", "Invalid key combo"));
            }
            command("xdotool", &["key", "--clearmodifiers", "--", key])?;
        }
        "input_move" => {}
        _ => return Err(Failure::new("UNKNOWN_TOOL", "Unknown input tool")),
    }
    Ok(())
}
