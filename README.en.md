<p align="center">
  <b>Swiftnest (燕巢)</b><br>
  One AI assistant across your computers and phones, powered by DSH.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg" alt="Node.js: >=24"></a>
  <img src="https://img.shields.io/badge/status-preview-orange.svg" alt="Status: preview">
</p>

<p align="center">
  English · <a href="README.md">简体中文</a>
</p>

---

## What It Is

Swiftnest is a complete personal AI Bot product. DSH supplies its runtime kernel and architectural blueprint; Grok Bot informs its product positioning, while ds-bot and ds-go inform product and interaction ideas. Multi-device experience is a central goal. Its UI and assets are independently implemented, without copying code or assets from those reference projects.

- **One assistant, multiple devices** — a central server connects companion apps on computers and phones, bringing conversation, memory, tools, and device capabilities into one workflow.
- **For everyday users and enthusiasts** — common features use safe defaults, while models, plugins, self-hosting, and advanced configuration remain extensible. An AI can handle deployment; users need not learn every installation detail.
- **Broad capability, on-demand context** — [Tool Ultra](https://github.com/lvy-jsd/dsh-tool-ultra) is an important component: one tool-plugin product organizes capabilities across scenarios and discovers and loads them as needed, instead of sending every tool schema on every request.
- **User control** — paired device identities, permissions, approvals, and auditing govern execution. Cloud services and media uploads follow their respective settings and user authorization.
- **Open interfaces** — device capabilities remain available to other agents over standard MCP as part of the assistant product.

This is a preview. Consult the relevant guides and test records for implemented behavior and limitations; the product direction is not a claim that every platform, scenario, or network condition has passed acceptance.

## Concepts

| Term               | What It Is                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Server (Nest)**  | An always-on machine that handles device registration, permissions, approvals, and auditing, and exposes all device capabilities to agents |
| **Device (Perch)** | The program running on each controlled device                                                                                              |
| **Plugin**         | Everything: device capabilities, connection methods, interaction entry points, permission policies, …                                      |

## Run the Assistant

Requires Node.js 24.9 or later and an OpenAI-compatible model service. The DSH kernel needs the official Node build from nodejs.org. NixOS also needs nix-ld enabled; the repository's `nix develop` supplies development tools.

```sh
git clone https://github.com/lvy-jsd/swiftnest.git && cd swiftnest
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @swiftnest/app build:web
node server/dist/cli.js plugins install
SWIFTNEST_APP_DIST="$PWD/client/dist" node server/dist/cli.js start
```

Open the App pairing link printed by the server. The default model endpoint is `http://127.0.0.1:11434/v1`; set the model ID and endpoint in server configuration or the App's Models page. See [Server](server/README.en.md) for configuration and [App](client/README.en.md) for native desktop and Android builds.

## Optional: Try the Device Protocol

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
