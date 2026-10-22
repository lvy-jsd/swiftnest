# Two machines: a Nest and a device

Use an always-on machine (a home server, say) as the **Nest** and your laptop as a **device**. Once they are paired, an agent connected to the Nest can run commands and read or write files on the laptop — reads run at once, everything else waits for your approval.

> The [quick start](./quickstart) on one machine makes this easier to follow. Below, `swiftnest` means `node packages/cli/dist/bin.js` (run `pnpm install && pnpm build` on both machines first).

## 1. Start the Nest on the server

```bash
swiftnest nest
```

It shows:

- the **Nest fingerprint** (four groups of four, e.g. `9c6c-2c10-7344-93c7`), which you check while pairing;
- the port devices connect to (default `7711`, LAN, end-to-end encrypted);
- the address agents connect to (default `http://127.0.0.1:7710/mcp`, this machine only).

The Nest's key, paired devices and audit log live in `~/.local/state/swiftnest/nest/` (change it with `SWIFTNEST_HOME`).

**Firewall**: devices must reach TCP `7711` on the server. Finding the Nest automatically uses mDNS (UDP `5353`), which many Linux distributions (NixOS included) block by default — that is fine: start the device with `--nest ws://<server address>:7711/swiftnest`.

## 2. Pair

On the server, in **another terminal**:

```bash
swiftnest pair
```

It shows a **6-digit pairing code** (valid for 5 minutes, one device) and the Nest fingerprint.

On the laptop:

```bash
swiftnest perch --name laptop --pair 123456
# if it cannot find the Nest:
swiftnest perch --name laptop --pair 123456 --nest ws://192.168.1.10:7711/swiftnest
```

Then **confirm a fingerprint on each side**:

| Where | Shows | What you do |
|---|---|---|
| Laptop | the Nest's fingerprint | compare with what `swiftnest pair` shows; answer `y` if they match |
| Server (the `swiftnest pair` terminal) | the laptop's fingerprint | compare with what the laptop printed at start; answer `y` if they match |

Why both: the code proves the owner allowed it, but a 6-digit code can be guessed offline by someone in the middle; matching fingerprints prove nobody is.

Once paired, the laptop shows `● online`. From then on, `swiftnest perch --name laptop` connects with the saved pairing and reconnects by itself after a drop.

**Which files are shared**: the home directory by default; narrow it with `--roots ~/projects,~/notes`. Whatever you set, `~/.ssh`, `~/.gnupg`, cloud credentials, password stores, browser profiles and Swiftnest's own keys are **always refused**.

## 3. Connect an agent

On the server (when the agent runs on the same machine as the Nest):

- **Claude Code**: `claude mcp add --transport http swiftnest http://127.0.0.1:7710/mcp`
- **Cursor, DSH and other HTTP MCP clients**: `http://127.0.0.1:7710/mcp`
- **Claude Desktop**: in `claude_desktop_config.json`
  ```json
  "swiftnest": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:7710/mcp"] }
  ```

The agent sees tools such as `laptop__shell__run` and `laptop__files__read`. Try: "run `echo ok` on laptop".

## 4. Approvals

- Read-only commands such as `ls`, `cat`, `df`, and reading files: run at once.
- Other commands and writing files: wait for your approval. **Sensitive** ones — `rm`, `sudo`, deleting files — always ask, and no rule can make them automatic.

The Nest's terminal asks `[y/N]` directly. When the Nest runs in the background:

```bash
swiftnest pending              # calls waiting for approval, with the raw arguments and the risk
swiftnest approve <task-id>
swiftnest deny <task-id>
```

Approvals nobody answers are denied after 10 minutes. An agent can cancel a running call with `swiftnest__task_cancel`; the process on the device is really stopped.

## 5. Review and revoke

```bash
swiftnest devices                     # paired devices, online or not, and their tools
swiftnest audit -n 50                 # latest audit entries: who, which device, what, and the outcome
swiftnest revoke laptop               # disconnect now and forget it; it has to pair again to come back
```

**Ctrl+C** on the laptop disconnects at once, too.

## When something goes wrong

| What you see | Why, and what to do |
|---|---|
| The laptop keeps "looking for the Nest" | a firewall drops mDNS: add `--nest ws://<server address>:7711/swiftnest` |
| `NOT_PAIRED` | the device was never paired, or was revoked: run `swiftnest pair` again |
| `NEST_KEY_CHANGED` | the Nest at that address is not the one you paired with (reinstalled, or someone impersonating it): check, then pair again |
| `PAIRING_CLOSED` | the Nest is not pairing right now: run `swiftnest pair` first and use the code within 5 minutes |
| `NEST_NOT_RUNNING` | `swiftnest pair` and friends cannot find a running Nest: start `swiftnest nest` first |
