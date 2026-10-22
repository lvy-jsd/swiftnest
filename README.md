<p align="center"><b>Swiftnest (燕巢)</b></p>
<p align="center">Turn your devices into capabilities that any agent can safely call.</p>
<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

---

> ⚠️ This project is in its early stages (M0 skeleton). APIs are still changing — do not use in production.

## What It Is

When your agent (Claude Desktop, Cursor, DSH, OpenClaw, …) wants to help you operate your computer, phone, or home server, Swiftnest handles the layer in between:

- **Pairing**: A device joins by scanning a QR code or entering a 6-digit code; after that, only that device's key is accepted (M1).
- **Capabilities**: Every feature on a device is a plugin; any existing MCP service can be turned into a capability directly.
- **Security**: Read-only operations pass through automatically; mutations, executions, and deletions require your approval; every call is logged in an audit trail.
- **Works with any agent**: Externally it's just a standard MCP endpoint, with tool names like `laptop__shell__run`.

It is not a personal assistant: conversation, memory, and personality are up to whichever agent you prefer — Swiftnest only manages devices.

## Three Words Are All You Need

| Term | What It Is |
|---|---|
| **Server (Nest)** | An always-on machine that handles device registration, permissions, approvals, and auditing, and exposes all device capabilities to agents |
| **Device (Perch)** | The program running on each controlled device |
| **Plugin** | Everything: device capabilities, connection methods, interaction entry points, permission policies, … |

## Try It in Five Minutes

Requires Node.js 24 or later.

```bash
git clone <this repository> swiftnest && cd swiftnest
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
- [Core Concepts](docs/en/guide/concepts.md)
- [Write Your First Plugin](docs/en/guide/write-a-plugin.md)
- [Design Document](docs/en/design.md)

## Roadmap

| Milestone | Status |
|---|---|
| M0 Skeleton: core, protocol, SDK, CLI capabilities, MCP endpoint, playground, plugin template | ✅ |
| M1 First Connection: standalone server + one LAN device, pairing, minimal security | In progress |
| M1.5 DSH plugin & public relay · M2 Full security · M3 Headscale mesh · M4–M6 | Planned |

See the full roadmap in [Section 14 of the Design Document](docs/en/design.md#14-roadmap).

## Contributing

Contributions of all kinds are welcome, especially plugins. Please read the [Contributing Guide](CONTRIBUTING.md) first.

## License

[Apache-2.0](LICENSE)
