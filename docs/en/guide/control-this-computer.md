# Control this computer

English | [简体中文](../../zh/guide/control-this-computer.md)

The desktop App is a **Perch**, controlling only the computer where it runs. Your central Swiftnest Server
is the **Nest**. Control is off by default and no folders are shared until you choose them. The web App
manages devices but cannot expose its host computer. This section is hidden in Android for now.

1. Connect the desktop App to your server using its App pairing link, then open **Devices → This device**.
2. Set a display name and **Add shared folder**. Save folder changes. File tools and shell commands can use
   those folders; keys, credentials, browser profiles and Swiftnest's own data remain protected.
3. On the server's **Devices** page choose **Pair a device**. Copy its device address and six-digit code.
   The local address is prefilled from your connected server, with the default device port 7711; replace it
   with the displayed address when the listener uses another port or TLS endpoint.
4. Enter the code under **This device → Pair this computer**. This enables device control. Compare the server
   fingerprint here with the server's page and choose **Fingerprint matches**. On the server, compare this
   computer's fingerprint and confirm that too. A code expires after five minutes and works only once.
5. Once **Online**, Ivy can list/read files and run read-only commands. Writes and other execution wait for
   owner approval on Devices or the chat approval banner. Review the exact arguments before approving.

**Let Ivy control this computer** immediately stops the connection and cancels running calls when switched
off. It retains the pairing for later. **Unpair this computer** also forgets the local Nest key; use
**Revoke device** on the server to remove its entry there. Changing a display name preserves the device
identity and stable agent namespace. A changed server key stops reconnects and requires pairing again.
Saving settings restarts the device session, so finish running work before changing folders or names.

## Background and platform limits

**Keep running in the background** hides the window on close and leaves the Rust task in the App process.
Use the tray menu to reopen or quit. Linux needs a working StatusNotifier/AppIndicator tray host; Windows
uses the notification area. If tray creation fails, background mode cannot be enabled. On macOS the menu
bar icon provides the same actions; macOS behavior still needs device testing. Sleep, logout, quitting
or terminating the process disconnects the Perch. This does not install an autostart/system service.

Linux shell execution requires `bwrap` (bubblewrap) in the App's PATH and usable user namespaces; it is
included in the Nix development shell. Missing sandboxes fail closed. macOS uses the platform `sh` and
`sandbox-exec` and needs platform validation. Windows file tools work, but shell is currently refused
until a filesystem-isolating executor is available (the selected command syntax is `cmd.exe /D /S /C`).
Approved commands still cannot use user files outside shared folders. Shell access includes the read-only
system programs/libraries necessary to run commands. Output is capped at 64 KiB; file reads at 512 KiB.
Screen capture and approved keyboard/pointer tools are available when the tray is working. Enable the
separate, default-off **Allow live view** toggle for owner viewing and take-over. See
[Live view and take-over](./live-view) for dependencies, gestures and platform validation limits.
Resumable large file transfer remains E2c.

Local pairing data and the private device key are under the Tauri App data directory's `perch/` folder.
Keep this directory private. OS file permissions protect the seed; keyring integration is planned.
The device core has no Node runtime dependency. See [Devices](./devices) for server approvals and audit.
