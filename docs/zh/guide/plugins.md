# 插件

Swiftnest 服务器能加载的第三方 DSH 插件只有一个来源：[`server/plugins.json`](https://github.com/lvy-jsd/swiftnest/blob/main/server/plugins.json)。做法参考社区的 [DeepSeek Harness Ultimate](https://github.com/18126295767-cell/deepseek-harness-ultimate) 配置：

- 每个插件固定到精确版本和 npm 校验值（Tool Ultra 固定到完整提交），安装后逐个核对，不符就报错；
- 只收 MIT、Apache-2.0、BSD-3-Clause 许可证，清单测试会拦下其他许可证；
- 同一件事只装一个插件；
- 会把数据发到外部或需要账号的插件默认关闭；
- 插件依赖的安装脚本默认不运行。

## 插件列表

| id              | 插件                                                                           | 默认 | 作用                                        |
| --------------- | ------------------------------------------------------------------------------ | ---- | ------------------------------------------- |
| `tool-ultra`    | [Tool Ultra](./tool-ultra.md)                                                  | 开   | 按需加载工具、风险审批、设备工具            |
| `market`        | DSH 自带的插件市场                                                             | 关   | 在“插件 → 发现”里浏览社区插件目录           |
| `safety-net`    | [cc-safety-net](https://github.com/kenryu42/cc-safety-net)                     | 开   | 拦截 `rm -rf`、强推、读取密钥等危险操作     |
| `auto-continue` | [dsh-client-auto-continue](https://github.com/HsiangNianian/dsh-auto-continue) | 开   | 中断后可恢复时自动继续                      |
| `smart-title`   | [dsh-smart-title](https://github.com/weibaohui/dsh-smart-title)                | 开   | 按对话内容自动起会话标题                    |
| `cost-meter`    | [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)                | 开   | 统计外部模型的花费和 token，设置预算        |
| `vision-router` | [dsh-vision-router](https://github.com/ysr666/dsh-vision-router)               | 关   | 让纯文本模型看图；图片会发给云端识图模型    |
| `im`            | [dsh-im](https://github.com/xmanrui/dsh-im)                                    | 关   | 接入微信、QQ、飞书、钉钉、Telegram 等机器人 |

cc-safety-net 用的是黑名单，只是默认拒绝规则之外多一层保险。

## 插件市场

`market` 打开的是 DSH 自带的社区插件市场，目录源用社区每天更新的 [dsh-plugin-catalog](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。它面向高级用户，默认关闭：普通用户只需要上面这些审过的插件。打开后，在“插件 → 发现”里装的插件重启后会保留，但启动日志会标明它们未经 Swiftnest 审核；关掉市场后，这些插件会被移除。

## 安装与开关

```sh
swiftnest-server plugins install --config swiftnest.yaml
swiftnest-server start --config swiftnest.yaml
```

安装会构建 Tool Ultra，再用 DSH 自带的 `dsh plugin install` 把启用的 npm 插件装进 `<home>/dsh/profiles/swiftnest`，最后核对校验值。需要 Git、npm、pnpm、Node 24 和网络。启动不会自动下载；未安装的插件只打印提示，服务器照常启动。

按 id 开关。优先级从低到高：清单默认值、配置文件、App 里的开关、`SWIFTNEST_PLUGINS`：

```yaml
plugins:
  im: true
  smart-title: false
```

```sh
SWIFTNEST_PLUGINS=im=true,smart-title=false
```

改了开关后重新运行 `plugins install` 再重启。打开 `vision-router` 之前先在它的设置里配好识图模型（比如 Gemini），并关掉免 key 的云端兜底，否则图片会发到默认服务。

## 在 App 里管理

App 的插件页列出审过的插件，每个都有名字和一句话说明，语言跟随用户设置。默认关闭的插件会附一句开启前要知道的事。用户拨好开关后点“应用”：Swiftnest Server 会安装缺的插件、核对校验值，再重启 DSH。如果 DSH 用新插件起不来，服务器会恢复到上一次能启动的插件，并报告失败原因，保证服务器始终连得上。开关保存在 `<home>/plugin-settings.json`。被 `SWIFTNEST_PLUGINS` 设定的插件显示为锁定。

重启 DSH 会换掉启动令牌。网页版 App 的登录状态不受影响；通过 `/connect` 配对的原生 App 需要重新配对。

插件页背后是只给所有者用的接口，`SwiftnestClient` 里对应 `listPlugins`、`setPluginEnabled` 和 `applyPlugins`：

| 请求                                       | 返回                                            |
| ------------------------------------------ | ----------------------------------------------- |
| `GET /swiftnest/api/plugins`               | `PluginsView`                                   |
| `POST /swiftnest/api/plugins/{id}/enable`  | `PluginsView`；未知 id 返回 404，被锁定返回 409 |
| `POST /swiftnest/api/plugins/{id}/disable` | 同上                                            |
| `POST /swiftnest/api/plugins/apply`        | 202 `PluginsView`；已在应用时返回 409           |

`PluginsView` 分三部分：

- `plugins`：每个插件的 `id`、`title`、`summary`、`note?`、`enabled`、`recommended`（默认开启）、`active`（正在运行的 DSH 已加载）、`locked`、`license` 和 `homepage?`；
- `unaudited`：从社区市场装的包名；
- `pending` 和 `apply`：开关和已加载的不一致时 `pending` 为 true；`apply` 是 `{ state: idle | installing | restarting | failed, rolledBack?, error? }`。

这些有变化时，设备事件流会发 `plugins-changed`。应用接口在重启前就返回，之后连接会短暂断开，重新读取 `apply.state` 即可。

## 加一个插件

1. 确认许可证在允许列表里，功能不和已有插件重复；
2. 在 `server/plugins.json` 加一条，写上精确版本和 `npm view <包>@<版本> dist.integrity` 的值；
3. 需要账号或会往外发数据的，设 `"enabled": false` 并写明 `reason`；
4. 运行 `SWIFTNEST_PLUGINS_E2E=1 pnpm vitest run server/test/plugins.e2e.test.ts`，它会真实安装默认插件并启动内核。CI 也会跑。
