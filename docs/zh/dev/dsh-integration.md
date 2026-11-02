# Swiftnest 服务器如何集成 DSH

本文对应 [英文原文](../../en/dev/dsh-integration.md)。记录基于 2026-11-01 对
`@deepseek-ai/dsh@0.2.1-rc.5`（MIT）的本地验证；标为待验证的内容不能视为已实现保证。

## 固定内核版本

`server/package.json` 固定 DSH 的精确版本。DSH 尚处于开发预览阶段，升级应单独变更并运行完整端到端测试。
服务器创建 `swiftnest` profile，并以子进程启动内核，不维护 DSH 分支。

profile 位于 `$DSH_HOME/profiles/<name>`，包含 `package.json` 中按顺序排列的
`dsh.profile.bundles` 和 `cordis.patch.yml`。补丁依次合并：各 bundle → profile →
`$DSH_HOME/cordis.patch.yml` → `--patch`。程序入口包括 `@deepseek-ai/dsh/profile-boot`
和 `lib/bin.js` 的 `runCli()`。上游提供 `dsh-base`、`dsh-web-app`、`dsh-headless`、
`dsh-sdk-app`、`dsh-sdk-minimal`、`dsh-acp-app`。

## Node 运行环境

原生扩展 `node-addon-require-builtin` 依赖 Node 二进制中的机器码布局。本次验证中，
Nix 构建的 Node 在准备 Host 时出现 `Unsupported/no-getter`，nodejs.org 官方 24.21.0 可正常运行。
Docker 使用官方 `node:24`；Nix 开发环境使用校验 SHA-256 的官方二进制，并通过 nix-ld 运行。
可用 `SWIFTNEST_KERNEL_NODE` 指定可执行文件。不要把本次观察泛化为所有 Node 构建的保证。

## 模型和角色配置

OpenAI 兼容服务（Ollama、TabbyAPI、LiteLLM、vLLM 等）通过 `llm-pi-ai` provider 配置，
默认模型由 `agent-default-model` 指定，例如：

```yaml
- id: llm-pi-ai
  config:
    providers:
      local:
        displayName: 本地模型
        api: openai-completions
        apiKeyEnv: SWIFTNEST_LOCAL_API_KEY
        baseURL: http://127.0.0.1:11434/v1
        models:
          - { id: qwen3, name: Qwen 3, contextWindow: 131072, maxTokens: 8192, input: [text] }
- id: agent-default-model
  config: { provider: local, model: qwen3 }
```

即使模型服务不检查密钥，也必须设置 `apiKeyEnv` 指定的变量；否则可能出现
`PI_AI_ERROR: No API key for provider: local`。覆盖 `session-title-llm` 时需保留完整字段（含
`targetWords`），没有必要时不要覆盖。验证时，headless profile 曾通过本地 27B 模型完成单轮回答。

`ServerConfig.persona`、YAML `persona` 或 `SWIFTNEST_PERSONA` 可覆盖角色设定；
`{{model}}` 由 DSH 在运行时展开。当前默认使用中文，`lang: en` 使用英文默认角色。
显式配置的角色文本会原样保留。生成器同时修改 `system-prompt.config.personaPrefix`
和各 agent preset 的 persona prefix，避免 preset 覆盖角色。

Cordis override 会替换整行 config，因此 `server/src/profile.ts` 每次启动时读取固定版本
`@deepseek-ai/dsh-web-app` 的 `presets/*.patch.yml`，保留整行，仅替换 persona 插件的
`config.plugins[].config.prefix`。没有 persona 或结构未知的行不生成覆盖。
`!!js` 标签作为惰性字符串解析，使用 YAML AST 定位后直接替换原始源码片段；不执行表达式，
也不把标签重新序列化成普通字符串。注释、其他字段和表达式保留。`user.patch.yml` 最后应用且不会覆盖。
真实 preset fixture 检查字节保留，真实内核配合假模型检查实际收到的 system prompt。

## Web、配对与传输

`dsh --profile web --no-open --port <p>` 在回环地址提供 DSH 网页和原生 API，
打印含本次启动 token 的 `dsh web:` 链接。`--host` 必须指定具体 IP；TLS 使用
`--tls-cert/--tls-key`，`--trusted-host` 增加允许的 authority。

1. `GET /connect?token=…&interactions=answer` 禁止自动跳转，返回 `302 ./api/remote.mux`
   并设置签名 HttpOnly cookie。浏览器看到 opaque redirect，仍会保存 cookie；后续 socket
   和 `$events` ready 共同验证配对。Node 只在内存中保存 cookie 的名称和值。未登录 `/api` 返回 401。
2. RPC 使用 `POST /api/<endpoint>`，请求为
   `{type:"client-request",rpcId,method:endpoint,payload:{args}}`，响应为
   `{type:"server-response",rpcId,result:{ok:true,value}}` 或错误分支。检查 rpcId；
   `session/list` 使用 `{_request:{}}`，create、prompt、follow 使用 `{request:…}`。
3. 一个 cookie 对应的 Peer 只拥有一个 `/api/remote.mux` socket，第二次附着返回 409。
   多个订阅通过 `{type:"open",streamId,endpoint,payload:{args}}` 共享连接；下行是 item、end、error，
   cancel 只释放对应逻辑订阅。
