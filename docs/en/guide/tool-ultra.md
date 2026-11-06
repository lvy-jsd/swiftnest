# Tool Ultra

Tool Ultra is the Swiftnest owner's DSH plugin ([source](https://github.com/lvy-jsd/dsh-tool-ultra), Apache-2.0). Models browse or search the catalog, then load native tools as needed, reducing the tool definitions sent on each turn. Until the finished product is released, Swiftnest builds commit `4e5c418ccd21d16107db207253d088efbd523b2f`; Tool Ultra is not published to npm.

## Install and enable

With Git, npm, Node 24 and network access available, use the same server config and data home:

```sh
swiftnest-server plugins install --config swiftnest.yaml
swiftnest-server start --config swiftnest.yaml
```

In a source checkout, use `node server/dist/cli.js plugins install`. The config file is optional. If you set `SWIFTNEST_HOME`, use the same value for both commands.

Installation fetches only the pinned commit into `<home>/vendor/dsh-tool-ultra-4e5c418ccd21`, runs `npm ci` with a lockfile shipped by Swiftnest, then `npm run build`. A marker is written only after success. Repeated installation reuses it; failed installs are cleaned up and can be retried. Host dependency links resolve to the Server's own DSH. Installation neither uses nor publishes Tool Ultra packages on npm.

First installation also downloads image and local speech runtime dependencies from npm; the size depends on your system. These are separate from the speech model downloaded on first transcription. After a network timeout, restore the connection and retry the same installation command.

