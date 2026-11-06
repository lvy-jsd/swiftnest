# Tool Ultra

Tool Ultra 是 Swiftnest 所有者维护的 DSH 插件（[源码](https://github.com/lvy-jsd/dsh-tool-ultra)，Apache-2.0）。它让模型先浏览、查找，再加载需要的原生工具，减少每轮传入的工具定义。产品完成前不发布到 npm；Swiftnest 固定从提交 `4c593acee080dc615b651348e70c4ae6ec5217a5` 构建。

## 安装与启用

准备 Git、npm、Node 24 和网络，使用服务器的同一个配置与数据目录：

```sh
swiftnest-server plugins install --config swiftnest.yaml
swiftnest-server start --config swiftnest.yaml
```

源码安装可运行 `node server/dist/cli.js plugins install`。配置文件可省略；通过 `SWIFTNEST_HOME` 指定数据目录时，两个命令须设置相同的值。

安装仅获取固定提交，在 `<home>/vendor/dsh-tool-ultra-4c593acee080` 中使用 Swiftnest 附带的依赖锁文件运行 `npm ci`、`npm run build`。仅在成功后写入构建标记，重复运行直接复用；失败会清理未完成目录，下次可重试。依赖链接指向 Server 自带的 DSH。安装不会使用或发布 npm 上的 Tool Ultra 包。

首次安装还需从 npm 下载图像和本地语音运行库，下载量因系统而异，与首次转写时下载的语音模型是两回事。网络超时后，可在连接恢复后重试同一个安装命令。

Tool Ultra 默认启用，固定提交写在 [`server/plugins.json`](https://github.com/lvy-jsd/swiftnest/blob/main/server/plugins.json)。启动时若未安装，会给出安装提示并继续运行；启动不会自动获取源码。关闭方法：

```yaml
plugins:
  tool-ultra: false
```

或设置 `SWIFTNEST_PLUGINS=tool-ultra=false`，环境变量优先。安装后重启 Server 生效。其他插件见[插件](./plugins.md)。

构建依赖使用 `mathjs 15.2.0` 安全覆盖，修复固定源码原有依赖的[表达式执行漏洞](https://github.com/josdejong/mathjs/security/advisories/GHSA-29qv-4j9f-fjw5)；源码提交和插件默认配置保持不变。

Tool Ultra 自带的管理面板（`panel`）随其它包一起安装启用，提供工具目录、会话占用与审计记录。它挂在 DSH 的 Settings →「工具管理」里。

## 在 App 里管理工具

打开 **设置 → 插件 → 工具**，在 **MCP 预设** 中逐项开关服务。所有预设默认关闭。开启后若仍缺少密钥或允许访问的文件夹，该行会显示缺少的设置，以及 Tool Ultra 提供的获取提示。请让服务器管理员按提示在预设的 YAML 配置或服务器环境变量中补齐。清单来自已安装的 Tool Ultra 构建；清单为空时请先安装并启用插件。

在 **命名能力包** 中填写名称、每行一个目标，再点击 **保存能力包**。已有能力包会显示名称和目标；用同名保存可替换目标，点击 **删除** 可移除。名称使用 1–48 个小写字母、数字或连字符，以字母或数字开头。例如创建 `research`，包含 `pack:web` 和 `pack:media`，助手就能用 `cap:research` 一起加载；原有权限和审批仍然生效。

App 更改保存在 `<home>/tool-settings.json`，优先于 YAML 中的开关和能力包声明。删除也会覆盖 YAML 声明，重启后不会重新出现。**保存后必须点击“应用更改”，重启内核才会生效。** 如果新工具设置无法启动，Swiftnest 会恢复之前的设置并再次重启。

## 怎么找到工具

`tools_ls` 带查询时分三层回答，先便宜的后贵的：

1. **关键词** —— 查询的每个词都出现在工具名、组、分类或描述里。
2. **排序索引** —— 关键词一个都没命中时，用同一份目录在进程内打分排序，不再要求所有词都出现。
   它不需要模型、不需要网络，也不占 schema token：这是内存，不是工具。
3. **模型回退** —— 关键词完全读不懂的请求，才值得让小模型看一眼。这一步需要配置模型，而 Swiftnest
   默认不配置，所以全新安装的行为就是第一层加第二层。

召回探针的实测（30 个请求，其中一半是人的说法）：改动前 80.0%，加排序索引后 **96.7%**，再配上能读懂
最后那条请求的模型是 **100%**。

## 命名工具包

`capability-bridge` 让你把一组目标起个名字，一次调用就能全部备好：

```yaml
capabilities:
  packs:
    workstation: device:current
    research: [pack:web, pack:media]
```

模型用 `tools_load(["cap:workstation"])` 加载它。工具包只是已有目标的一个别名，所以加载它和逐个加载
走的是同一套审批。

## MCP 服务器

`pack-mcp` 会启动常见的 MCP 服务器（memory、sequential thinking、Context7、Playwright、GitHub、搜索引擎、
Notion、地图）。**默认一个都不启动**：Swiftnest 把 `defaults` 设为 `false`，所以全新安装不会连接任何外部
服务。只有你列出来的预设才会启动：

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

需要密钥或设置的预设会一直等到配置齐全；模型可以用 `mcp_presets` 工具查看每个预设的状态。已启动预设的
工具以 `mcp__<preset>__*` 出现，可以按路径加载；其中写文件和删除类的工具标为高危，加载时同样要过风险闸
的审批。

## 工具与审批

启用的包为 `core`、`classifier-rules`、`classifier-llm`、`risk-gate`、`persist`、`pack-essentials`、`pack-web`、`pack-mcp`、`capability-bridge`、`devices`、`pack-media`。默认配置从各包自己的 `cordis.patch.yml` 读取，生成绝对路径的 DSH `insert` 行。自定义配置放在 `<home>/dsh/profiles/swiftnest/user.patch.yml`，最后应用且不被改写；DSH 的配置覆盖会替换整行 `config`，修改时须保留需要的其他字段。

模型可通过 `tools_ls` 浏览目录、`tools_find` 查找工具，通过 `tools_load` 加载。例如：

```json
{ "targets": ["device:all"] }
```

它会加载已配对设备的工具，下一轮即可看到 `device__<slug>__<capability>`。也可使用 `device:<slug>/files` 限定范围。目录加载不会绕过设备权限，也不会自动运行工具。

高风险工具需单独加载，风险门会通过 DSH 的 `approval-request` 交互请求批准。App 聊天显示工具名称和原因，可批准一次或拒绝；无审批回答或请求被取消时不会获得许可。设备执行审批是另一个步骤，仍由 Nest 的设备权限规则控制。

## 验证

开发者可在构建后运行：

```sh
pnpm build
SWIFTNEST_TOOL_ULTRA_E2E=1 pnpm vitest run server/test/tool-ultra.e2e.test.ts
```

测试使用临时数据目录、真实 DSH 内核、脚本模型和配对的 Node Perch。要同时验证 App 中的批准与拒绝按钮，先构建 App 并准备 Chromium，再额外设置 `SWIFTNEST_WEB_E2E=1`（可用 `SWIFTNEST_CHROMIUM` 指定浏览器）。CI 会运行这条完整链路。

## 媒体工具

直接在聊天中说“画一张中文图表”“做一段铃声”或“生成一个短视频”即可。媒体包随 Tool Ultra 默认启用，无需 API key；模型可用 `tools_load` 的 `{"targets":["pack:media"]}` 加载。`html_render` 用 HTML/CSS 制作海报、卡片或幻灯片，支持中文和表情，也能把 CSS 动画保存成 GIF/WebP；`svg_render` 把 SVG 绘图变成图片，`chart_render` 绘制 Vega-Lite 图表，`music_render` 生成 MIDI/WAV 音乐，`video_render` 将 HTML、SVG 或图片场景和可选配乐合成 MP4。`audio_transcribe` 把录音变成带时间戳的文字和 SRT 字幕；`video_understand` 返回视频时长、画面与声音信息、场景切换时间、带时间标记的故事板图片和语音文字。故事板按场景切换选取关键帧，较长镜头会多取几帧；未发现切换时均匀取帧。

例如可以说：“做一个 1080×1920 的竖屏短片，两个场景分别是早安和出发，加弹跳字幕、转场和轻快配乐。”也可上传录音后说“转成文字和字幕”，再让助手把字幕加入视频。视频支持淡入淡出、滑动、擦除、圆形和直接切换，帧率可选 24、30 或 60。

HTML 绘制由 Takumi 在本地完成，无需浏览器。脚本、网络字体和外部链接会被拒绝；可使用内嵌图片或已生成文件。中文需安装 Noto Sans CJK 等字体，彩色表情需 Noto Color Emoji。页面语言跟随服务器语言；有 fontconfig 时自动寻找字体，没有时可由管理员通过媒体包的 `fontFiles` 指定本机字体。

首次生成音乐会尝试下载约 24 MB 的 FluidR3 Mono GM 乐器音色库到 `<home>/models/soundfonts`，并校验 SHA-256；后续使用缓存，不需要反复下载。默认地址是 `raw.githubusercontent.com`，国内可能无法访问。目前没有配置经过验证的国内自动镜像；下载失败时会自动使用内置合成器，并在工具结果中说明，仍可生成配乐。管理员可以选择可信的同文件 HTTPS 镜像，或使用本地 `.sf2`/`.sf3` 文件（本地文件优先）：

```yaml
media:
  soundfontUrl: https://your-mirror.example/FluidR3Mono_GM.sf3
  # 或使用本地文件，无需下载：
  # soundfont: /srv/sounds/library.sf3
```

这两项均可省略；请勿直接照抄示例镜像地址。更换镜像仍会校验默认音色库的 SHA-256。音色库下载与下面的语音模型下载是两回事。

生成文件会显示在聊天中：可以预览图片、播放音视频、下载文件，或点击“发送文件到…”发给已配对的手机。请选择手机上已共享的接收文件夹，并在手机上批准传输。生成文件保存在 `<home>/files/media`，通过文件传输接收的手机上传位于 `<home>/files` 下；媒体工具仅能读取这些目录，拒绝其他路径以及指向目录之外的符号链接。

视频和语音工具使用 PATH 中的 `ffmpeg`、`ffprobe`。缺少时，聊天会提示安装 ffmpeg，其他功能照常运行。中文绘图需要 Noto Sans CJK 等中文字体；系统有 fontconfig 时会快速检查字体。

首次转写会下载约 200 MB 的语音和说话人模型到 `<home>/models/sherpa-onnx`，聊天会显示首次准备提示。语音识别通过 sherpa-onnx 在本地 CPU 上运行，默认使用 SenseVoice Small（FunAudioLLM / FunASR）和 4 个线程，可识别中文、粤语、英语、日语、韩语，以及情绪和笑声等声音。其他语言会自动使用 Whisper large-v3-turbo，另需下载约 540 MB。Gemini 上传关闭时，录音留在服务器。

默认开启说话人分离（`speakers: true`）：多人录音中的“Speaker 1”“Speaker 2”等标签会保留到聊天、模型收到的文本和 SRT 字幕中；只有一个声音时不加标签。单人录音可要求跳过说话人分离（`speakers: false`），转写会更快。

模型来自 sherpa-onnx 的 GitHub Releases。中文服务器优先使用公共下载镜像 `gh-proxy.com`；英文服务器检查一个小模型的 GitHub 下载地址，最多等待两秒，无法访问时切换该镜像。验证时镜像可达，实际网络的可用性可能不同。媒体包仍会校验所有模型的 SHA-256。管理员可在服务器 YAML 中指定下载基址（须保留完整发布路径，末尾斜杠会自动补齐）：

```yaml
media:
  modelMirror: https://github.com/k2-fsa/sherpa-onnx/releases/download/
```

此可选示例可让中文服务器也直接使用 GitHub。镜像必须提供相同的发布子路径和文件。媒体包的高级选项 `speechModel` 支持 `sensevoice`（默认）和 `whisper-turbo`，`speechThreads` 默认为 4，普通使用无需修改。

纯文本模型收到事实、转写和故事板路径，不会收到图片字节。App 仍会为你展示故事板；模型需要支持视觉并使用图片读取工具才能查看画面。

### 可选的 Google Gemini 分析

录音和视频默认在本地处理。需要更好的转写和视频理解时，打开**模型 → 录音和视频**，开启**录音和视频交给 Google Gemini 分析（会上传到 Google）**。开启后，整份录音或视频会离开这台电脑并发送给 Google，请只用于你愿意交给 Google 的文件。关闭时，录音和视频都在本地分析。

开关复用模型页面已经保存的 Google 密钥。未添加时，开关保持关闭，并打开 Google 密钥入口，其中有创建密钥的链接。在那里保存密钥，返回后开启开关，再点击**应用更改**。应用时会像其他模型设置一样重启助手。删除 Google 密钥也会关闭上传；同样需要应用更改。

仅当开关开启且已保存 Google 密钥时，`audio_transcribe`、`video_understand` 的 `engine: auto` 才会使用 Gemini。`engine: local` 始终使用本地；即使指定 `engine: gemini` 也不能绕过关闭的开关。Gemini 结果开头会显示隐私提示：“analysed by Gemini … (file uploaded to Google)”。Google 不可用时会说明原因并改用本地。Gemini 默认模型由固定版本的媒体包提供，无需另外设置。

密钥仍只保存在原有的所有者专用 `<home>/model-keys.json` 中。内核通过 `SWIFTNEST_MODEL_KEY_GOOGLE` 传递密钥；媒体适配层仅在上传开启时将它作为内存中的 `geminiApiKey` 传给媒体包，不写入生成的 profile。`geminiKeyFile` 指向 `<home>/media-gemini.key`，Swiftnest 从不创建该文件。遗留的 `~/.config/swiftnest/gemini.key` 或其他 `GEMINI_API_KEY` 不会静默开启上传，也不会取代模型页面的 Google 密钥。

开发者可运行 `SWIFTNEST_GEMINI_E2E=1 pnpm vitest run server/test/gemini.e2e.test.ts`。该自选测试仅将 `~/.config/swiftnest/gemini.key` 作为测试输入，保存为临时数据目录中的 Google 模型密钥，全程不打印。它验证真实 Gemini 录音分析及其隐私提示，再验证关闭上传后的本地分析。密钥文件不存在时，测试会跳过，不会请求 Google。测试使用合成语音，不使用私人录音。

开发者真实测试：`SWIFTNEST_MEDIA_E2E=1 pnpm vitest run server/test/media.e2e.test.ts`。测试使用 eSpeak 合成的英文语音、ffmpeg、中文/表情字体，验证中文图表、HTML 动画、5 秒视频、两段 HTML 的竖屏配乐短片、SenseVoice 转写、聊天/模型文本和 SRT 中的说话人标签，以及故事板。除 eSpeak 语音外，还使用 sherpa-onnx 公开的四人中文录音。运行时可设置 `SWIFTNEST_MEDIA_MODEL_CACHE=$HOME/.cache/dsh-tool-ultra/models` 复用可写的测试模型缓存；不设置则使用临时目录。