4. 连接先订阅 `$events` 并等候 `{type:"ready",clientId,host}`。follow 打开 `session/follow`，
   使用 `assistantStream:true`，先处理 snapshot，再映射持久 event 和瞬态 assistant-stream。
   必须先订阅再发送，避免丢事件。
5. `session/prompt` 使用 `mode:"queue"`，返回 `{accepted:true}` 仅表示已接收。
   只把 `source.kind="user"` 且带 source.rpcId 的消息当作用户输入，过滤运行时时间上下文。
   流式文本按 attemptId 和 index 追加，最终持久消息覆盖临时文本；保留工具调用 id。
   assistant-end 关联 messageSeq，或标记已放弃；失败回合发出 error 和 turn-end。
6. snapshot 还会恢复活动 attempt 的 text-chunks。持久历史直接恢复成完成消息，不能伪造流式增量。
   当前仅提供最近历史窗口，更早历史分页和通用消息编辑属于后续工作。

## 为什么自建小型 API 适配层

已发布的 `dsh-client-connection/client` 有可直接导入的 Node ESM 入口，显式安装时不需要
`window.__DSH_BOOT__`。但其浏览器入口，以及 session-controller 的 client 入口，
是 `window.__ModuleLoader__.load(...)` 注册代码，不是独立 ESM；直接 Node 导入后者会失败。
`/remote` 提供描述符和 schema，不能替代会话传输运行时。只注入 WebSocket 不足以移植整个客户端。

因此 `packages/api` 实现已观察到的少量 JSON RPC 和 mux 协议。没有运行时 DSH 依赖、复制的
客户端 bundle 或额外 `/swiftnest/v0` 代理。上游包仅作为精确固定的开发依赖进行内部类型检查；
公开声明只暴露 Swiftnest 类型。App 仅导入 `@swiftnest/api`。

## 审批、问题和取消

`$events` 中 agent 作用域的 waterfall 项包含 `approval/request` 或 `user-questions/request`。
只处理当前 follow 的会话；其他会话返回 `{kind:"next"}`，交给下一个 Host 回答器。
回复调用 `$events/result`，使用 clientId、eventId 和 result outcome。
审批值为 `allowed-once`、`rejected`、`cancelled`、`unavailable`；问题使用结构化 answers。
Host cancel 会使请求 id 失效，并发出 `interaction-cancelled`。

前台限时问题通过 `userQuestions/attachWait` 认领等待流，在回答或取消时释放；继续回答调用
`userQuestions/answer`，传 agentId、callId 和 answer。历史问题卡片恢复尚未提供。
审批和问题传输有确定性测试；假模型聊天验收本身不证明真实模型工具审批可用。

## 浏览器、Node 与 Tauri

运行时代码不导入 Node，也不依赖 DSH 页面全局变量。可注入 fetch 和已鉴权 WebSocket 工厂。
Node 测试使用 ws 发送 cookie 请求头。手动 cookie 客户端不得跨无关主机共用 carrier。
关闭连接会清除 cookie、发出类型化错误并结束订阅。重连创建新客户端，不自动重试修改请求。

浏览器通过同源部署和 `credentials:"include"` 使用 cookie。打包的 Tauri WebView 通常跨源，
普通 fetch/WebSocket 会被 Host Origin、fetch-site、CORS 和 cookie 规则阻止。
需使用获授权的原生 HTTP/WebSocket carrier 与 `cookieMode:"manual"`；不要放宽服务器边界。

## 验证和服务器设备中心

`SWIFTNEST_E2E=1 pnpm vitest run packages/api server` 使用随机端口、临时目录和假 OpenAI SSE 模型，
验证配对、创建、订阅、发送、增量文本、最终消息与回合结束。单元测试覆盖 cookie、挂载路径、
RPC 关联、取消、超时、断连、审批和问题；浏览器 ESM 构建不得引入 Node 运行时依赖。
依赖安装仅允许必要的 DSH 子进程辅助程序修正执行位，不需要可选模型构建脚本。

Nest、身份、配对存储、审计、LAN 连接和回环管理服务由 Swiftnest 父进程持有。
生成的 profile 通过 `dsh-mcp-client` 的 devices 服务连接 Streamable HTTP；bearer 值只通过
环境传递，配置中保留未求值的 `!!js`，不持久化密钥。

bundle 对 `/swiftnest/api/devices/*` 调用 `connection.admit(req)`，保留 Host、Origin、会话限制，
并要求 owner 身份。转发时使用独立管理 token，不转发浏览器 cookie 或用户 Authorization。
只转发有大小限制的传输和语言设置 JSON。管理端负责配对、指纹确认、撤销、审批、审计及 SSE，
MCP 不提供审批工具。语言设置按所有者在服务器持久化，App 连接后同步，离线选择在恢复连接后重试。

固定内核验收覆盖同一会话中的 tools/list_changed、真实 Node Perch 文件读写与审批审计；
Chromium 在 390px 宽度检查设备管理和批准、拒绝操作。详见[设备指南](../guide/devices.md)。
