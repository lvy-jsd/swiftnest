<p align="center">
  <b>Swiftnest (燕巢)</b><br>
  Turn your devices into capabilities that any agent can safely call.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg" alt="Node.js: >=24"></a>
  <img src="https://img.shields.io/badge/status-early%20stage%20(M1)-orange.svg" alt="Status: early stage (M1)">
</p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

---

## What It Is

When your agent (Claude Desktop, Cursor, DSH, OpenClaw, …) wants to help you operate your computer, phone, or home server, Swiftnest handles the layer in between:

- **Pairing** — a device joins with a one-time 6-digit code and a fingerprint check on both sides; after that only its key is accepted, and the link is end-to-end encrypted.
- **Capabilities** — every feature on a device is a plugin; any existing MCP service can be turned into a capability directly.
- **Security** — read-only operations pass through automatically; mutations, executions, and deletions require your approval; every call is logged in an audit trail.
- **Any agent** — externally it is just a standard MCP endpoint, with tool names like `laptop__shell__run`.

It is not a personal assistant: conversation, memory, and personality are up to whichever agent you prefer — Swiftnest only manages devices.

## Concepts

| Term | What It Is |
|---|---|
| **Server (Nest)** | An always-on machine that handles device registration, permissions, approvals, and auditing, and exposes all device capabilities to agents |
| **Device (Perch)** | The program running on each controlled device |
| **Plugin** | Everything: device capabilities, connection methods, interaction entry points, permission policies, … |

## Quick Start

Requires Node.js 24 or later.

```bash
git clone https://github.com/lvy-jsd/swiftnest.git swiftnest && cd swiftnest
pnpm install && pnpm build
node packages/cli/dist/bin.js playground
```

The playground starts a simulated server and a device called `sim` on your local machine, and prints the MCP endpoint URL (default `http://127.0.0.1:7710/mcp`). Paste it into any MCP client that supports HTTP, then tell your agent to "run `uname -a` on sim".

- Read-only commands like `ls`, `cat`, `df` execute immediately;
- Other commands trigger an approval prompt in the playground terminal, showing the raw arguments — they only run when you press `y`;
- The audit log is at `~/.local/state/swiftnest/playground/audit.jsonl`.

Check your environment: `node packages/cli/dist/bin.js doctor`.

## Write a Plugin

```bash
npm create swiftnest-plugin@latest my-plugin
cd my-plugin && npm install && npm test
```

The template includes a minimal capability and a test that runs against the simulated server. See [Write Your First Plugin](docs/en/guide/write-a-plugin.md).

## Documentation

- [Quick Start](docs/en/guide/quickstart.md)
- [Two machines: a Nest and a device](docs/en/guide/two-machines.md)
- [Core Concepts](docs/en/guide/concepts.md)
- [Write Your First Plugin](docs/en/guide/write-a-plugin.md)
- [Design Document](docs/en/design.md)

## Contributing

Contributions of all kinds are welcome, especially plugins. Please read the [Contributing Guide](CONTRIBUTING.md) first.

## License

[Apache-2.0](LICENSE)