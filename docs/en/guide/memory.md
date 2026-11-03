# Memory

Open **Memory** from the App's main menu on desktop, phone or web. Add, edit or delete individual facts, or open a topic to edit its Markdown. Rejected changes show the server's reason. All Apps share the central server's memory; Apps do not keep a separate memory store.

The assistant can use `remember` (text and an optional topic), `forget` (entry text or id), and `recall` (list everything, search with `query`, or read a whole `topic`). Saving an identical entry in the same location quietly reports that it was already saved. There is no automatic consolidation in this version.

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
