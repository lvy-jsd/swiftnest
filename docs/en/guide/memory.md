# Memory

Open **Memory** from the App's main menu on desktop, phone or web. Add, edit or delete individual facts, or open a topic to edit its Markdown. Rejected changes show the server's reason. All Apps share the central server's memory; Apps do not keep a separate memory store.

The assistant can use `remember` (text and an optional topic), `forget` (entry text or id), and `recall` (list everything, search with `query`, or read a whole `topic`). Saving an identical entry in the same location quietly reports that it was already saved.

**Remember important things automatically** is on by default. After a chat has been quiet for two minutes, its own main model reviews only the new messages for durable owner preferences, people, projects and standing instructions. Existing facts are supplied so newer contradictory facts can replace them by ID. There is no additional model service: memory stays on the server, and reviews use the chat's existing model (a cloud model still sends the review to that same provider). Strict JSON validation, secret checks and storage limits apply to the entire proposal before any change is saved.

Use the switch on the Memory page to stop or resume reviews. **Recently remembered automatically** shows the latest 50 current auto-saved facts with dates; one tap deletes a fact through the usual delete path. Topic editing is under **More memory options**. The server persists the switch and each chat's review cursor in `memory/auto.json`; facts and cursor advance in one recoverable transaction. Only one review runs at a time across all chats; queued chats wait for a fresh quiet period if a new turn arrives. Restarts also check quiet stored chats that have not been reopened. The enable time is persisted: first startup excludes old history, and re-enabling starts with new messages, without back-filling the off period. New turns cancel an ongoing review. Failed reviews log a content-free warning, retry once after a minute, and then wait for a new turn, a switch change or restart. A review never runs during an active turn.

The initial default can be set with `memory: { auto: false }` or `SWIFTNEST_MEMORY_AUTO=false` (the environment takes precedence over YAML). An explicit switch choice saved in the App takes precedence over this default. Both configuration values accept only booleans. Suspected secrets are never saved; as with manual memory, review the facts and delete anything you do not want kept.

A session freezes its memory block on its first prompt render. Later saves do not change that session's system prompt, preserving the prefix cache. The prompt tells the assistant to call `recall` before saying it does not know a past preference or fact. New sessions see the latest memory; `recall` always reads current memory.

Storage is under `<home>/memory/`: `MEMORY.md` holds short facts and an `## Index` of `[[topic]]` links, `topics/<topic>.md` holds details, and `snapshots/<sessionId>.md` holds frozen blocks. Each fact is one bullet line with `[source: …; added: …; id: …]` metadata. The App's topic editor accepts one fact per line (with optional Markdown bullets and headings), and adds metadata when saving.

Limits count Unicode characters: 300 per fact, 4,000 for `MEMORY.md`, 16,000 per topic, and 40 topics. Suspected API keys, tokens, private keys and passwords are rejected. Keep credentials in the appropriate secret store.

Deleting a memory removes it everywhere on the server.

Editing or forgetting removes the old line from every frozen block; session snapshots are removed when DSH removes the session and after 30 days at startup.

Each change first records `pending.json`, then replaces the affected files and appends one transaction to `journal.jsonl` with only its ID and time, never the memory text. Only the most recent 200 transactions are kept. Recovery completes interrupted changes before the next read or write and on startup, without applying a committed transaction twice. Incomplete journal rows and any old `journal.torn` are discarded; recovery uses the pending file. The pending file is removed after commit. Back up the whole memory directory while the server is stopped; do not edit files concurrently with the server.

Memory is built in and enabled by default, with no installation or setup. Its setting is separate from the third-party `plugins` map. To disable the tools and prompt block (the Memory page reports that it is disabled), set:

```yaml
memory:
  enabled: false
```

Or use `SWIFTNEST_MEMORY=false`. Existing memory remains on the server. The owner-only HTTP API uses the same signed session and Host/Origin admission as the other App APIs: `GET /swiftnest/api/memory`, `POST /add`, `/edit`, `/delete`, and `GET`/`POST /topic` under that prefix. `packages/api` exposes the corresponding typed methods.

Automatic memory adds owner-only `GET`/`POST /swiftnest/api/memory/auto` (`{ enabled: boolean }`) and `GET /swiftnest/api/memory/auto/recent`. The client methods are `memoryAutoSettings`, `setMemoryAuto`, and `recentAutoMemory`; deletion uses `deleteMemory`.
