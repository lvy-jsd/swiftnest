# 搜索历史对话

电脑、手机和网页 App 都可以使用聊天列表上方的搜索框，搜索标题和对话正文，支持中文及较短的词语。结果显示高亮片段和日期，点按即可打开原对话。当你提到以前聊过的内容时，助手也可以调用 `search_chats` 查找。

搜索功能内置，无需安装。私有 SQLite 索引保存在 `<home>/search/chats.db`。启动时从已保存的会话补齐缺少的内容，新消息在后台更新索引。只索引真人消息和助手正文，不包含子代理会话、推理内容、工具输出或图片。删除会话会移除对应搜索结果。请备份原始会话；索引可以重建。

打开「偏好设置 → 高级：对话搜索」，可以开关搜索或按含义搜索、选择向量来源，或点按「重建搜索索引」。重建会保留所有对话。即使向量服务不可用，按文字搜索也能继续工作。状态显示已索引消息数和按含义搜索是否可用。

默认自动检测已配置的本地模型服务器中的向量模型。只连接回环地址或私有 IPv4 地址；公网模型地址不会被自动视为本地，也不允许请求重定向。如果自动检测没有选中正确模型，可以在高级设置中输入模型名称。本地服务需要认证时，会使用已配置的模型 API 密钥。

云端向量目前使用 OpenAI。请先在「模型」页面保存 OpenAI 密钥，再选择「OpenAI 云端」，单独打开「使用云端向量」并保存。密钥和这项授权缺一不可。历史对话正文和搜索内容将发送给 OpenAI，可能产生服务费用。关闭授权会取消正在进行的向量任务。云端使用默认关闭。向量请求在后台分批串行处理；端点失败不会影响聊天。更换模型后会重新计算向量。

默认配置：

```yaml
search:
  enabled: true
  semantic: true
  embeddings:
    source: local
    # model: nomic-embed-text
    cloudConsent: false
```

支持经过校验的环境变量：`SWIFTNEST_SEARCH`、`SWIFTNEST_SEARCH_SEMANTIC`、`SWIFTNEST_SEARCH_EMBEDDING_SOURCE`、`SWIFTNEST_SEARCH_EMBEDDING_MODEL` 和 `SWIFTNEST_SEARCH_CLOUD_EMBEDDINGS`。布尔值须为 `true` 或 `false`。App 设置会在重启后保留；服务器搜索配置发生变化时，会在下次启动时优先应用。

主人 API 使用内核原有的签名会话、Host 和 Origin 校验：`GET /swiftnest/api/search?query=…&limit=20`、`GET /swiftnest/api/search/status`，以及 `POST /swiftnest/api/search/settings` 或 `/rebuild`。更新设置时传入完整设置对象。加密 App 通道只允许这些明确列出的路由。`packages/api` 提供 `searchChats`、`chatSearchStatus`、`configureChatSearch` 和 `rebuildChatSearch`。
