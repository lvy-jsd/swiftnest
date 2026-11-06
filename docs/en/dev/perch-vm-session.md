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

| #   | Found                                                                                                                                                                                                                                                                                                | Fix                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `approve <id>` rejected a truncated id with `No task …` even though `pending` prints 36-character ids the owner has to copy.                                                                                                                                                                         | `approve`/`deny` now accept a **unique prefix** (like a short git hash), and a miss lists the pending ids instead of claiming the task vanished.                                                                                                                                                                                                                 |
| 2   | `files.write` had no way to set permission bits, so a written script failed with `Permission denied (126)`, and fixing it cost a second approval for `chmod`.                                                                                                                                        | `files.write` takes an optional `mode` (0–511); the TS plugin and the Rust Perch both apply it, and the manifest-parity test enforces that.                                                                                                                                                                                                                      |
| 3   | **`--roots` was not persisted.** Pairing with `--roots /project,/home/perch/work` and then restarting without flags silently fell back to `~`, so the agent could suddenly read the whole home directory. Reproduced by reading a file that was outside the original scope.                          | The pairing file now stores `roots` and `readOnly`; an explicit flag still wins, otherwise the saved scope is used. Verified by restarting with no flags and by confirming the out-of-scope file is refused again.                                                                                                                                               |
| 4   | **The audit log stored full arguments.** One 200 KB `files.write` produced four lines of 200,451 characters each — `queued`, `waiting`, `running`, `done` — so a single large write cost ~800 KB of disk and grew without bound.                                                                     | String arguments are truncated at 2048 characters with the original length kept (`…[truncated 197952 chars]`). The same write now costs ~2.5 KB per line, and the line still says what was written and how much.                                                                                                                                                 |
| 5   | **A successful `task_cancel` came back as an error.** The result carried `isError: true` plus "check the connection and settings and retry", so a caller could conclude the cancel failed and retry a cancel that had already worked.                                                                | `cancelled` is its own outcome now: `isError: false`, "Cancelled as requested. Task id: …. Nothing was executed." `denied` and `failed` still report as errors, which is right.                                                                                                                                                                                  |
| 6   | **A request that could never succeed still asked the owner.** A path outside the shared folders was classified sensitive and offered for approval — with a prompt that said it "will be refused" — and approving it then failed with `PATH_NOT_ALLOWED`, so the owner's answer was wasted.           | A capability can now mark a rating `refused`, with its own reason and hint: the policy denies the call outright and no pending task is created. Verified on the live device: an out-of-scope file and a protected state file both come back `DENIED` in 7–18 ms, with "add the folder to the shared roots" and "Swiftnest never touches these" as the next step. |
| 7   | **`ENOENT` carried a generic hint** ("check the connection and settings") when the real cause was a missing file, a folder where a file was expected, or a permission problem.                                                                                                                       | Filesystem errors are named now: `PATH_MISSING` "… does not exist" with "list the folder to see what is there", `NOT_A_FILE` for a folder, `PATH_ACCESS_DENIED`, `NOT_A_FOLDER`, `FOLDER_NOT_EMPTY`. Verified against the device: `stat nope.txt` → `PATH_MISSING`, `write` over a folder → `NOT_A_FILE`.                                                        |
| 8   | **A refusal told the agent to retry.** After `swiftnest deny`, the caller got `DENIED` with the generic "check the connection and settings, then retry" — the one next step that must not be suggested, because the agent would ask the same owner the same question again.                          | A refusal now carries its own hint: "The owner refused this call. Do not repeat it; ask the owner what to do instead." An approval that expires before anyone answers says "Nobody answered in time. Ask the owner before trying again." Both verified on the live device through `task_wait`.                                                                   |
| 9   | **Cancelling a running call claimed nothing ran.** `task_cancel` on a command that had already started answered "Cancelled as requested … Nothing was executed." The command had in fact run for a while and was killed, so the caller could not tell a stopped command from one that never started. | The task snapshot records `started`, and the two cases now differ: a call stopped part-way says "It had already started and was stopped part-way", a call cancelled before it ran still says "Nothing was executed". Verified on the live device: cancelling a running `sleep 90` killed the process in the guest and said so.                                   |

Unchanged by intent: the protected-location list still refuses keys and state files even inside a
shared folder, and group-loaded or already-loaded tools keep working.

## Known, deliberately not changed

- **A symlink that points outside is only caught when the call runs.** Classification is lexical and
  does not touch the filesystem, so a _write_ through a link whose target left the shared folders is
  offered for approval first and only then refused by the real check. Verified on the device: the
  owner approved it, the call failed with `PATH_NOT_ALLOWED`, and the file outside the scope was not
  modified. Reads are auto-allowed, so they fail straight away without bothering anyone. Deciding it
  at classification time would cost a filesystem lookup on every classified call.
- **The native (Rust) host keeps one hint for every failure** (`retryHintDevice`). Refusals from its
  `files` capability do carry the specific hint now; the rest of its failures share a sentence that
  already names permissions and shared folders. Per-failure hints there would be a refactor of
  `Failure`.

## Numbers

| Check                         | Result                       |
| ----------------------------- | ---------------------------- |
| `pnpm check`                  | 427 files, no fixes          |
| `pnpm build`                  | `tsc -b` clean               |
| `pnpm test`                   | 645 passed, 89 skipped (734) |
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
