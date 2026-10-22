# Core Concepts

## Server, Device, Plugin

- **Server (Nest)**: A machine that stays on. It registers devices, enforces permissions, handles approvals, writes audit logs, and aggregates all device capabilities into a single MCP endpoint for agents.
- **Device (Perch)**: The program running on each managed device. It hosts local capabilities, executes calls locally, and enforces timeouts and cancellations on the device itself.
- **Plugin**: The carrier of all functionality. Capabilities, connection methods, interaction entry points, permission policies, storage… all of these are plugins. Official and community plugins have equal standing.

A single machine can be both a server and a device. You can try it with just one machine (the practice yard works this way).

## Tool Names

The tool name agents see is `<device>__<capability>__<tool>`, for example `laptop__shell__run`. Double underscores are used instead of dots because function names in model APIs from OpenAI, Anthropic, and others don't allow dots.

There are also a few task tools:

| Tool | Purpose |
|---|---|
| `swiftnest__devices` | List online devices and their capabilities |
| `swiftnest__task_status` | Check task status and results |
| `swiftnest__task_wait` | Wait for a task to finish (e.g., waiting for the owner to approve) |
| `swiftnest__task_cancel` | Cancel a pending or running task |

**There is no "approve" tool**: an agent can never approve its own request; only a human can approve, from the terminal or the dashboard.

## Risk Levels

Each tool declares a default risk level. Capabilities can also re-evaluate based on specific parameters (for example, the shell capability classifies `ls` as "read" and `rm` as "sensitive").

| Risk | Meaning | Default |
|---|---|---|
| `read` | Observe only; change nothing | Allow |
| `write` | Change local state | Ask |
| `exec` | Execute code | Ask |
| `sensitive` | Delete, modify system, spend money, send messages externally | Ask (rules cannot override this to auto-allow) |

Rules can tighten or loosen permissions by client, device, capability, tool, and risk level (sensitive operations excluded).

## Task States

```
queued → pending_approval → running → succeeded
                                   ↘ failed / denied / timed_out / cancelled
```

- Calls that require approval return "pending approval + task ID" immediately, so the agent can do other things in the meantime;
- Each device has a limit on concurrent running calls (default 4); excess calls are queued;
- Unattended approvals expire after 10 minutes (denied);
- Timeouts and cancellations propagate to the device and actually terminate the corresponding process.

## Audit

Every state change for every task is written to an append-only audit log: timestamp, client, device, capability, tool, **raw parameters**, state, reason, error. Plugins have no way to modify the audit log.

## Errors

All errors use a unified format: `code` (error code), `message` (what went wrong), `suggestion` (how to fix it), `retryable` (whether retrying is useful).

## Links and pairing

- Every link between a device and the Nest (the LAN today; relay and Headscale later) carries **the same encrypted session**: both sides prove their Ed25519 identity keys, ephemeral X25519 keys agree on session keys, and every message is AES-256-GCM encrypted with an increasing counter — a tampered, replayed or reordered message ends the connection at once. Whether the link itself is encrypted (plain `ws://`, say) does not matter for safety.
- **Pairing**: the Nest gives a one-time 6-digit code (5 minutes, single use, dropped after 5 wrong tries). The device sends an HMAC bound to this session, never the code itself; then each side checks the other's fingerprint, and both must confirm. Afterwards the device remembers the Nest's key and the Nest the device's; a changed key on either side is refused.
- **Revoking**: `swiftnest revoke <device>` disconnects it now and forgets it; the device is told why, stops reconnecting and deletes its saved pairing.

## Capabilities on a device

| Capability | Tools | Risk |
|---|---|---|
| Shell `shell` | `run` | read-only commands are reads; pipes, redirects and the like are exec; `rm`, `sudo`… are sensitive |
| Files `files` | `list`, `read`, `stat` / `write`, `mkdir`, `move` / `delete` | read / write / sensitive; any path outside the shared folders is sensitive and refused |

The files capability works only inside the shared folders (the home directory by default). Paths are resolved to their real location before the check, so a symlink cannot lead out; keys, credentials and browser data are always refused.
