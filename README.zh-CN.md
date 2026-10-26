<p align="center">
  <b>Swiftnest（燕巢）</b><br>
  把你的设备变成任何智能体都能安全调用的能力。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="许可证：Apache-2.0"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg" alt="Node.js：>=24"></a>
  <img src="https://img.shields.io/badge/status-early%20stage%20(M1)-orange.svg" alt="状态：早期（M1）">
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

---

## 它是什么

你的智能体（Claude Desktop、Cursor、DSH、OpenClaw……）想帮你操作电脑、手机、家里的服务器时，Swiftnest 负责中间那一层：

- **配对** — 设备输入 6 位一次性码加入，两边核对指纹后，之后只认这台设备的密钥；链路端到端加密。
- **能力** — 每台设备上的功能都是插件，任何现成的 MCP 服务都能直接变成能力。
- **安全** — 只读操作直接放行；改动、执行、删除需要你批准；每次调用都记审计日志。
- **任何智能体** — 对外就是一个标准的 MCP 端点，工具名形如 `laptop__shell__run`。

它不是个人助手：对话、记忆、人格交给你喜欢的智能体，Swiftnest 只管设备。

## 概念

| 叫法 | 是什么 |
|---|---|
| **服务器（巢 / Nest）** | 一台常开的机器，负责设备登记、权限、审批、审计，把所有设备的能力交给智能体 |
| **设备（栖点 / Perch）** | 每台被控设备上跑的程序 |
| **插件** | 一切功能：设备能力、连接方式、交互入口、权限策略…… |

## 快速开始

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