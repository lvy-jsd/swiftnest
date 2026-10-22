# Quick Start

Get an agent running commands safely through Swiftnest on a single machine in under five minutes.

## Prerequisites

- Node.js 24 or later (`node --version` to check)
- pnpm (`corepack enable`)
- An MCP-capable agent client, such as Cursor, DSH, or Claude Desktop

## 1. Install and Build

```bash
git clone <this repository> swiftnest
cd swiftnest
pnpm install
pnpm build
```

## 2. Check Your Environment

```bash
node packages/cli/dist/bin.js doctor
```

If anything is off, it will tell you how to fix it.

## 3. Start the Playground

```bash
node packages/cli/dist/bin.js playground
```

The playground starts a **simulated server** and a **simulated device** named `sim` on your local machine, with a "shell" capability installed. The terminal will display the MCP endpoint URL, which defaults to `http://127.0.0.1:7710/mcp`.

To change the port: `--port 7720`; for multiple simulated devices: `--devices sim,laptop`; for English: `--lang en`.

## 4. Connect Your Agent

- **HTTP-capable clients like Cursor, DSH, etc.**: Add the URL above as an MCP server.
- **Claude Desktop**: It connects via a launch command (stdio). Add the following to `claude_desktop_config.json`:

  ```json
  { "mcpServers": { "swiftnest": { "command": "node", "args": ["/full/path/to/swiftnest/packages/cli/dist/bin.js", "playground", "--stdio"] } } }
  ```

  Note: In stdio mode there is no terminal to approve calls, so calls requiring approval will time out and be rejected. To experience the approval flow, use HTTP mode instead.

## 5. Give It a Try

Tell your agent:

> Run `uname -a` on sim

It will call `sim__shell__run` and return the result directly—because `uname` is a read-only command.

Then try:

> Create the file /tmp/hello on sim

This time the agent will receive a "waiting for owner approval" status. An approval prompt will appear in the playground terminal, showing the **original command** and a risk description. The command only executes after you press `y` to approve, and the agent retrieves the result via `swiftnest__task_wait`.

## 6. View the Audit Log

Every state change for every call is logged in:

```
~/.local/state/swiftnest/playground/audit.jsonl
```

One entry per line, recording which agent, on which device, called what, with the original parameters and the outcome.

## Next Steps

- [Core Concepts](concepts.md): servers, devices, plugins, risk levels, task states
- [Write Your First Plugin](write-a-plugin.md)
