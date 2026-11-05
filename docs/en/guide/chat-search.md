# Search past conversations

Use the search box above the chat list on desktop, phone or web. On desktop, the sidebar also lets you search while reading a chat or using another page. It searches titles and conversation text, including Chinese and short words. Results show a highlighted excerpt and date; tap one to open the original chat. The assistant can call `search_chats` when you refer to an earlier conversation.

Search is built in. The private SQLite index lives at `<home>/search/chats.db`. Startup catches up from saved sessions; new messages update the index in the background. If a live event arrives before its earlier events have been saved, the index retries in the background without skipping sequence numbers. Only human messages and assistant text are indexed, excluding subagent sessions, reasoning, tool output and images. Removing a session removes its search results. Back up your original sessions; this index is derived data.

Open **Preferences → Advanced: conversation search** to turn search or search by meaning on/off, select an embedding source, or **Rebuild search index**. Rebuilding retains your conversations. Word search continues to work when embeddings are unavailable. The status shows indexed messages and whether search by meaning is available.

By default, search by meaning detects an embedding model on your configured local model server. It only contacts loopback or private IPv4 addresses; a publicly hosted model URL is never silently treated as local. Requests reject redirects. If detection chooses the wrong model, enter its name in the advanced settings. Local servers requiring your configured model API key receive that key.

Cloud embeddings currently use OpenAI. First save your OpenAI key on the **Models** page. Then select **OpenAI cloud** and explicitly turn on **Use cloud embeddings**, then save. Both the key and this separate permission are required. Your past conversation text and search queries are sent to OpenAI and provider charges may apply. Turning the permission off cancels outstanding embedding work. Cloud use is off by default. Embedding requests are batched and serialized; a failed endpoint cannot fail a chat. Changing models replaces the vectors.

Configuration defaults:

```yaml
search:
  enabled: true
  semantic: true
  embeddings:
    source: local
    # model: nomic-embed-text
    cloudConsent: false
```

Validated environment overrides are `SWIFTNEST_SEARCH`, `SWIFTNEST_SEARCH_SEMANTIC`, `SWIFTNEST_SEARCH_EMBEDDING_SOURCE`, `SWIFTNEST_SEARCH_EMBEDDING_MODEL`, and `SWIFTNEST_SEARCH_CLOUD_EMBEDDINGS`. Boolean values must be `true` or `false`. App settings survive restarts; changes to the server search configuration take precedence on the next start.

The owner API uses the kernel's signed-session, Host and Origin admission: `GET /swiftnest/api/search?query=…&limit=20`, `GET /swiftnest/api/search/status`, and `POST /swiftnest/api/search/settings` or `/rebuild`. Settings updates supply the complete settings object. The encrypted App channel allows only these routes. `packages/api` provides `searchChats`, `chatSearchStatus`, `configureChatSearch` and `rebuildChatSearch`.
