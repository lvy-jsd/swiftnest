# Swiftnest v0.4 设计：智能体通信网格

> 状态：已搁置。按 2026-11-02 定的架构（一个中心服务器加多个配套应用），packages/mesh 原型已从仓库删除，需要时可从 git 历史找回。下文保留作设计参考。
>
> 原状态：2026-10-26 的 v0.4 草案。本文对应[英文版](../en/design-v0.4.md)。
> v0.3 让智能体调用设备能力；v0.4 在此基础上增加智能体之间的消息、文件传输和任务委托。
> 规划内容不等于当前版本已全部实现。

## 1. 从星形连接扩展为网格

现有设备层保持 Nest → Perch 星形结构：Nest 管理配对、加密、权限与审计，智能体通过工具访问设备。
新增通信层让运行智能体的机器成为节点，通过直连或中继互相通信。同一台推理服务器可同时运行
设备中心 Nest 和网格节点；设备控制层（TS）与智能体通信层（Rust）各自负责自己的边界。

```text
智能体 A ── 节点 A ══ 网格（直连或中继）══ 节点 B ── 智能体 B
                 │                            │
                Nest                         Nest
                 │                            │
               Perch                        Perch
```

## 2. 节点的职责

节点运行 Rust 网格核心和 TS 设备核心。Rust 作为 sidecar 子进程负责 libp2p、传输、NAT 穿透、
中继、加密和文件传输，TS 通过本地 Unix socket 与其通信。节点承载本地智能体和设备能力，
通过 MCP 提供调用入口，也能向远端节点发送消息、文件和任务。

身份使用 Ed25519 密钥对。公钥确定节点身份，配对时供人核对的指纹用于确认身份。
设备层已有的身份、配对与审计模型继续复用，不重写现有核心。

## 3. Rust 核心和本地协议

选择 rust-libp2p 是因为其支持 TCP、QUIC、WebSocket、WebRTC、WebTransport、多路复用、
Noise/TLS 1.3，以及 AutoNAT、打洞和中继。QUIC 使用 quinn。Rust 适合同时处理大量消息和文件流。
这些是技术选型目标，平台可用性仍需各自验证。

| 模块            | 职责                                                   |
| --------------- | ------------------------------------------------------ |
| Node            | Ed25519 身份、监听地址和节点存储                       |
| Transports      | 默认 QUIC，按环境选择 TCP、WebSocket、WebRTC           |
| NAT traversal   | AutoNAT、打洞，失败后转中继                            |
| Relay           | 由启用中继角色的节点转发                               |
| Encryption      | 传输层 Noise，应用会话复用 Ed25519/X25519/AES-GCM 模型 |
| Messaging       | 可靠、有序的文本、JSON 和事件                          |
| File transfer   | 分块、续传、逐块校验和内容哈希                         |
| Task delegation | 远端任务提交、状态追踪和结果获取                       |
| Discovery       | 发布、交换 A2A agent card                              |

本地 Unix socket 权限为 600，仅所有者可访问。每行一个 JSON 命令，按顺序返回结果；
subscribe 后同一连接还会推送带 event 字段的事件。示例：

```json
{"cmd":"status"}
{"cmd":"dial","addr":"/ip4/10.0.0.5/tcp/30001/p2p/<peer-id>"}
{"cmd":"subscribe"}
{"cmd":"send_message","to":"<peer-id>","text":"你好"}
{"cmd":"send_file","to":"<peer-id>","path":"/tmp/x.bin"}
{"cmd":"delegate_task","to":"<peer-id>","task":"echo:hi"}
```

命令还包括 list_peers、list_transfers、pair_start、pair_with、trust、revoke、list_paired。
事件包括 peer_connected、peer_disconnected、message、file_received、file_sent、task_result、
request_failed、paired、pair_failed、revoked。Rust 核心停止后，TS 会观察到 socket 关闭并可重启 sidecar。

已实现的配对模型：密钥保存在 `<state>/identity.key`（600），配对记录在 peers.json。
非配对节点的普通请求被拒绝；配对请求例外。pair_start 生成五分钟有效的六位码，五次错误后关闭。
pair_with 要求含 /p2p/id 的地址，在发送配对码前由传输握手验证该 id，防止冒充地址套取码。
仅 `MESH_RELAY_SERVER=1` 才允许为其他节点提供中继。

限制：此草案记录的 mesh 配对尚未要求双端指纹确认，审批没有签名，也没有本地设备确认。
身份判断始终使用 libp2p 验证的 peer id，不信任请求体的 from/to。
文件名只能是单个路径分量，transfer id 必须等于双方从名称、大小和 sha256 共同计算的哈希。