Tool Ultra is on by default; its pinned commit lives in [`server/plugins.json`](https://github.com/lvy-jsd/swiftnest/blob/main/server/plugins.json). Startup prints a hint and continues if the build is missing; it never downloads source automatically. Disable it with:

```yaml
plugins:
  tool-ultra: false
```

Or set `SWIFTNEST_PLUGINS=tool-ultra=false`; the environment takes precedence. Restart the Server after installation. See [Plugins](./plugins.md) for the others.

The build applies a dependency override to `mathjs 15.2.0` to fix the source dependency's [expression execution vulnerability](https://github.com/josdejong/mathjs/security/advisories/GHSA-29qv-4j9f-fjw5). The upstream source and tool limits stay unchanged. Swiftnest sets the media folders and speech download settings.

Tool Ultra's management panel (`panel`) installs with the other packages. It shows the tool directory, what each session holds and the audit trail, under Settings → "Tool manager" in DSH. The App switches the MCP presets and names the tool bundles in the **Plugins** page, under Tools; a saved change needs Apply changes to restart the kernel.

## Finding a tool

`tools_ls` with a query answers in three steps, cheapest first:

1. **Keyword** — every word of the query appears in the tool's name, group, category or description.
2. **Ranked index** — when the keyword match found nothing, an in-process index over the same catalog
   scores the words instead of requiring all of them. It needs no model and no network, and it costs
   no schema tokens: it is memory, not a tool.
3. **Model fallback** — a request the keyword match could not read at all is worth one small-model
   call. This step needs a configured model, and Swiftnest does not configure one by default, so the
   behaviour of a fresh install is steps 1 and 2.

Measured on the recall probe (30 requests, half of them phrased the way a person would): 80.0% before,
**96.7%** with the ranked index, **100%** with a model that understands the last request.

## Named bundles

`capability-bridge` lets you declare a named bundle of targets, so one call arms a whole set:

```yaml
capabilities:
  packs:
    workstation: device:current
    research: [pack:web, pack:media]
```

The model loads it with `tools_load(["cap:workstation"])`. A bundle is only a name for targets that
already exist, so loading it goes through the same approvals as loading them one by one.

## MCP servers

`pack-mcp` starts well-known MCP servers (memory, sequential thinking, Context7, Playwright, GitHub,
search engines, Notion, maps). **Nothing starts by default**: Swiftnest sets `defaults: false`, so a
fresh install talks to no outside service. A preset starts only when you list it:

```yaml
mcp:
  presets:
    memory:
      enabled: true
    github:
      enabled: true
      env:
        GITHUB_TOKEN: ghp_xxx
```

A preset that needs a key or a setting waits until it is present, and the model can list the state of
every preset with the `mcp_presets` tool. Tools of a running preset appear as `mcp__<preset>__*` and
are loadable by path; write and delete tools are marked high risk, so loading them needs the risk
gate's approval like any other high-risk tool.

## Tools and approvals

The enabled packages are `core`, `classifier-rules`, `classifier-llm`, `risk-gate`, `persist`, `pack-essentials`, `pack-web`, `pack-mcp`, `capability-bridge`, `devices` and `pack-media`. Defaults come from their own `cordis.patch.yml` files, with absolute module paths in generated DSH `insert` rows. Put overrides in `<home>/dsh/profiles/swiftnest/user.patch.yml`, which applies last and is never overwritten. DSH replaces a row's whole `config`, so retain the other fields you need when overriding it.

Models use `tools_ls` to browse, `tools_find` to search and `tools_load` to load tools. For example:

```json
{ "targets": ["device:all"] }
```

This loads paired device tools, making `device__<slug>__<capability>` available on the next model step. Use `device:<slug>/files` to narrow the area. Loading does not execute tools or bypass device permissions.

High-risk tools must be loaded individually. The risk gate asks through DSH's `approval-request` interaction. App chat shows the tool and reason, with one-time approval and denial buttons. Missing answers or cancellation grant no permission. Device execution approval is a separate step, still enforced by the Nest's device policy.

## Verify

After building, developers can run:

```sh
pnpm build
SWIFTNEST_TOOL_ULTRA_E2E=1 pnpm vitest run server/test/tool-ultra.e2e.test.ts
```

The test uses a temporary home, the real DSH kernel, a scripted model and a paired Node Perch. To exercise approval and denial in the App too, build the App, prepare Chromium and also set `SWIFTNEST_WEB_E2E=1` (`SWIFTNEST_CHROMIUM` can select a browser). CI runs this complete flow.

## Media tools

Ask for a chart, greeting card, ringtone or short video in chat. The `media` pack is enabled with Tool Ultra, needs no API key, and can be loaded with `tools_load` using `{"targets":["pack:media"]}`. `html_render` makes HTML/CSS posters, cards and slides with Chinese and emoji, or turns CSS animations into GIF/WebP; `svg_render` makes images, `chart_render` draws Vega-Lite charts, `music_render` makes MIDI/WAV music and `video_render` combines HTML, SVG or photo scenes with an optional soundtrack into MP4. `audio_transcribe` turns recordings into timestamped text and SRT subtitles. `video_understand` returns duration, picture/sound facts, scene-change times, a timestamped storyboard and speech. Storyboard frames follow the scene changes, with extra frames for longer shots; when no cuts are found, they are evenly spaced.

Try asking: “Make a 1080×1920 vertical video with two scenes, good morning and heading out, with big bouncing captions, a transition and cheerful music.” You can also upload a recording, ask for text and subtitles, then ask to put the subtitles in a video. Videos support fade, slide, wipe, circle and cut transitions at 24, 30 or 60 frames per second.

HTML renders locally with Takumi and needs no browser. Scripts, web fonts and external links are refused; use inline pictures or previously generated files. Chinese needs a font such as Noto Sans CJK; colour emoji needs Noto Color Emoji. Page language follows the server language. Fonts are found automatically with fontconfig; without it, an administrator can set local `fontFiles` in the media pack configuration.

First music generation tries to download the FluidR3 Mono GM instrument library (about 24 MB) into `<home>/models/soundfonts`, checking its SHA-256. Later calls use the cache. The default download uses `raw.githubusercontent.com`, which may be unreachable in mainland China. No verified automatic mainland mirror is configured. If loading fails, music still works with the built-in synthesizer and the tool result explains the fallback. An administrator can choose a trusted HTTPS mirror of the same file, or a local `.sf2`/`.sf3` file (the local file takes precedence):

```yaml
media:
  soundfontUrl: https://your-mirror.example/FluidR3Mono_GM.sf3
  # Or use a local file, with no download:
  # soundfont: /srv/sounds/library.sf3
```

Both settings are optional; replace the example mirror address before using it. Mirrored downloads must still match the default library’s SHA-256. The instrument library and the speech model below are separate downloads.

Generated files appear as chat attachments: preview images, play audio/video, download files or use **Send file to…** to send one to a paired phone. Choose a shared destination folder on the phone and approve the transfer there. The files stay in `<home>/files/media`. Phone uploads received through Transfers land under `<home>/files`; these are the only input folders the media tools can read. Other server paths and symlinks escaping these folders are refused.

Video and speech tools use `ffmpeg` and `ffprobe` from PATH. If missing, chat explains to install ffmpeg; other tools keep working. Chinese drawings need a Chinese font, such as Noto Sans CJK. The server checks fontconfig when available.

First transcription downloads about 200 MB of speech and speaker models into `<home>/models/sherpa-onnx`; chat shows a first-use preparation message while the tool runs. Recognition runs locally on the CPU with sherpa-onnx: SenseVoice Small (FunAudioLLM / FunASR) is the default, with four threads. It understands Chinese, Cantonese, English, Japanese and Korean, including emotions and sounds. Other languages automatically use Whisper large-v3-turbo (a separate download of about 540 MB). Audio stays on your server while Gemini uploads are off.

Speaker separation is on by default (`speakers: true`): recordings with several voices keep “Speaker 1”, “Speaker 2”, etc. in chat, the text given to the model and SRT subtitles. A single voice has no unnecessary label. Ask to skip speaker separation for faster transcription of a single voice (`speakers: false`).

Downloads use the sherpa-onnx GitHub releases. Chinese server language prefers the public `gh-proxy.com` release mirror; English checks a small GitHub model download for up to two seconds, falling back to that mirror if unreachable. This mirror was reachable during validation; availability in your network can vary. All downloaded models still have their SHA-256 checked by the pack. An administrator can override the release base in the server YAML (keep the full release path; a trailing slash is added automatically):

```yaml
media:
  modelMirror: https://github.com/k2-fsa/sherpa-onnx/releases/download/
```

This optional example forces the original GitHub releases even on a Chinese server. A mirror must serve the same release subpaths and files. The pack's advanced `speechModel` option accepts `sensevoice` (default) or `whisper-turbo`; `speechThreads` defaults to 4. No change is needed for ordinary use.

Text-only models receive facts and transcript with the storyboard path, never image bytes. The App still displays the storyboard for you; a model needs an image-reading tool and vision support to inspect its picture.

### Optional Google Gemini analysis

Recordings and videos stay local by default. For better transcription and video understanding, open **Models → Recordings and videos** and turn on **Send recordings and videos to Google Gemini for better results**. This uploads the whole recording or video to Google, so only enable it for files you want Google to receive. Off means all recording/video analysis stays local.

The switch uses the same Google key already saved on the Models page. If you have not added one, the switch stays off and opens the Google entry, with a link to create a key. Save the key there, return to the switch, turn it on, then choose **Apply changes**. Applying restarts the assistant, like other model changes. Removing the Google key also switches uploads off; apply that change too.

`audio_transcribe` and `video_understand` use Gemini with `engine: auto` only when this switch is on and the Google key is saved. `engine: local` always stays local; even `engine: gemini` cannot override the off switch. Gemini results start with “analysed by Gemini … (file uploaded to Google)”. If Google is unavailable, the pack explains the fallback and runs locally. The pinned pack supplies the default Gemini model; no extra model setting is needed.

The key stays in the existing owner-only `<home>/model-keys.json` store. The kernel passes it through `SWIFTNEST_MODEL_KEY_GOOGLE`; the media adapter injects `geminiApiKey` only in memory when uploads are enabled, never into generated profiles. Its `geminiKeyFile` points to `<home>/media-gemini.key`, a file Swiftnest never creates. A leftover `~/.config/swiftnest/gemini.key` or unrelated `GEMINI_API_KEY` cannot silently enable media uploads or replace the Models key.

Developers can run `SWIFTNEST_GEMINI_E2E=1 pnpm vitest run server/test/gemini.e2e.test.ts`. This opt-in test reads `~/.config/swiftnest/gemini.key` only as a test fixture, saves it as the temporary home's Google model key without printing it, and checks both real Gemini audio analysis with its privacy notice and local analysis with uploads off. If the key file is missing, the test skips without making a Google request. The fixture recording is synthetic speech, not a personal recording.

Developers can run real media checks with `SWIFTNEST_MEDIA_E2E=1 pnpm vitest run server/test/media.e2e.test.ts`. The suite uses an eSpeak-generated English voice fixture, ffmpeg and CJK/emoji fonts. It checks Chinese charts, HTML animation, a five-second video, a vertical two-HTML-scene video with music, SenseVoice transcription, speaker-labelled chat/model text and SRT, and storyboards. Besides the eSpeak voice, it uses sherpa-onnx’s public four-speaker Chinese sample. Set `SWIFTNEST_MEDIA_MODEL_CACHE=$HOME/.cache/dsh-tool-ultra/models` to reuse a writable test model cache; otherwise it uses a temporary folder.
