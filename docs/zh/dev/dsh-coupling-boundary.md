# Swiftnest 与 DSH 耦合清单与边界设计（L2）

> 状态：设计方案（待评审，不包含业务迁移代码）。  
> 目标：系统性梳理当前 Swiftnest 对 DeepSeek Harness（DSH）内核的全部耦合点，明确“搬迁外置”、“保留桥接”与“禁止重造”的边界准则，降低后续内核升级的维护成本。

---

## 1. 背景与核心原则

在之前的版本演进（例如 DSH 从 0.2.1 升级至 0.2.2-rc.1）中，任何上游内部接口变动（如附件引用结构、网络安全默认值、Node 运行要求）都会在多个业务模块中产生波及。这暴露出 Swiftnest 内部各业务（设备、配置、记忆、搜索、工具）直接与 DSH 内部上下文深度绑定的问题。

然而，**减耦不等于推倒重造，更不等于机械地给所有调用凭空包裹一层无效的 RPC 代理**。在制定 L2 边界方案时，团队确立以下三项原则：

1. **业务自持，内核专注**：属于 Swiftnest 自己的页面、设备中心、设置业务和管理逻辑，不应寄居在内核扩展中。
2. **防腐适配，契约守护**：必须保留在内核内部拦截或执行的钩子，通过单一防腐适配层集中暴露清晰的数据与命令，禁止向业务层泄漏内核原生内部对象（如 Cordis `Context`、live `Session`、`Peer`）。保留点建立轻量契约测试。
3. **绝对不重造认证**：坚决复用 DSH 原生连接准入、安全 Cookie 与 WebSocket 多路复用通道；保留已有的长期凭据扩展，绝不另造一套用户登录与身份系统。

---

## 2. 现状完整耦合清单

经对 `server/src/`、`server/bundle/` 以及 `packages/api/` 的全面代码审计，当前系统与 DSH 的耦合点分布在以下五个维度：

### 2.1 上下文服务与容器注入（Cordis Context Services）

