# A real second machine — NixOS VM as a Perch (2026-11-06)

This is a hands-on session record, not platform acceptance. A disposable NixOS VM played the paired
device while the host ran the Nest, and the pair was used the way an agent and its owner would use it:
pair, browse, write, execute, approve, restart. Everything below happened against real processes over
a real socket; no fixtures and no mocked transport.

## What the second machine was

|               |                                                                              |
| ------------- | ---------------------------------------------------------------------------- |
| Hypervisor    | QEMU 11.1.2, `-enable-kvm`, 2 vCPU / 2 GiB                                   |
| Guest         | NixOS 26.11, kernel 6.18.60, `hostName = swiftnest-perch`                    |
| Node in guest | v24.21.0 (glibc) — the same runtime the host compiles for                    |
| Code sharing  | `virtualisation.sharedDirectories.project`, read-only 9p mount at `/project` |
| Control       | SSH on a forwarded port with a throwaway ed25519 key                         |

The VM ran `node /project/packages/cli/dist/bin.js perch …` — the host's build, executed in the guest.
That is deliberate: it proves the two-machine path without a second toolchain, and the guest still has
its own kernel, filesystem, process table and network stack.

Host side: `swiftnest nest --lan-host 0.0.0.0 --lan-port 7711 --mcp-port 7710 --no-mdns` with a
temporary `SWIFTNEST_HOME`.

## The session

1. **Pair.** `swiftnest pair` printed a six-digit code and the Nest fingerprint; the guest connected
   with `--pair` and the same fingerprint, refused a wrong fingerprint first (by design), the request
   appeared as `p1 "vm"`, and `pair --confirm p1` brought it online over `lan`.
2. **Browse.** `files.list` on an empty folder, `files.read` of `/project/package.json` — every result
   carried the untrusted-content banner.
3. **Write → approve → verify.** `files.write` returned a task id instead of blocking; `pending` showed
   the tool, the arguments and the risk line; `approve` ran it; the file existed in the guest with the
   exact expected bytes.
4. **Execute → approve → collect.** Running the script went to approval ("not in the read-only list"),
   and `task_wait` returned the exit code and output — the "keep working, come back later" path.
5. **Move / delete.** `mkdir` and `move` were classified as writes; `delete` was classified
   **sensitive**, which is the intended difference.
6. **Load.** 20 consecutive `shell.run` calls: **20/20 succeeded, 0 errors, min 10 ms, median 11 ms,
   max 16 ms** round-trip through Nest → LAN → guest.
7. **Restart the device.** Killing the guest process and starting it again with no flags reconnected
   from the saved pairing and came back online.
8. **Restart the Nest.** The device reported `offline … retrying`, reconnected by itself, and calls
   answered again in ~35 ms.

## What the session broke, and what was fixed

| #   | Found                                                                                                                                                                                                                                                                       | Fix                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `approve <id>` rejected a truncated id with `No task …` even though `pending` prints 36-character ids the owner has to copy.                                                                                                                                                | `approve`/`deny` now accept a **unique prefix** (like a short git hash), and a miss lists the pending ids instead of claiming the task vanished.                                                                   |
| 2   | `files.write` had no way to set permission bits, so a written script failed with `Permission denied (126)`, and fixing it cost a second approval for `chmod`.                                                                                                               | `files.write` takes an optional `mode` (0–511); the TS plugin and the Rust Perch both apply it, and the manifest-parity test enforces that.                                                                        |
| 3   | **`--roots` was not persisted.** Pairing with `--roots /project,/home/perch/work` and then restarting without flags silently fell back to `~`, so the agent could suddenly read the whole home directory. Reproduced by reading a file that was outside the original scope. | The pairing file now stores `roots` and `readOnly`; an explicit flag still wins, otherwise the saved scope is used. Verified by restarting with no flags and by confirming the out-of-scope file is refused again. |
| 4   | **The audit log stored full arguments.** One 200 KB `files.write` produced four lines of 200,451 characters each — `queued`, `waiting`, `running`, `done` — so a single large write cost ~800 KB of disk and grew without bound.                                            | String arguments are truncated at 2048 characters with the original length kept (`…[truncated 197952 chars]`). The same write now costs ~2.5 KB per line, and the line still says what was written and how much.   |
| 5   | **A successful `task_cancel` came back as an error.** The result carried `isError: true` plus "check the connection and settings and retry", so a caller could conclude the cancel failed and retry a cancel that had already worked.                                       | `cancelled` is its own outcome now: `isError: false`, "Cancelled as requested. Task id: …. Nothing was executed." `denied` and `failed` still report as errors, which is right.                                    |

Unchanged by intent: the protected-location list still refuses keys and state files even inside a
shared folder, and group-loaded or already-loaded tools keep working.

## Known, deliberately not changed

- **A request that cannot succeed still asks the owner.** Reading a path outside the shared folders is
  classified sensitive and offered for approval, and the prompt itself says it "will be refused";
  approving it then fails with `PATH_NOT_ALLOWED`. The refusal is right, the interruption is not:
  feasibility should be decided before the owner is asked. This needs a policy-layer change, so it is
  recorded rather than patched here.
- **`ENOENT` carries a generic hint** ("check the connection and settings") when the real cause is a
  missing file. The error code is correct; the suggested next step is not.

## Numbers

| Check                         | Result                       |
| ----------------------------- | ---------------------------- |
| `pnpm check`                  | 425 files, no fixes          |
| `pnpm build`                  | `tsc -b` clean               |
| `pnpm test`                   | 640 passed, 89 skipped (729) |
| `cargo check --workspace`     | clean                        |
| Round-trip latency (20 calls) | median 11 ms, max 16 ms      |
| Full CI e2e recipe            | see the pull request         |

## Reproducing

```nix
# /tmp/vm/flake.nix — the disposable guest
virtualisation = {
  memorySize = 2048; cores = 2; graphics = false;
  forwardPorts = [ { from = "host"; host.port = 2222; guest.port = 22; } ];
  sharedDirectories.project = { source = "/path/to/swiftnest"; target = "/project"; writable = false; };
};
```

```sh
nix build .#nixosConfigurations.vm.config.system.build.vm
./result/bin/run-swiftnest-perch-vm &
ssh -i key -p 2222 perch@127.0.0.1 \
  'node /project/packages/cli/dist/bin.js perch --name vm --pair <code> \
     --nest ws://10.0.2.2:7711/swiftnest --fingerprint <nest-fingerprint> \
     --roots /project,/home/perch/work'
```

`10.0.2.2` is QEMU's user-mode alias for the host. Pairing still needs the fingerprint checked on the
Nest side — the code alone is not enough, which is the point.
