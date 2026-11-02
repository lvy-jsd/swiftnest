# Live view and take-over

English | [简体中文](../../zh/guide/live-view.md)

Open your conversation with Ivy on the owner App, then choose **Live view · computer name**. Online
computers with screen support appear above the transcript. The view fills a phone screen and opens on
the right on desktop. The native phone App can view a desktop; Android does not expose its own screen.
Use an HTTPS server connection for LAN live view in both the native App and browser; stream keys must
travel over TLS. The owner API returns the per-stream encryption keys; exposing that response over
HTTP would defeat the encrypted video/input channel. Browsers also need HTTPS for Web Crypto.
Plain HTTP is accepted only for loopback development. A trusted local TLS reverse proxy must require
HTTPS/WSS on its public listener and preserve the server's Host/Origin checks.

## Enable on the computer

1. Pair the desktop App in [Devices → This device](./control-this-computer).
2. Enable **Let Ivy control this computer** and, separately, **Allow live view**. Live view starts off.
3. Keep the desktop App running. A working tray is required for screen/input support. A red tray indicator
   and a start notification show observation; **This device** also shows who is controlling.
4. To stop locally, choose **Stop live view** in the tray or **This device**. This closes the stream,
   disables Allow live view, stops the screen backend and releases take-over. Re-enable the toggle to
   allow another viewer. Turning device control off, unpairing or quitting also disconnects everything.

Only owner App sessions can open a viewer. Agent tools cannot open the viewer endpoint or grant themselves
take-over. Screen contents can include private windows outside shared folders: folder sharing confines
file/shell tools, not pixels visible on your desktop. Do not share a screen showing secrets.

## Use from the phone

The status starts as **Ivy is in control**. You can watch, pinch to zoom and pan without taking over.
Choose **Take over** at the bottom right before sending input. The host pauses agent input before
acknowledging **You are in control**. A call approved during take-over fails with `OWNER_HAS_CONTROL`;
it is not replayed later. **Hand back** restores agent input. Closing/disconnecting a viewer releases
control; a failed or stalled stream displays **Paused**.

- Tap to left-click; hold for at least half a second to right-click.
- Drag with one finger to drag on the computer while controlling. When watching, one finger pans.
- Pinch to zoom. Move two fingers together to scroll while controlling, or pan while watching.
- **Keyboard** opens a text box and key buttons. Type text, then Send; buttons include Return, BackSpace,
  Tab, Escape, arrows and ctrl+c/ctrl+v. **Fit screen** resets zoom and pan.

One viewer per computer is allowed. The viewer lease ends after one hour; reopen the panel to continue.
Stop and reopen if a monitor disconnects. The initial viewer selects the default display; the SDK also
accepts a `displayId`. There is not yet an in-panel monitor picker.

## Agent tools and coordinates

`screen.screen_info` reports display ids, sizes, scale and backend. `screen.screen_capture` returns
PNG or JPEG in `result.data.data` (base64), `mime`, `width`, `height`, `scaleFactor`, `region`, `displayId`
and `captureId`. `maxDimension` defaults to 1280, caps at 2560, and never enlarges an image. Regions are
in native display pixels. Screen content is marked untrusted for downstream model use.

`input_click`, `input_move`, `input_drag`, `input_scroll`, `input_type` and `input_key` have `exec` risk
and require approval under the default policy. Pointing tools take `displayId`, `captureId`, and `x/y`
in the returned screenshot's pixel space; drag also takes `toX/toY`. The host stores crop/downscale
geometry, checks points and rejects changed monitor geometry. Scroll takes `dx/dy` in pixels; text is
literal, keys use names such as `Return` or combos such as `ctrl+c`.

## Backends and dependencies

| Session | Capture | Input | Validation in E2b |
| --- | --- | --- | --- |
| Linux wlroots protocols (including niri/labwc) | grim 1.5, wlr-screencopy or ext-image-copy-capture | output-bound virtual pointer v2; wtype virtual keyboard | Actual headless labwc/pixman capture/pointer e2e; niri and native keyboard unverified |
| Linux GNOME/KDE Wayland | ScreenCast portal + PipeWire/GStreamer | RemoteDesktop portal | Compiled; needs real desktop validation |
| Linux X11 | XGetImage | xdotool/XTest | Compiled; needs X11 validation |
| Windows | GDI fallback | SendInput | Implemented; Windows toolchain/hardware validation pending |
| macOS | Not supported yet | Not supported yet | Screen/input are not advertised |

Backends are selected from the current session's protocols, never silently from XWayland. The portal
opens the desktop's own permission chooser, requests one monitor plus keyboard/pointer, and does not
persist restore tokens. Its exposed size/scale describe the normalized portal stream, not a physical DPI
measurement. Portal permission can be cancelled locally. GNOME/KDE may prohibit input to protected UI.
Windows UAC/secure desktops and higher-integrity windows cannot be controlled with SendInput.

The default `nix develop` shell provides grim, wtype, GStreamer (including pipewiresrc) and headless labwc.
For a packaged Linux App these helpers must also be in the App's PATH. Missing helpers/protocols fail
with an explicit backend error; no privileged input daemon or system installation is attempted.

Live video is JPEG, changed frames only, one frame awaiting acknowledgement. The LAN target is 10–15 fps;
actual rate depends on capture/encoding cost. Acknowledgement latency lowers quality (80 down to 35) and
frame rate on slower links. Video, owner input and tool replies use separate bounded transport queues.
H.264/WebRTC, packaging the Linux helpers, physical-phone performance measurements and additional backend
hardware validation remain follow-ups. Resumable file transfer is E2c and is not enabled by this feature.
