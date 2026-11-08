# 三个现有页面：源码体检

> 2026-11-07，对照 [目标规范](./ui-kit.md) 的静态检查；范围为聊天、模型、设备页及共享样式。**未改页面、未做像素/真机验收**。未验证不等于失败，也不等于通过。

## 共性问题

| 项目         | 证据                                                                                                                                                                                                                                | 结论                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 字号白名单   | [tokens.ts](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/design/tokens.ts) 的 largeTitle=28、body=15.5、callout=15、footnote=13                                                                                     | 与目标六档不符，令牌统一迁移前页面不能宣称达标。                               |
| 间距白名单   | [tokens.ts](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/design/tokens.ts) 仍提供 20/40/48/64；[styles.css](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/styles.css) 存在 gap:6px、10px、14px、28px | 与目标白名单不符；不能只禁止面板裸数字而忽略令牌值。                           |
| 动效         | [tokens.ts](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/design/tokens.ts) navigation=250ms                                                                                                                         | 超过目标 200ms；已有减少动态处理可复用，仍需实际验证。                         |
| 三栏断点     | [styles.css](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/styles.css) 在 1200px 才显示 context-rail                                                                                                                 | 1024–1199 未达到目标三栏；四档/八视口需补回归。                                |
| 注册协议     | [App.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/App.tsx) 路由条件分支与 [pages.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/components/pages.tsx) 骨架                                  | 有组件复用，但没有正式插槽注册及面板最小可用宽度元数据。                       |
| 自动门禁     | [biome.json](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/biome.json) 与 [CI](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/.github/workflows/ci.yml)                                                                      | 只有通用规则、构建与测试；没有证明已拦全部 UI 白名单，也没有三平台八视口门禁。 |
| 历史规范冲突 | [旧设计规范](./dev/design-system.md)                                                                                                                                                                                                | 仍写 Tauri、旧字号/间距/动效及阶段叙述；已加历史说明，旧代码本轮不改。         |

颜色多处已经使用 `--color-*`，图标已有公共映射，中英文案与 44px 目标也有基础，不能笼统说“全没做”。是否满足两层表面、一个强调色、4.5:1、键盘完整路径，需要渲染态检查，不靠源码猜。

## 聊天页

- 已有： [App.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/App.tsx) 使用 `DetailPage`、`VirtualList`；[chatTranscript.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/chatTranscript.tsx) 有空态，错误包含 localized message/hint。这些是可复用资产。
- 不合格：空态建议操作仍直接画原生 `<button>`，不经公共 `Button`。见 [chatTranscript.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/chatTranscript.tsx)。
- 不合格：历史首次加载没有独立可见的加载状态；非 blank 会话、rows 为空时直接进入空的 VirtualList，不能区分正在拿历史与没有记录。见 [App.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/App.tsx)。缓存改善回访，不解决冷启动三态。
- 待验证：含图片与长输出的滚动、软键盘弹出、焦点恢复、窄屏一标题一按钮；缓存切换的首屏 p95 需真机打点，单测耗时不能替代。

## 模型页

- 已有：[models.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/models.tsx) 复用 `HubPage`、`Card`、`Button`，有 loading 和更新失败提示，文案走 i18n。
- 不合格：首次读取失败时 `failed ? pluginsOwnerOnly : modelsLoading`，会把普通网络/服务错误归为仅限所有者；没有独立恢复按钮或原因区分。对照 [ownerResource.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/ownerResource.tsx) 的异常处理，只有 401/403 才能推断授权问题。
- 不合格：表单中仍有直接的 input/select，未形成统一输入组件；照片同意组 `.photo-consent` 使用 gap:6px。见 [models.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/models.tsx)、[styles.css](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/styles.css)。
- 归属冲突：当前是自建模型设置页，目标要求保留 DSH 原生模型页；应先按 [设置归属](./settings-ownership.md) 确认字段，不在体检时重写。
- 待验证：空 provider 列表、长模型名、多语排版、错误态键盘可达与四档截图。

## 设备页

- 已有：[devices.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/devices.tsx) 有空设备提示、吊销确认和公共按钮/页头；[hub.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/devices/hub.tsx) 处理失效响应并保留 error 标记。
- 不合格：页面没有消费 `page.error`；初次加载未完成时 devices=[] 也可能显示“没有设备”，不能区分空、加载、失败。见 [devices.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/devices.tsx) 与 [hub.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/devices/hub.tsx)。
- 不合格：设备列表 `page.devices.map()` 非虚拟列表，配对候选同样直接 map。见 [devices.tsx](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/devices.tsx)。
- 布局风险：[styles.css](https://github.com/lvy-jsd/swiftnest/blob/e219a0e/client/src/styles.css) 的设备预览使用 width:150px、min-height:260/280px；缺少面板最小可用宽度声明。应先确认这些示意图几何是否能作为公共组件例外，不能一律当成响应式已失败。
- 产品差距：设备页仍有独立传输入口和 LivePanel 入口；聊天“+”传文件与“不新建屏幕串流产品”属于 [蓝图](./product.md) 的目标，现有能力不在本轮擅自删除。
- 待验证：多设备长列表性能、吊销后焦点、离线设备反馈、Android 系统字体/触摸与软键盘。

## 后续验收证据（尚未完成）

每页按平台保存八视口基线、三态和 light/dark 差异；记录键盘路径、触摸操作、对比度报告及横向溢出。先评审问题归属与修复范围，再修改页面，不能顺手把产品取舍混入样式修复。
