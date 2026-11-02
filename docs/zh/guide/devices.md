# 设备

[English](../../en/guide/devices.md) | 简体中文

Swiftnest Server 是 **Nest（巢）**，集中运行智能体、插件、记忆和外部工具。受控电脑或手机作为
**Perch（栖点）**连接，只提供自身能力。网页 App 用于聊天和管理。安装服务器本身不会让它自动控制电脑或手机。

## 配对设备

1. 用服务器的 App 链接连接应用，打开 **设备 → 配对设备**。
2. 在设备端 Perch 中使用显示的地址和六位配对码。配对码五分钟后失效，只能使用一次；错误证明达到五次时关闭。
   生成新码会使旧码失效。
3. 核对两端屏幕上的指纹：在 App 确认设备指纹，在设备端确认服务器指纹。双方都确认后才能完成配对。
4. 设备上线后显示其能力。离线后仍保留配对、上次观察到的能力、连接方式、指纹和最近在线时间。

设备监听默认使用 **7711** 端口，地址跟随服务器，默认启用 mDNS 发现。另一台机器连接时，需要配置可访问的
局域网地址（默认 `127.0.0.1` 只允许本机），放行设备端口，并保证 App/API 的地址也可访问。
显示的 WebSocket 地址供设备拨号使用，链路内部运行加密、双向认证的 Swiftnest 消息协议。

```yaml
host: 192.168.1.20
devices:
  host: 192.168.1.20  # 可省略，默认跟随 host
  port: 7711
  mdns: true         # false 关闭发现，仍可使用显示的地址连接
```

桌面 App 已集成 Rust Perch，入口为 **此设备**，默认关闭。参阅[控制这台电脑](./control-this-computer)。Android 暂时隐藏设备端控制，CLI Node Perch 仍可用于开发。

## 审批请求

默认策略直接放行读取；写入、执行及敏感操作等待主人审批。聊天中的提示条可打开审批面板，设备页显示待审批卡片。
选择 **批准** 或 **拒绝** 前，请检查 **设备、工具、原始 JSON 参数、风险、原因和请求方**。批准只对当前任务生效。
请求等待十分钟后自动拒绝；服务器关闭时未完成任务会取消。

DSH 原生工具调用会一直等待审批决定，随后返回执行结果或 `denied by owner` 错误。
智能体没有审批工具，审批仍须经过 App 已认证的主人会话。审计中的请求方标识为 DSH 聊天（`dsh:<sessionId>`）；
聊天提示条仍显示所有待审批设备请求。外部 MCP 客户端保留任务编号、状态查询和等待接口。

**撤销设备** 需要确认，随后立即断开设备并删除配对，重新连接必须重新生成配对码并核对指纹。也可以撤销离线设备。

## 存储与审计

数据位于 `<home>/devices/`：`identity.pem`、`paired.json`、`seen.json` 和 `audit.jsonl`。
请保护服务器身份和设备配对文件；迁移服务器时保留它们，丢失后需要重新配对。
审计逐条记录任务状态变化、请求方、原始参数、决策和错误，包括读取和被拒绝的调用，因此可能包含私人信息。
通过 `SwiftnestClient.deviceAudit(limit)` 可获取最近记录，默认 100 条，最多 1000 条。

## 开发接口

