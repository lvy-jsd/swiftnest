# 设置字段归属：原生与产品边界

> 2026-11-07 源码/安装包盘点，供改代码前评审。原则：同一字段只由一方拥有，另一方导航过去，不保存第二份。**本 PR 不改设置页**。DSH 官方 UI 包存在，不代表 Swiftnest 当前组合已经启用或可直接嵌入。

## 按字段拆分，不按整页搬迁

| 字段/能力                                                                    | 唯一归属与 UI                                 | Swiftnest 当前情况/动作                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型 provider、模型选择、模型 API key                                        | DSH 原生 Models；沿用其凭据和设置写入边界     | [models.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/models.tsx) 现自建表单；后续改为原生导航，不复制同一 provider 配置。自定义路由若为产品独有则单列路由策略，不另存 key。                                        |
| DeepSeek 登录、退出、账号状态                                                | DSH 原生 Account                              | 原生 `ui-settings-account` 已有登录与状态投影；设备是否信任及吊销另归下表，不拿账号退出替代设备吊销。                                                                                                                                   |
| DSH 插件库存、启停/配置、工具供给、shell/agent-loop/subagent/web-search 配置 | DSH 官方插件页/设置贡献                       | [plugins.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/plugins.tsx) 现有自建入口需逐项替换。官方 Built-in plugins 库存是只读，不把它误称为完整第三方市场。Tool Ultra 包/pack 开关由插件自己拥有，不由产品再写一份。 |
| DSH 当前会话权限、未来默认权限、沙箱选项                                     | DSH 原生权限 preset 与插件配置                | 原生当前会话选择与未来默认值语义不同；产品只显示导航或状态，不用自己的开关暗改当前会话。                                                                                                                                                |
| 通用语言、主题明暗、DSH 聊天显示偏好                                         | DSH 原生 locale/theme/chat 配置（组合启用后） | 当前 [preferences.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/preferences.tsx) 自建语言和外观。宿主适配层消费同一有效值；不保留两份主题/语言真相源。                                                              |
| DSH 审批决定与原生审批策略                                                   | DSH 原生交互/权限控制                         | 消息内可以展示同一请求，不复制审批队列或重写风险判断。审批设置中 `timeouts.dsh` 需先核对它是桥接等待时间还是原生策略，见下节。                                                                                                          |
| 产品设备名、在线状态、能力与授权吊销                                         | Swiftnest                                     | [devices.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/devices.tsx) 等自建，账号页只提供入口。                                                                                                                      |
| 设备执行权限与设备审批超时 `timeouts.device`                                 | Swiftnest 设备权限层                          | 与 DSH 工具权限互不替代；不能整页迁回 DSH。                                                                                                                                                                                             |
| 文件传输配额、目标路径、传输审批超时 `timeouts.transfer`、任务续传           | Swiftnest 传输层                              | [transfers.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/transfers.tsx) 与设备协议；不建第二套 DSH 文件权限。                                                                                                       |
| 聚合审批提醒 `remind`                                                        | Swiftnest 通知/收件箱层                       | 聚合显示 DSH/设备/传输，但只存一份产品提醒偏好。                                                                                                                                                                                        |
| `autoAllowLowRisk`                                                           | Swiftnest 当前聚合审批设置，待审清作用范围    | 不是 DSH 默认权限 preset 的同义词；需要追踪后端适用源后决定拆字段，不直接映射成 Full access。                                                                                                                                           |
| 服务器聊天搜索开关、语义搜索、embedding source/model/云同意、重建索引        | Swiftnest 搜索功能                            | [chatSearchSettings.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/chatSearchSettings.tsx) 有自有接口；不是 DSH web-search，不能因都叫“搜索”合并。embedding 凭据引用原生模型凭据，不重复保存 key。                   |
| 服务连接地址、网络诊断、中继配置、推送与设备信任                             | Swiftnest 连接层                              | [relaySettings.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/relaySettings.tsx) 等。Tailscale 改变网络可达性，不替代应用授权。                                                                                      |
| 品牌色、产品插槽显示、产品专有减少透明度偏好                                 | Swiftnest 仅在 DSH 无同字段时拥有             | 若原生已经提供相同功能，就消费原生值；原生 reduce-motion 与宿主不能各存一份互相覆盖。逐字段确认后实现。                                                                                                                                 |
| 客户端升级、备份迁移、诊断包、服务器健康                                     | Swiftnest                                     | 原生 DSH 版本显示可复用，不另造 DSH 升级器；产品负责其多端兼容与打包。                                                                                                                                                                  |

## 混合审批页：不得整页替换

[approvalSettings.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/approvalSettings.tsx) 同时编辑 `remind`、`autoAllowLowRisk` 和 `timeouts.{dsh,device,transfer}`。其中设备与传输明确是产品层；`timeouts.dsh` 的实际效果还需跟踪 [approval-inbox.ts](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/server/src/approval-inbox.ts)、[approval-routes.ts](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/server/src/approval-routes.ts) 和 DSH 桥接实现后再决定：若只是产品的等待/过期策略，留在产品高级设置并明确命名；若真在改原生审批策略，退回原生。不能仅按字段名字判断。

## 原生依据与接入限制

已读取本地 DSH 安装包的 Host 实现和官方说明：`@deepseek-ai/dsh-client-ui-settings` 的 `apply()` 接入 settings 服务，官方约定 `settings.section`、`settings.plugins.tab` 和共享配置镜像；`ui-settings-models` 的 Host 侧发布模型 onboarding 开关，不代表它是一个独立 React 组件；`ui-settings-account` 通过 account remote namespace 投影登录状态；`ui-permission-presets` 区分默认与当前会话；`ui-settings-plugins` 只是库存/标签外壳。

这些包基于 DSH 客户端运行时和 slots/hooks，不是把现有 React 组件 import 一下就能嵌入。实施前要核对 Swiftnest 锁定内核的版本、Host namespace 是否服务、客户端模块/样式如何装载、认证及设置 revision 冲突处理。不得用单独 iframe 存另一套凭据或绕过权限来宣称“原样保留”。

本表只给字段边界；具体嵌入方式、原生 UI 与产品令牌的桥接及未决字段在评审后实现。验收要求：同一字段只有一个编辑入口和一份持久值，多端一致；原生设置失败能重试、过期写不覆盖，设备/传输字段仍可独立管理。
