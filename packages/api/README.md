# @swiftnest/api

[English](README.en.md)

Swiftnest 服务器的 TypeScript 客户端，采用 Apache-2.0 协议，不包含界面。
运行时仅使用 Web API，不依赖 DSH 页面全局变量。

```ts
import { connect } from '@swiftnest/api';
const api = await connect(pairingUrl);
const { sessionId } = await api.createSession();
const events = await api.follow(sessionId);
const rendering = (async () => {
  for await (const event of events) {
    // 根据 event.type 渲染消息、工具调用、错误、审批或问题。
  }
})();
await api.sendMessage(sessionId, '你好');
```

follow 返回前已附着初始快照。发送返回仅表示接收成功，不表示回合已结束。
持久消息按 messageId 渲染，流式尝试按 attemptId 渲染；assistant-start/end 划分尝试，
最终消息替换临时增量，已放弃的临时文本应丢弃。turn-end 不会结束订阅。
每个订阅只使用一个消费者，离开界面后调用 close；AbortSignal 或退出 for-await 也会取消订阅。
api.close 会释放连接和所有订阅。断连会发出 error，不自动重试修改请求；重连需创建新客户端。

Node 需要注入可发送 cookie 请求头的 WebSocket 工厂：

```ts
import WebSocket from 'ws';
const api = await connect(pairingUrl, {
  fetch,
  createWebSocket: (url, { headers }) => new WebSocket(url, { headers }),
});
```

health 返回服务器和模型健康信息，listSessions 返回会话摘要，createSession({cwd})
可指定服务器工作目录。当前只提供服务器最近历史窗口，尚未暴露更早历史分页。

审批通过 answerApproval(requestId, 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable') 回答；
问题通过 answerQuestion(requestId, {answers: [...]}) 回答。仅认领当前订阅会话的请求，其他请求交给
Host 后续回答器。interaction-cancelled 会使请求失效。继续回答限时问题可使用
answerQuestion({sessionId, callId}, {answers: [...]})；历史问题卡片恢复尚未提供。

浏览器必须与服务器同源，使用浏览器 cookie。Tauri WebView 通常跨源，必须使用原生 HTTP/WebSocket
carrier 和手动 cookie 模式，不能放宽 Host、Origin 或 fetch-site 限制。token 和 cookie 不得写入遥测或日志。

## 设备、传输与语言

listDevices 包含已配对的在线和离线设备。createDevicePairing 返回五分钟有效的配对码、LAN URL 和指纹；
listDevicePairings、confirmDevicePairing 处理确认，revokeDevice 断开并删除配对。
listDeviceApprovals、answerDeviceApproval 处理原始参数审批，deviceAudit 读取审计。
过期审批保留 ApiError.code === 'device-conflict'，服务器具体错误码通过 serverCode 提供，
message 和 hint 随语言本地化。

watchDevices 是兼容浏览器和原生 carrier 的 fetch SSE 流。首次订阅、收到失效事件和重连时重新读取快照；
取消信号、迭代器返回或 client.close 会释放读取器。流结束后由调用方重连，不自动重试修改请求。

listTransfers、startTransfer 和 transferAction 管理传输。
getLanguage / setLanguage('zh-CN' | 'en') 读写经过所有者鉴权的服务器语言偏好。
App 默认中文，离线选择保存在本机，连接恢复后重试同步；其他已连接 App 会跟随服务器选择。

测试：pnpm test。真实内核验收：SWIFTNEST_E2E=1 pnpm vitest run packages/api server。
详见 [DSH 集成](../../docs/zh/dev/dsh-integration.md)与[设备指南](../../docs/zh/guide/devices.md)。