| 服务名称                | 引用源码位置                                                                                                | 实际用途与行为                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ctx.webServer`         | `server/bundle/src/core.ts`<br>`server/bundle/src/chat-search.ts`<br>`server/bundle/src/memory.ts`          | 挂载 HTTP/WS 路由（`/app/` 静态资源、`/swiftnest/health`、搜索与记忆调试接口、设备反向代理接口等）。        |
| `ctx.connection`        | `server/bundle/src/core.ts`<br>`server/bundle/src/channel.ts`<br>`server/bundle/src/native-pairings.ts`     | 请求准入 (`connection.admit`)、创建/销毁 API Peer、提取 Client ID、校验 Host/Origin。                       |
| `ctx.tools`             | `server/bundle/src/media.ts`<br>`server/bundle/src/native-devices.ts`<br>`server/bundle/src/chat-search.ts` | 动态注册工具 (`tools.register`)、包装工具输出 (`output.render`)、拦截与可见性管理。                         |
| `ctx.llm`               | `server/bundle/src/vision.ts`<br>`server/bundle/src/memory/auto.ts`                                         | 视觉描述模型转发调用、自动记忆生成与回顾分析调用。                                                          |
| `ctx.attachments`       | `server/bundle/src/vision.ts`                                                                               | 读取图片附件元数据、校验二进制尺寸、提取图像流供多模态服务使用。                                            |
| `ctx.systemPrompt`      | `server/bundle/src/routing.ts`<br>`server/bundle/src/memory.ts`                                             | 向内核系统提示词注入专属切片 (`systemPrompt.section`)，如专家路由规则、记忆上下文快照。                     |
| `ctx.on` / `ctx.effect` | `server/bundle/src/*.ts`                                                                                    | 注册生命周期钩子、绑定内核事件、在插件卸载或重启时执行清理回调。                                            |
| `@deepseek-ai/dsh-web`  | `server/bundle/src/web-fetch.ts`                                                                            | 直接类型依赖上游私有包，通过 `web.registerFetchProvider` 注入自定义安全抓取策略（私网拒绝、DNS 防重绑定）。 |

### 2.2 事件监听 vs 日志识别

必须严格区分“通过事件总线实时订阅的真事件”与“在事件历史日志或消息流中做条件匹配的标签”：
- **真正通过总线订阅的内核事件（6 类）**：
  1. `session/created`：新会话初始化，用于自动记忆跟踪与索引准备。
  2. `session/event`：会话内消息及状态变动，用于聊天增量建库与实时记忆分析。
  3. `session/disposed`：会话释放注销，用于清理缓存与未完成任务。
  4. `tools/pre-execute`：工具执行前拦截，用于专家路由审批拦截与安全风险判定。
  5. `llm/stream`：大模型流式调用中间件，用于向不支持看图的模型把图片无缝改写为描述。
  6. `approval/request`：内核交互断点，向客户端发起权限与工具使用审批。
- **日志与流解析判别（仅作为数据标签，非总线订阅）**：
  `session/title`、`approval/asked`、`turn-end`、`assistant-stream` 等仅是 follow 协议与持久化日志中的事件类型字段，不占用事件挂钩。

### 2.3 会话与持久化层（Sessions & Persistence）

- `ctx.sessions`：
  - `sessions.list()`：获取当前内存中活跃会话实例。
  - `sessions.flush(session)`：强制将活跃会话数据刷入存储。
- `ctx.sessionPersistence`：
  - `sessionPersistence.list()`：列出磁盘所有会话持久化头部（包含 ID、Origin 等）。
  - `sessionPersistence.open(id, 'read')` / `read()` / `close()`：分页或顺序追赶读取历史消息，供搜索与记忆服务重建。
  - 会话物理删除与修剪语义目前依托 DSH 存储目录。

### 2.4 进程管理与构建配置

- `server/src/kernel.ts`：以子进程执行 DSH CLI，通过正则解析启动 URL 与一次性 Token，注入父死子亡守护。
- `server/src/profile.ts`：编排 bundle 加载顺序，使用 YAML AST 语法树解析并保留上游 presets 的 `!!js` 标签以覆盖 persona。
- `server/bundle/cordis.patch.yml`：固定插件 ID 与覆盖项。
- `server/src/tool-ultra.ts`：已完成由源码构建向 12 个精确固定 `0.5.0` npm 审计包的迁移，但仍保留 patch 注册机制。

### 2.5 客户端 API 与 Wire RPC

- `packages/api/src/index.ts`、`events.ts`、`transport.ts`：
  手写实现与 DSH 保持一致的 JSON-RPC 帧格式、`/api/remote.mux` 多路复用和 Session Follow 事件协议，封装用户提问（User Questions）与附件引用规范。

---

## 3. 三分类落地设计

针对上述清单，按“搬迁外置”、“保留桥接”和“禁止重造”三类实施治理：

```
┌────────────────────────────────────────────────────────┐
│               Swiftnest 业务层 (主进程 / UI)             │
│  - 设备管理与审批业务      - 偏好设置与语言同步          │
│  - 静态页面 (/app) 托管    - 向量索引与持久化记忆策略    │
└─────────────────────────┬──────────────────────────────┘
                          │ 明确数据 DTO 与命令接口 (禁止泄露 Cordis/Session)
┌─────────────────────────▼──────────────────────────────┐
│           Swiftnest 内核防腐适配层 (Bridge Layer)        │
│  - KernelAdapter       - SessionBridge                 │
│  - ToolApprovalBridge  - VisionRewriteBridge           │
└─────────────────────────┬──────────────────────────────┘
                          │ 仅保留必须的上下文钩子与数据同步
┌─────────────────────────▼──────────────────────────────┐
│                  DSH 运行内核 (Child Process)           │
│  - LLM 调用流中间件     - 工具注册与执行环境           │
│  - 原生准入与 Cookie    - WebSocket Mux 传输与原生会话 │
└────────────────────────────────────────────────────────┘
```

### 3.1 第一类：搬到进程外（Swiftnest 独立业务）

这些功能纯属 Swiftnest 自身业务，目前寄生在内核内部通过 `ctx.webServer` 挂载，应剥离至父进程或独立入口：
1. **静态 Web 应用托管与健康检查**：
   - `/app/` 前端资产分发与 `/swiftnest/health`：由父进程的 Web 服务直接托管，不再占用内核路由。
2. **设备中心与设备设置**：
   - 当前在内核 bundle 中的 `devices.ts` 实际只是一个转发代理，真正的 Nest、设备配对、密钥存储、本地网络连接（LAN）和审计日志早就在父进程中运行。
   - 彻底移除内核侧冗余的设备管理 HTTP 代理，设备端与管理端交互直达父进程。
3. **记忆与搜索的业务决策核心**：
   - 记忆的增删改查、向量存储与分块检索算法属于纯粹的应用数据逻辑，剥离内核上下文；内核内仅保留向系统提示词注入最终上下文切片的通道。

### 3.2 第二类：保留但加桥接（防腐适配层与明确契约）

内核内部执行的拦截动作无法移出进程，必须通过严格的“单向防腐适配接口”进行收敛：
1. **建立统一适配层（禁止对象泄露）**：
   - 严禁将 DSH 的 live `Session`、`Peer`、Cordis `Context` 透传给外部业务模块。
   - 定义纯净的数据传输对象（DTO），业务层只感知 Swiftnest 自身类型。
2. **会话桥接契约（SessionBridge Contract）**：
   - 封装 `session/created`、`session/event`、`session/disposed`。
   - 必须显式处理事件全局连续序号（seq）、断线追赶补读（replay）、缺口重试（gap retry）、任务取消与资源句柄关闭。
3. **现场执行钩子（In-Kernel Hooks）**：
   - `tools/pre-execute`：保留用于工具权限判定与审批卡片弹出。
   - `llm/stream`：保留用于视觉描述动态改写。
   - `systemPrompt.section`：保留用于动态注入只读业务提示词。
   - `web.registerFetchProvider`：保留用于保障私网访问防御底线。
4. **轻量契约测试保护**：
   - 针对附件引用结构、审批流拦截返回值、工具注册签名设立最小测试用例，确保升级验证耗时在秒级定位。

### 3.3 第三类：绝对不重造（认证与连接准入）

**为了减耦而重新研发一套用户系统或登录体系，是把简单问题变成灾难。**
1. **保留 DSH 原生准入体系**：
   - 继续沿用 DSH 的 `connection.admit` 流程、加密签名 HttpOnly Cookie、以及基于 WebSockets 的 `/api/remote.mux` 多路复用机制。
2. **保留并收拢现有长期凭据扩展**：
   - 原生客户端使用的长期配对凭据机制（`native-pairings`）继续与 DSH API Peer 桥接，负责凭据签发、验证与销毁。
3. **坚守安全底线**：
   - 严格保留 Host/Origin 隔离防线，撤销凭据时必须同步断开存活连接。
   - **绝对不允许**通过在外部请求头中随意伪造身份（如直接信任未签名的 `X-User-Id`）来简化设计。

---

## 4. 架构方案选项与推荐路线

| 维度           | 选项 1：集中防腐适配（推荐首选）   | 选项 2：公共入口前置到父进程         | 选项 3：全链路微服务化外置       |
| -------------- | ---------------------------------- | ------------------------------------ | -------------------------------- |
| **改动范围**   | 仅重构 `server/bundle` 与服务封装  | 父进程接管端口，内核变为回环后端     | 会话、搜索、记忆全部跨进程化     |
| **对外端口**   | 保持单一服务端口不变               | 父进程监听单一端口，反向代理内核     | 多个内部通信通道与服务端口       |
| **认证与通道** | 完全复用现有 Cookie 与 Mux 机制    | 需处理 Cookie/TLS/WS 代理转发        | 必须重造或引入分布式 Token 体系  |
| **实施代价**   | **小**，无需变动网络拓扑与外部依赖 | **中**，需额外验证代理时延与断线重连 | **极大**，破坏“不重复造轮子”底线 |
| **升级收益**   | 隔离核心业务，上游破坏局限在适配层 | 内核退化为计算引擎，入口完全自控     | 彻底解耦，但架构复杂度急剧增加   |

### 建议落地节奏

1. **第一阶段（本次产出）**：固化本文档与架构原则，达成边界共识，不写业务迁移代码。
2. **第二阶段**：实施**选项 1**，在 `server/bundle` 内部抽离 `SessionBridge` 与各业务适配层，断绝各业务散落依赖 DSH 的现状，并建立 4 个核心契约测试。
3. **第三阶段（可选评审）**：若后续确需完全自持公共 HTTP 监听，再评估是否推进选项 2，将静态托管与公共反向代理上浮到父进程。选项 3 予以明确排除。
