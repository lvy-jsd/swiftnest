# Let your assistant use this phone

The Android App is both a chat client and a device: once paired, the assistant on your server can use this phone
with your approval.

## Turning it on

1. Create a pairing code on the server's Devices page.
2. In the phone App's Devices page, under "This device", enter the code, tap "Pair this phone", compare the
   fingerprints on both screens and confirm.
3. Under "Phone permissions", turn on what you want (tap "Open system settings"):
   - **Accessibility**: in the system's Accessibility settings (sometimes under "Downloaded apps"), turn on
     "Swiftnest phone control".
   - **Notification access**: allow Swiftnest under "Notification access".

Without a permission, the matching tools fail clearly and do nothing.

## What the assistant can do

| Ability                                                    | Tools                                         | Needs your approval         |
| ---------------------------------------------------------- | --------------------------------------------- | --------------------------- |
| Read what is on screen (text, buttons and their positions) | `ui_ui_tree`                                  | No                          |
| Screen size, screenshot                                    | `screen_screen_info`, `screen_screen_capture` | No                          |
| Tap, swipe, type, press back/home/recents                  | `input_input_tap` etc.                        | Every time                  |
| List apps / open an app                                    | `apps_apps_list` / `apps_apps_open`           | Listing no, opening yes     |
| Post / read notifications                                  | `notify_notify_post` / `notify_notify_list`   | Both (reading is sensitive) |
| Send and receive files                                     | `files_*`, transfers                          | Writes yes                  |

Full tool names are `device__<device slug>__<capability>_<tool>`, e.g. `device__phone-1d45d9c51479__input_input_tap`.

Screen contents, notifications and screenshots are treated as untrusted: the assistant never follows instructions
found in them.

## Limits

- Screenshots need Android 11 or later.
- No shell on the phone (it cannot be confined safely).
- Files live in Swiftnest's own folder; picking other phone folders is not built yet.
- When Android stops the App, the phone goes offline and reconnects when the App opens again. A background
  (foreground-service) mode is not built yet.
