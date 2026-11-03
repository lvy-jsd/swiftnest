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
| `safety-net`    | [cc-safety-net](https://github.com/kenryu42/cc-safety-net)                     | 开   | 拦截 `rm -rf`、强推、读取密钥等危险操作     |
| `auto-continue` | [dsh-client-auto-continue](https://github.com/HsiangNianian/dsh-auto-continue) | 开   | 中断后可恢复时自动继续                      |
| `smart-title`   | [dsh-smart-title](https://github.com/weibaohui/dsh-smart-title)                | 开   | 按对话内容自动起会话标题                    |
| `cost-meter`    | [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)                | 开   | 统计外部模型的花费和 token，设置预算        |
| `vision-router` | [dsh-vision-router](https://github.com/ysr666/dsh-vision-router)               | 关   | 让纯文本模型看图；图片会发给云端识图模型    |
| `im`            | [dsh-im](https://github.com/xmanrui/dsh-im)                                    | 关   | 接入微信、QQ、飞书、钉钉、Telegram 等机器人 |

cc-safety-net 用的是黑名单，只是默认拒绝规则之外多一层保险。

## 安装与开关

```sh
swiftnest-server plugins install --config swiftnest.yaml
swiftnest-server start --config swiftnest.yaml
```

安装会构建 Tool Ultra，再用 DSH 自带的 `dsh plugin install` 把启用的 npm 插件装进 `<home>/dsh/profiles/swiftnest`，最后核对校验值。需要 Git、npm、pnpm、Node 24 和网络。启动不会自动下载；未安装的插件只打印提示，服务器照常启动。

按 id 开关，环境变量优先：

```yaml
plugins:
  im: true
  smart-title: false
```

```sh
SWIFTNEST_PLUGINS=im=true,smart-title=false
```

改了开关后重新运行 `plugins install` 再重启。打开 `vision-router` 之前先在它的设置里配好识图模型（比如 Gemini），并关掉免 key 的云端兜底，否则图片会发到默认服务。

## 加一个插件

1. 确认许可证在允许列表里，功能不和已有插件重复；
2. 在 `server/plugins.json` 加一条，写上精确版本和 `npm view <包>@<版本> dist.integrity` 的值；
3. 需要账号或会往外发数据的，设 `"enabled": false` 并写明 `reason`；
4. 运行 `SWIFTNEST_PLUGINS_E2E=1 pnpm vitest run server/test/plugins.e2e.test.ts`，它会真实安装默认插件并启动内核。CI 也会跑。
