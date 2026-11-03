# Swiftnest Server

[English](README.en.md) | 中文

Swiftnest Server 装在一台常开的机器上，保存你的对话、Bot 和记忆。它内嵌锁定版本的
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH，MIT）作为内核，Swiftnest 自己的内置模块以 DSH bundle 的形式加载（`server/bundle`）。DSH 自带的 Web UI 在同一端口照常可用，第三方 DSH 插件也照样能装。

可以启动内核、配置 OpenAI 兼容模型，提供 `GET /swiftnest/health`、`/app/` 网页应用及网页/桌面链接配对。团队、记忆和 Android 打包留待后续。

服务器同时托管 Nest 和 DSH kernel，将智能体的工具调用转发到已配对的 Perch。App 的设备页支持生成配对码、
核对指纹、撤销设备和审批高风险请求；聊天页也可查看审批。桌面和 Android 设备端集成另行实现。
详细步骤及 API 见[设备指南](../docs/zh/guide/devices.md)。

设备监听配置：`devices.host` 默认跟随服务器地址，`devices.port` 默认 `7711`，`devices.mdns` 默认 `true`。
对应环境变量为 `SWIFTNEST_DEVICES_HOST`、`SWIFTNEST_DEVICES_PORT`、`SWIFTNEST_DEVICES_MDNS`（`false` 关闭发现）。
身份、配对、最近在线信息和原始参数审计保存在 `<home>/devices/`。本机管理通道和 MCP 使用独立的随机进程密钥，
通过环境变量传递给 DSH；生成的 patch 不保存 bearer 密钥值。

## 运行

需要：**来自 nodejs.org 的** Node 24（DSH 的原生插件不认发行版或 Nix 编译的 Node；NixOS 上在仓库根目录用 `nix develop`），以及一个 OpenAI 兼容的模型服务，比如 Ollama。

```sh
pnpm install && pnpm build
pnpm --filter @swiftnest/app build:web
SWIFTNEST_MODEL_BASE_URL=http://127.0.0.1:11434/v1 SWIFTNEST_MODEL_ID=qwen3 \
  node server/dist/cli.js start
```

启动后打印三个重启前有效的链接：DSH Web UI、供桌面应用粘贴的配对链接，以及 **App (web)**
（`<root>/app/#/pair?url=<编码后的配对链接>`）。打开最后一个即可自动配对，再选择“新建聊天”发送消息。
应用会清除地址栏的配对链接，只记住服务器根地址，网页认证留在浏览器 Cookie jar。
阶段 0 刷新、断线或服务器重启后需要重新配对。包含启动令牌的链接应当保密。

同一 Wi-Fi 的其他设备访问时，将 `SWIFTNEST_HOST` 设置为服务器具体的局域网 IP，不能使用通配地址，
然后打开对应的 App (web) 链接。明文 HTTP 仅用于可信网络。网页应用必须与 API 同源；桌面应用通过原生
HTTP/WebSocket 传输访问，不放宽内核来源校验，详见[客户端配置与权限](../client/README.zh-CN.md)。

`@swiftnest/server` 默认从已安装的可选 `@swiftnest/app` 包解析 `dist` 目录，
`appDist` / `SWIFTNEST_APP_DIST` 可覆盖它；源码开发可设置 `SWIFTNEST_APP_DIST="$PWD/client/dist"`。
未安装或未构建应用时，`/app/` 返回明确的 404，不影响内核和 DSH 页面启动。
应用外壳无需 DSH 认证，API 仍需配对。静态路由拒绝路径穿越和越界符号链接，设置 MIME，页面路由回退首页，
带哈希的资源采用 immutable 缓存，首页重新验证。

## Tool Ultra

