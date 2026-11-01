# Swiftnest Server

[English](README.md) | 中文

Swiftnest Server 装在一台常开的机器上，保存你的对话、Bot 和记忆。它内嵌锁定版本的
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH，MIT）作为内核，Swiftnest 自己的内置模块以 DSH bundle 的形式加载（`server/bundle`）。DSH 自带的 Web UI 在同一端口照常可用，第三方 DSH 插件也照样能装。

状态：阶段 0 骨架。能拉起内核、配置一个 OpenAI 兼容的模型，并提供 `GET /swiftnest/health`。团队、记忆、配对和设备在后续阶段加入。

## 运行

需要：**来自 nodejs.org 的** Node 24（DSH 的原生插件不认发行版或 Nix 编译的 Node；NixOS 上在仓库根目录用 `nix develop`），以及一个 OpenAI 兼容的模型服务，比如 Ollama。

```sh
pnpm install && pnpm build
SWIFTNEST_MODEL_BASE_URL=http://127.0.0.1:11434/v1 SWIFTNEST_MODEL_ID=qwen3 \
  node server/dist/cli.js start
```

启动后打印两个链接，重启前有效：一个在浏览器里打开 DSH Web UI，一个给 Swiftnest App 用。

## 配置

可选的 YAML 文件（`swiftnest-server start --config swiftnest.yaml`），环境变量优先。

| 字段 | 环境变量 | 默认值 |
|---|---|---|
| `home` | `SWIFTNEST_HOME` | `$XDG_DATA_HOME/swiftnest` |
| `host`（一个具体 IP，不能是 `0.0.0.0`） | `SWIFTNEST_HOST` | `127.0.0.1` |
| `port` | `SWIFTNEST_PORT` | `3077` |
| `model.baseUrl` | `SWIFTNEST_MODEL_BASE_URL` | `http://127.0.0.1:11434/v1` |
| `model.id` | `SWIFTNEST_MODEL_ID` | `qwen3` |
| `model.name`、`model.contextWindow`、`model.maxTokens` | | `Local model`、`32768`、`8192` |
| `model.apiKeyEnv`（存放密钥的变量名） | | `SWIFTNEST_MODEL_API_KEY` |
| 内核用的 Node 可执行文件 | `SWIFTNEST_KERNEL_NODE` | 运行 Swiftnest 的那个 Node |

DSH 的数据在 `<home>/dsh`。Swiftnest 每次启动都会重新生成 `swiftnest` profile；你自己的 DSH patch 写在 `<home>/dsh/profiles/swiftnest/user.patch.yml`，它最后应用，永远不会被覆盖。

## 测试

```sh
pnpm vitest run server                       # 单元测试
SWIFTNEST_E2E=1 pnpm vitest run server       # 同时启动真实内核
```

内嵌方式和原因见 [docs/en/dev/dsh-integration.md](../docs/en/dev/dsh-integration.md)。
