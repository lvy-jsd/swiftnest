<p align="center">
  <b>Swiftnest（燕巢）</b><br>
  以 DSH 为内核，让同一个 AI 助手跨电脑和手机办事。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="许可证：Apache-2.0"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg" alt="Node.js：>=24"></a>
  <img src="https://img.shields.io/badge/status-preview-orange.svg" alt="状态：预览版本">
</p>

<p align="center">
  <a href="README.en.md">English</a> · 简体中文
</p>

---

## 它是什么

Swiftnest 是一个完整的个人 AI Bot 产品：以 DSH 为运行内核和架构蓝图，以 Grok Bot 为产品定位参考，借鉴 ds-bot、ds-go 的产品与交互思路，重点打磨多设备体验。界面和资源独立实现，不复制参考项目的代码或素材。

- **同一个助手，多台设备** — 一个中心服务器连接电脑、手机等配套应用；聊天、记忆、工具和设备能力组成同一条使用流程。
- **兼顾大众与极客** — 常用功能使用安全默认值；模型、插件、自托管和高级配置保留扩展空间。部署可以交给 AI，不要求每位使用者掌握安装细节。
- **工具覆盖场景，上下文按需使用** — [Tool Ultra](https://github.com/lvy-jsd/dsh-tool-ultra) 是重要组成部分，以一个工具插件产品组织不同场景的能力，按需发现与加载，而不是把全部工具说明塞进每次请求。
- **控制权在用户手里** — 设备配对核对身份，调用受权限与审批约束，并保留审计；云端服务与媒体上传按对应设置和用户授权启用。
- **保留开放接口** — 设备能力仍可通过标准 MCP 接口提供给其他智能体；这也是完整助手产品的一部分。

当前是预览版本。已实现的功能和限制以对应指南及测试记录为准；产品方向不代表所有平台、场景和网络条件已经完成验收。

## 概念

| 叫法                     | 是什么                                                                     |
| ------------------------ | -------------------------------------------------------------------------- |
| **服务器（巢 / Nest）**  | 一台常开的机器，负责设备登记、权限、审批、审计，把所有设备的能力交给智能体 |
| **设备（栖点 / Perch）** | 每台被控设备上跑的程序                                                     |
| **插件**                 | 一切功能：设备能力、连接方式、交互入口、权限策略……                         |

## 运行助手

需要 Node.js 24 或更新，以及一个 OpenAI 兼容的模型服务。DSH 内核需要 nodejs.org 官方构建的 Node；NixOS 环境要求启用 nix-ld，仓库的 `nix develop` 提供开发工具。

```sh
git clone https://github.com/lvy-jsd/swiftnest.git && cd swiftnest
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @swiftnest/app build:web
node server/dist/cli.js plugins install
SWIFTNEST_APP_DIST="$PWD/client/dist" node server/dist/cli.js start
```

打开服务器打印的 App 配对链接。默认模型端点为 `http://127.0.0.1:11434/v1`；模型 ID 和端点可通过服务器配置或 App 的模型页调整。完整配置见 [Server](server/README.zh-CN.md)，原生桌面与 Android 构建见 [App](client/README.zh-CN.md)。

## 可选：单独体验设备协议

需要 Node.js 24 或更新。

```bash
git clone https://github.com/lvy-jsd/swiftnest.git swiftnest && cd swiftnest
pnpm install && pnpm build
node packages/cli/dist/bin.js playground
```

练习场会在本机启动一个模拟的服务器和一台叫 `sim` 的设备，并给出 MCP 端点地址（默认 `http://127.0.0.1:7710/mcp`）。把它填进支持 HTTP 的 MCP 客户端，然后对智能体说"在 sim 上运行 `uname -a`"。

- `ls`、`cat`、`df` 这类只读命令直接执行；
- 其他命令会在练习场的终端里弹出审批，显示原始参数，你按 `y` 才会执行；
- 审计日志在 `~/.local/state/swiftnest/playground/audit.jsonl`。

检查环境：`node packages/cli/dist/bin.js doctor`。

## 写一个插件

```bash
npm create swiftnest-plugin@latest my-plugin
cd my-plugin && npm install && npm test
```

模板里有一个最小的能力和一个在模拟服务器里跑的测试。详见 [写第一个插件](docs/zh/guide/write-a-plugin.md)。

## 文档

- [快速开始](docs/zh/guide/quickstart.md)
- [两台机器：巢 + 设备](docs/zh/guide/two-machines.md)
- [核心概念](docs/zh/guide/concepts.md)
- [写第一个插件](docs/zh/guide/write-a-plugin.md)
- [设计方案](docs/zh/design.md)

## 参与贡献

欢迎各种形式的贡献，尤其是插件。请先读 [贡献指南](CONTRIBUTING.zh-CN.md)。

## 许可证

[Apache-2.0](LICENSE)
## 界面语言

默认使用简体中文。在 App 的“偏好设置 → 语言”中可选择 English；选择保存在本机，连接服务器后同步给其他设备。
离线修改会在重连后重试。服务器与 CLI 默认中文，使用 `SWIFTNEST_LANG=en` 选择英文，
服务器 YAML 也支持 `lang: en`，环境变量优先。原生托盘、通知和文件选择窗口跟随 App 选择。