## 4. 通信原语和 MCP

通信层提供消息、文件和任务三种原语：消息按发送方和接收方有序；文件分块续传，接收端取得 artifact id；
任务由远端智能体执行，必要时调用远端自己的设备能力，发送方追踪状态和获取结果。

计划中的 MCP 工具：

- mesh.list_peers：列出可达节点和智能体。
- mesh.send_message、mesh.send_file：发送消息或文件。
- mesh.delegate_task：委托任务并返回任务 id。
- mesh.task_status、mesh.task_wait、mesh.task_cancel：查询、等待或取消任务。
- mesh.receive：轮询接收，也可订阅事件。

## 5. A2A 发现

A2A agent card 描述智能体名称、能力、端点和技能。节点为本地智能体发布 card，在连接时交换，
让双方知道对方能做什么。委托任务沿用 submitted → working → completed/failed 的状态模型。
A2A 是发现和协作层，libp2p 是传输层；两者不相互替代。

## 6. 多种网络通道

优先使用可达的直连通道。QUIC 为默认选择，TCP/WebSocket 作为备选，WebRTC 面向受限网络和移动端。
AutoNAT 判断可达性，打洞失败后经自托管中继；Headscale/Tailscale 子网也可作为通道。
节点换网后的连接恢复、通道选择和退回策略由 Rust 核心处理。中继角色可由任意合适节点承担，
不强制依赖第三方公共服务。

## 7. 安全边界

传输加密之外，节点间应用会话继续使用身份认证和端到端加密。通信先配对，撤销使节点失去信任并断开。
消息、文件和任务写入追加式审计日志。文件写入和远端命令受目标端权限规则约束；
委托不能成为绕过审批的通道。执行 shell.run 等高风险操作仍需所有者批准。

## 8. 技术选择

| 领域         | 选择与原因                                  |
| ------------ | ------------------------------------------- |
| 网格语言     | Rust，支持并发和内存安全                    |
| P2P          | rust-libp2p，统一传输、穿透和中继           |
| 默认传输     | quinn QUIC，按环境退回 TCP/WebSocket/WebRTC |
| 加密         | Noise 与应用层 Ed25519/X25519/AES-GCM       |
| 发现         | A2A agent card                              |
| TS/Rust 边界 | 本地 Unix socket，每行 JSON                 |
| 中继         | 自托管节点，可选公共服务                    |

## 9. 仓库结构

现有 packages/core、protocol、sdk、cli 和设备插件保留。packages/mesh 是 Rust sidecar；
拟增加的 plugins/mesh-surface 将 mesh MCP 工具桥接到本地 socket。CLI 与 surface-mcp 扩展 mesh 命令，
设备链接 link-lan/link-relay/link-headscale 继续负责 Perch → Nest，不与网格传输混为一层。

## 10. 路线图

| 阶段   | 内容和验收                                                                  |
| ------ | --------------------------------------------------------------------------- |
| M0、M1 | 保留已完成的设备核心和首次连接工作                                          |
| M1.5   | Rust 核心、QUIC/TCP、局域网节点直连，交换 card 和文本，写审计               |
| M2     | NAT 穿透、中继、分块续传、任务委托；跨网络传消息和 10 MB 文件并返回任务结果 |
| M3     | Headscale 通道和 A2A 互操作；委托给外部 A2A 智能体                          |
| M4     | 迁移推理主机的设备层                                                        |
| M5     | 桌面通知及移动节点；手机在蜂窝网络接收消息和文件                            |
| M6     | 设备和网格一起发布 v0.1，新用户十五分钟内完成两节点通信                     |

## 11. 与现有代码的关系

core 的 Nest/Perch/Plugin、channel、pairing、policy、audit 保留；protocol 增加 mesh 消息类型。
cap-shell/cap-files 保留为设备能力。surface-mcp 和 cli 增加 mesh 工具与命令。
新增核心只扩展通信层，不替换已经工作的设备控制层。

## 12. 待定问题

默认倾向自托管中继，可选公共服务；M2 优先 agent card 和任务委托，流式和推送稍后实现。
倾向保留不启动 Rust 核心的纯设备模式。移动 WebRTC 的运行环境和原生封装留待 M5 验证。

## 13. 决策记录

2026-10-26：决定保留设备层，增加智能体通信网格；Rust sidecar 使用 rust-libp2p；
采用 A2A card；TS/Rust 通过 Unix socket 每行 JSON 通信；复用现有身份、配对和审计模型。
