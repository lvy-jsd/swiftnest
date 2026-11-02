# Swiftnest App design system

English | [中文](../../zh/dev/design-system.md)

This is the rulebook for the Swiftnest App (`client/`, Tauri 2 + React/TS). It is written for us; the spirit
(restraint, white space, clear hierarchy, content first) is inspired by public design notes of DSH Go, but no
code, asset or brand of DSH Go is used. All components are our own.

Every rule below should be checkable: tokens live in `client/src/design/tokens.ts`, and the rules marked
**(test)** have a unit or geometry test.

## 1. Principles

1. **Content is the hero.** Chrome steps back: no decorative borders, gradients or looping animations.
2. **One focus per screen.** Each screen has one primary action; only it uses the accent color.
3. **Same skeleton, same behavior.** Pages of the same kind share header, spacing and grouping exactly.
4. **Short, certain copy.** Buttons start with a verb. No internal terms (no "session id", "Cordis", "profile").
5. **Degrade gracefully.** Blur, motion and haptics can be off; the app must still look finished.

## 2. Page skeletons

There are exactly five. A new screen picks one; it does not invent a sixth.

| Skeleton | Use                               | Header                                      | Body                                 |
| -------- | --------------------------------- | ------------------------------------------- | ------------------------------------ |
| Hub      | Home: chats, bots, devices        | Large title, avatar button on the right     | Grouped list of cards                |
| Detail   | One chat, one bot, one device     | Back, title + subtitle, one trailing action | Content fills the width              |
| List     | Search results, history, plugins  | Back, title, search field                   | Virtualized rows                     |
| Form     | Settings, pairing, bot editor     | Back, title, Save (primary)                 | Groups of fields                     |
| Sheet    | Confirmations, approvals, pickers | Grabber, title                              | Short content, actions at the bottom |

## 3. Layout

- Spacing scale: multiples of 4 px only: `4 8 12 16 20 24 32 40 48 64`. **(test)**
- Radius: controls 12, cards 20, sheets 28, avatars full. **(test)**
- Page gutter: 16 (phone), 24 (tablet), 32 (desktop).
- Breakpoints: `phone < 600 ≤ tablet < 1024 ≤ desktop`. Landscape phone uses tablet's two-pane layout when
  width ≥ 600.
- Desktop adds a persistent sidebar (chat list), optional third column (memory / details) and keyboard shortcuts.
- Symmetric layouts (centered titles, avatar grids) get geometry tests: left and right insets equal within 0.5 px.
  **(test)**
- Hit targets ≥ 44 × 44 px.

## 4. Color

- Colors are generated in **OKLCH** from one accent hue: `generatePalette(accent, mode)` returns the full
  light or dark token set (background, surface 1–3, text primary/secondary/muted, border, accent, on-accent,
  success, warning, danger).
- Presets: 5 built-in accents plus custom. On Android 12+ the accent can follow the wallpaper.
- **Contrast guard**: every text/background pair meets WCAG AA (4.5:1 body, 3:1 large text and icons); the
  generator adjusts lightness until it passes. **(test: every preset, both modes)**
- Accent is reserved for the primary action, selection and links. Status colors are only for status.
- Dark mode is first-class, follows the system by default, and can be forced in settings.

## 5. Surfaces

- "Glass" surfaces: translucent surface color + backdrop blur 20 px for bars and sheets.
- When blur is unsupported, slow (low-end Android WebView), or "reduce transparency" is on, fall back to an
  opaque surface of the same color. The app must look correct in both.
- Elevation is expressed by surface level (1–3), not by heavy shadows. One soft shadow token for sheets only.

## 6. Type

- System font stack (`system-ui`, plus `"PingFang SC", "Noto Sans CJK SC"` for Chinese). No bundled fonts in v0.
- Scale (px / line height): Large title 28/34, Title 20/26, Headline 17/22 semibold, Body 16/24,
  Callout 15/20, Footnote 13/18, Caption 12/16.
- Monospace for code: `ui-monospace, "JetBrains Mono", monospace`.

## 7. Motion

- Durations 150–300 ms; standard easing `cubic-bezier(0.2, 0, 0, 1)`.
- Press: scale to 0.97 in 150 ms.
- Navigation: push from the right and interactive swipe-back on phone; cross-fade on desktop.
- No bounce, no looping decoration. Progress uses a calm indeterminate indicator only while waiting.
- `prefers-reduced-motion` (or the in-app switch) sets every duration to 0. **(test)**

## 8. Icons and copy

- Icons: Phosphor (MIT), regular weight 24 px, fill weight only for the selected tab. Icons are referenced by
  role through one map (`icons.ts`: `send`, `approve`, `device`…), never imported ad hoc in screens.
- Copy: short and certain. "Pair device", not "Click here to start pairing". Errors say what happened and what to
  do next. Every string goes through i18n (`en`, `zh-CN`) from day one.

## 9. Chat interactions

- **Interject or queue while the bot is generating**: the composer stays enabled; sending while a turn runs
  offers "Send now" (interrupt) or "Queue".
- **Collapse finished work**: tool calls and thinking of a finished turn fold into one line
  ("Ran 4 tools · 12 s"); tap to expand.
- **Thinking pill**: a small pill shows while the model thinks, with elapsed time.
- **Turn change card** with diff for file edits; **artifact file cards** for produced files.
- **Approval card**: who asks, on which device, the exact command or path, Approve / Deny. Shown inline and as a
  sheet on the device the user is currently on.
- **Unknown content** from third-party plugins renders as a generic card (title + key/value + raw JSON toggle),
  never dropped.
- **Group chat**: every message shows the bot's avatar and name; typing `@` opens the member menu.
- Share card and conversation replay come later (not phase 0).

## 10. Long lists and performance

- Chat transcript and every list longer than ~50 rows are virtualized.
- Target 60 fps scrolling on a mid-range Android device; we measure on real hardware in phase 0.

## 11. What we must not use

DSH Go code (AGPL-3.0), its whale logo, Deepy mascot, whale-girl desktop pet and screenshots, and DeepSeek
trademarks as our name or logo. Swiftnest will have its own brand before release.
