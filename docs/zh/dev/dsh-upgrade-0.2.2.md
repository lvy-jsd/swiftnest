# DSH 0.2.2-rc.1 升级影响评估

> 2026-11-07，升级前核对。npm `latest`/`next` 均为 0.2.2-rc.1，`alpha` 为 0.2.2-alpha.3。原 pin 为 0.2.1-rc.5。本页记录影响面，不预先宣称兼容测试通过。

官方来源：[0.2.2-rc.1 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)、[两个标签对比](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.1-rc.5...dsh-v0.2.2-rc.1)、[npm 元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.2-rc.1)。不能因为 minor 相同就把此次迁移称为低风险：插件 API 和安全默认值都有变化。

| 上游变化                                                                       | 本项目影响与验证                                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 最低 Node.js 24.9                                                              | 根运行时要求、安装说明与镜像需一致；本机官方 Node 24.21.0 可满足。独立设备 CLI 的 Node 要求不无故扩大。                                     |
| Cordis Core 4.1、Loader/Include 1.1，配置访问与持久化统一                      | 检查生成 profile、include/subpath 解析、插件安装/启停/回退；不只跑 TypeScript。                                                             |
| agent.model 在提示组装前固定，agent/request 不能再改路由                       | 静态扫描未发现 server 使用这些直写接口；仍需模型手选、子任务/路由真实 e2e。                                                                 |
| 工具按 step 解析；原生/PTC 执行改为 agent 作用域插件，旧 tools.mode 环境需迁移 | 核查生成 presets 与 Tool Ultra 的 visibility/restrict/pre-execute 行为。纯 DSH 测目录、加载、下一步可调用及风险门。                         |
| Session projection 注册异步、会话初始化/清理顺序变更，新增拆分 Session API     | 审批恢复、问答、follow 首帧、断线重连、旧日志和检索不能只通过编译推断。新 API 存在不代表本产品已实现 since。                                |
| 图片在输入框提前上传，默认上限 50MiB                                           | Swiftnest 用自己的图片通道；验证现有发图和附件引用，不自动扩大产品上传限制。                                                                |
| WebSocket 默认压缩，静态资源 ETag                                              | 测当前多路复用与加密通道、代理重连，不能只凭无加密 loopback 测试承诺远程兼容。                                                              |
| 官方 bundles 导出移至 dsh-official-bundles                                     | 生成 profile/import 需要核查；静态扫描未发现 server 直接导入旧 app-boot 列表。                                                              |
| 未声明自定义模型容量默认变为十进制 1M/128K                                     | 保留产品明确容量，验证本地小上下文不会意外采用大默认。                                                                                      |
| Web Fetch 不再阻止私网；文件先读/外部修改防护默认关闭                          | **安全差异，不能静默当成无影响。** 不改 Tool Ultra 私网防护；核对产品实际装载工具及权限，升级 PR 明示此差异，不能把用户默认策略替用户拍板。 |
| PTC SSH 协议 2→3、取消分类为 ABORTED                                           | 本轮不修改远程 helper；如有启用该路径须与 bootstrap 同步测试，未测即标限制。                                                                |

依赖需一并对齐：服务器运行时与 API 包用于编译的 `dsh-client-connection`、`dsh-api-session-controller`、`dsh-api-gateway`，不能只升 server pin 留旧类型。历史测试录制与 preset fixtures 有版本来源说明，不把旧录制标签机械替换成新版本。

双版本 e2e 矩阵实际位于 **dsh-tool-ultra** 的 CI（0.2.1-rc.5 / 0.2.2-alpha.3），不是 Swiftnest。Tool Ultra 应单独 PR 将候选版更新为 0.2.2-rc.1 并保留旧版。peer prerelease 规则需通过包管理器/semver 实际验证，不凭 `<0.3` 判断 rc 可用；测试没过前不随意扩大声明、不发布 npm。

验收：整仓格式检查、构建、i18n、普通测试、真实内核 + 假模型 + 浏览器 e2e、模型/插件应用回退、图片/审批/检索、Tool Ultra 实际安装链。失败先修兼容，再开可评审 PR；不得直接更新线上实例或 main。Android 模拟器按用户要求放在整体最后验收。