[Tool Ultra](https://github.com/lvy-jsd/dsh-tool-ultra)（Apache-2.0）默认启用，提供按需工具加载、工具目录、风险审批、原生工具包和设备命名空间。产品完成前不发布到 npm，服务器从固定提交 `8ccfefa1a922ad407e57ecbe6ea8b68e24adcbd9` 构建。

```sh
swiftnest-server tools install --config swiftnest.yaml
swiftnest-server start --config swiftnest.yaml
```

源码仓库中可用 `node server/dist/cli.js` 替代 `swiftnest-server`。安装需要 Git、npm、Node 24 和网络；安装与启动必须使用相同的配置或 `SWIFTNEST_HOME`。安装目录为 `<home>/vendor/dsh-tool-ultra-8ccfefa1a922`，重复安装会跳过成功构建，失败会清理未完成目录。启动不会自动下载，未安装时仅打印提示并正常启动。

可通过 YAML `toolUltra: false` 或 `SWIFTNEST_TOOL_ULTRA=false` 关闭。各包的 `cordis.patch.yml` 是默认配置的唯一来源；操作员的 `user.patch.yml` 最后应用。`tools_load` 的风险审批显示在 App 聊天中，设备执行仍须通过 Nest 的权限检查。[完整指南](../docs/zh/guide/tool-ultra.md)。

## 配置

可选的 YAML 文件（`swiftnest-server start --config swiftnest.yaml`），环境变量优先。

| 字段                                                   | 环境变量                   | 默认值                                                                      |
| ------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------- |
| `home`                                                 | `SWIFTNEST_HOME`           | `$XDG_DATA_HOME/swiftnest`                                                  |
| `host`（一个具体 IP，不能是 `0.0.0.0`）                | `SWIFTNEST_HOST`           | `127.0.0.1`                                                                 |
| `port`                                                 | `SWIFTNEST_PORT`           | `3077`                                                                      |
| `appDist`                                              | `SWIFTNEST_APP_DIST`       | 已安装的 `@swiftnest/app/dist`，否则不可用                                  |
| `persona`（字符串）                                    | `SWIFTNEST_PERSONA`        | `You are a helpful assistant in Swiftnest, powered by the {{model}} model.` |
| `assistantName`（字符串）                              | `SWIFTNEST_ASSISTANT_NAME` | 不设置（App 显示“助手”）                                                    |
| `model.baseUrl`                                        | `SWIFTNEST_MODEL_BASE_URL` | `http://127.0.0.1:11434/v1`                                                 |
| `model.id`                                             | `SWIFTNEST_MODEL_ID`       | `qwen3`                                                                     |
| `model.name`、`model.contextWindow`、`model.maxTokens` |                            | `Local model`、`32768`、`8192`                                              |
| `model.apiKeyEnv`（存放密钥的变量名）                  |                            | `SWIFTNEST_MODEL_API_KEY`                                                   |
| 内核用的 Node 可执行文件                               | `SWIFTNEST_KERNEL_NODE`    | 运行 Swiftnest 的那个 Node                                                  |

DSH 的数据在 `<home>/dsh`。Swiftnest 每次启动都会重新生成 `swiftnest` profile；你自己的 DSH patch 写在 `<home>/dsh/profiles/swiftnest/user.patch.yml`，它最后应用，永远不会被覆盖。

`persona` 同时设置共享 system-prompt 的前缀和 DSH 自带的各个智能体预设的人设；
DSH 会在运行时把 `{{model}}` 替换成模型身份。例如：

```yaml
persona: "你是 Swiftnest 中的助手小雨，由 {{model}} 模型驱动。"
```

每次启动时，服务器从锁定版本的 DSH 所安装的 web bundle 中读取预设并生成覆盖行。
只替换 persona 前缀，保留预设其余内容及未经求值的 `!!js` 表达式；没有 persona 的预设保持原样。
用户 patch 仍然优先。DSH patch 会替换目标行的整个 `config`，因此手动覆盖预设时须提供完整配置。

## 测试

```sh
pnpm vitest run server                       # 单元测试
SWIFTNEST_E2E=1 pnpm vitest run packages/api server # 真实内核与假模型聊天
SWIFTNEST_WEB_E2E=1 pnpm vitest run client/test/web.e2e.test.ts # 可选 Chromium 应用流程
```

Chromium 测试前先构建网页。浏览器无法启动时会干净跳过，可设置 `SWIFTNEST_CHROMIUM=/path/to/chrome`
指定系统浏览器。不需要外部模型凭据。

内嵌方式和原因见 [docs/en/dev/dsh-integration.md](../docs/en/dev/dsh-integration.md)。

## 界面语言

默认使用简体中文。在 App 的“偏好设置 → 语言”中可选择 English；选择保存在本机，连接服务器后同步给其他设备。
离线修改会在重连后重试。服务器与 CLI 默认中文，使用 `SWIFTNEST_LANG=en` 选择英文，
服务器 YAML 也支持 `lang: en`，环境变量优先。原生托盘、通知和文件选择窗口跟随 App 选择。