以下路径均以 `/swiftnest/api/devices` 为前缀，复用已有 App API 的签名主人会话及 Host/Origin 检查，拒绝未认证和跨站请求。

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/` | 在线和已配对设备 |
| POST | `/pairing` | 配对码、有效期、连接 URL、地址/端口和服务器指纹 |
| GET | `/pairing` | 等待核对指纹的候选设备 |
| POST | `/pairing/:id/approve` 或 `/deny` | 确认或拒绝候选设备 |
| POST | `/revoke/:device` | 断开设备并移除配对 |
| GET | `/approvals` | 带原始参数的待审批任务 |
| POST | `/approvals/:id/approve` 或 `/deny` | 作出一次决策，过期返回 409 |
| GET | `/audit?limit=100` | 最近审计记录 |
| GET | `/events` | SSE：devices-changed、approval-pending、approvals-changed、pairing-changed |

`POST /swiftnest/api/chat` 在相同主人身份检查下接受 `{ request, deviceSlug? }`，
其中 `request` 为原有 DSH 聊天请求；推荐使用 `SwiftnestClient.sendMessage()`。

`@swiftnest/api` 提供类型化接口，`watchDevices()` 支持浏览器及原生手动 Cookie fetch、取消订阅和客户端关闭。
事件提示列表有变化，订阅及重连后应重新获取快照。App 会重连推送流并定期刷新列表。

## DSH 原生插件契约

每台已配对设备的每个能力工具，由运行在 **DSH 子进程内**的 Swiftnest bundle 注册为原生工具，
名称严格为 `device__<slug>__<capId>_<tool>`，例如 `device__laptop__files_read`、
`device__laptop__files_write`、`device__laptop__shell_run`。
bundle 通过已认证的本机控制通道，将调用转发给 Swiftnest 父进程中的 Nest。
生成的 `cordis.patch.yml` 不再添加设备 MCP 客户端。

slug 在配对时由设备名称生成，格式为 `[a-z0-9_-]{1,24}`，在所有已配对设备中唯一。
名称转换为小写 ASCII，不支持的连续字符替换为 `-`，空结果使用 `device`，重名时添加 `-2`、`-3` 等后缀，
同时保持长度限制。slug 保存在 `paired.json` 中，之后永不改变；重命名只修改显示名称。
旧记录会自动迁移，并先保留已有合法 slug，再为旧记录分配名称。设备类型默认为 `desktop`；
Perch 可在已认证的 hello 中声明 `kind: 'android'`。

插件可注入 `swiftnestDevices`，类型从 `@swiftnest/server-bundle/native-devices` 导出。服务形状如下：

```ts
interface SwiftnestDevices {
  list(): { slug: string; name: string; kind: 'desktop' | 'android'; online: boolean; lastSeen?: string }[]
  currentFor(sessionId: string): string | undefined
}
// Swiftnest 通过 ctx.provide('swiftnestDevices', service) 提供服务。
```

两个方法均为同步方法。`list()` 返回包含离线配对设备的快照。
`currentFor()` 返回该会话最近一次已接受聊天消息的 App 连接所报告的设备 slug。
原生设备 App 通过 `@swiftnest/api` 连接时设置 `ClientOptions.deviceSlug`，`sendMessage()` 将其与实际聊天请求
一起发送到 `/swiftnest/api/chat`。服务器检查签名主人会话及 slug 是否已配对，再调用 DSH 原有的聊天接口。
服务器主机上的网页 App 不设置此字段，映射为 `undefined`；未知会话、已撤销设备也返回 `undefined`。
这是主人 App 报告的路由上下文，不是物理位置证明，也不会授予设备执行权限。
映射保存在内存中，服务器重启后由下一次聊天重新建立。

设备配对、撤销、上线、离线时，bundle 发出：

```ts
ctx.emit('swiftnest/devices-changed', { slugs: ['laptop'] })
```

`slugs` 包含受影响的命名空间，撤销时也包含被撤销的 slug。订阅事件后重新读取 `list()`。
启动及控制通道重连也会同步快照；工具注册和元数据更新先于事件完成。显示名称及能力元数据变化也会使快照失效。

**离线设备的工具仍保持注册**，服务器重启后也会恢复。调用返回
`device <slug> is offline (last seen <ISO time>)`。只有撤销设备才移除其工具。
工具 schema、说明和风险元数据缓存在 `seen.json`。旧 E1 记录只缓存工具名称，因此离线工具暂用开放对象 schema，
目录风险保守标记为 `sensitive`，下次 Perch 连接后替换为完整元数据。离线调用始终在执行前失败。

存在 `toolCatalog` 服务时，每个工具都会调用：

```ts
toolCatalog.annotate(name, { category: 'device', group: slug, risk, summary })
```

`risk` 来自能力的工具元数据，为 `read | write | exec | sensitive`，`summary` 为英文工具说明。
服务不存在时静默跳过。调用时仍由参数级风险分类和 Nest 策略决定是否需要审批。

原生接口**不注册任务元工具**（`device__task_*`）：调用直接等待策略、主人审批及执行完成，保留现有十分钟审批超时和
能力执行超时；取消调用会请求取消 Nest 任务。配对、撤销和审批都是主人 App 操作，不是智能体工具。

## 外部 MCP

独立的本机 MCP 端点继续供外部智能体使用，并使用单独的随机 bearer 凭据。
原始工具名保持 `<device>__<capId>__<tool>`，元工具保留 `swiftnest__task_status`、
`swiftnest__task_wait`、`swiftnest__task_cancel` 及 `swiftnest__devices`。
MCP 发现仍反映在线设备，并发出 `tools/list_changed`，与 DSH 原生注册表相互独立。

管理和 MCP 端点均使用系统分配的端口，每次进程启动更换凭据。密钥通过环境变量传递，不写入生成的 patch。
主人 API 代理无法访问私有的原生工具调用及控制路由，MCP 不暴露审批入口。
这是本机进程之间的信任边界，并非用于隔离恶意服务器插件或同一系统用户运行的代码。

## 桌面本机控制

桌面 App 的 **此设备** 区域已接入共享 Rust Perch，默认关闭。参阅[控制这台电脑](./control-this-computer)
选择共享文件夹、配对并设置后台运行。Android 本机控制暂时隐藏，CLI Node Perch 仍可用于开发。

## 实时画面

在小艾聊天页选择支持屏幕功能的在线电脑，即可[观看与接管](./live-view)。电脑必须开启设备控制，
并单独允许实时画面。观看流沿用设备 API 的主人会话认证；MCP 和代理工具没有观看或接管入口。
代理输入工具继续遵循审批，主人接管期间会明确拒绝。
