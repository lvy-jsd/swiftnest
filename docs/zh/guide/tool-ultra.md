# Tool Ultra

Tool Ultra 是 Swiftnest 所有者维护的 DSH 插件（[源码](https://github.com/lvy-jsd/dsh-tool-ultra)，Apache-2.0）。它让模型先浏览、查找，再加载需要的原生工具，减少每轮传入的工具定义。产品完成前不发布到 npm；Swiftnest 固定从提交 `8ccfefa1a922ad407e57ecbe6ea8b68e24adcbd9` 构建。

## 安装与启用

准备 Git、npm、Node 24 和网络，使用服务器的同一个配置与数据目录：

```sh
swiftnest-server tools install --config swiftnest.yaml
swiftnest-server start --config swiftnest.yaml
```

源码安装可运行 `node server/dist/cli.js tools install`。配置文件可省略；通过 `SWIFTNEST_HOME` 指定数据目录时，两个命令须设置相同的值。

安装仅获取固定提交，在 `<home>/vendor/dsh-tool-ultra-8ccfefa1a922` 中使用 Swiftnest 附带的依赖锁文件运行 `npm ci`、`npm run build`。仅在成功后写入构建标记，重复运行直接复用；失败会清理未完成目录，下次可重试。依赖链接指向 Server 自带的 DSH。安装不会使用或发布 npm 上的 Tool Ultra 包。

默认 `toolUltra: true`。启动时若未安装，会给出安装提示并继续运行；启动不会自动获取源码。关闭方法：

```yaml
toolUltra: false
```

或设置 `SWIFTNEST_TOOL_ULTRA=false`，环境变量优先。安装后重启 Server 生效。

构建依赖使用 `mathjs 15.2.0` 安全覆盖，修复固定源码原有依赖的[表达式执行漏洞](https://github.com/josdejong/mathjs/security/advisories/GHSA-29qv-4j9f-fjw5)；源码提交和插件默认配置保持不变。

## 工具与审批

启用的包为 `core`、`classifier-rules`、`risk-gate`、`persist`、`pack-essentials`、`pack-web`、`devices`。默认配置从各包自己的 `cordis.patch.yml` 读取，生成绝对路径的 DSH `insert` 行。自定义配置放在 `<home>/dsh/profiles/swiftnest/user.patch.yml`，最后应用且不被改写；DSH 的配置覆盖会替换整行 `config`，修改时须保留需要的其他字段。

模型可通过 `tools_ls` 浏览目录、`tools_find` 查找工具，通过 `tools_load` 加载。例如：

```json
{ "targets": ["device:all"] }
```

它会加载已配对设备的工具，下一轮即可看到 `device__<slug>__<capability>`。也可使用 `device:<slug>/files` 限定范围。目录加载不会绕过设备权限，也不会自动运行工具。

高风险工具需单独加载，风险门会通过 DSH 的 `approval-request` 交互请求批准。App 聊天显示工具名称和原因，可批准一次或拒绝；无审批回答或请求被取消时不会获得许可。设备执行审批是另一个步骤，仍由 Nest 的设备权限规则控制。

## 验证

开发者可在构建后运行：

```sh
pnpm build
SWIFTNEST_TOOL_ULTRA_E2E=1 pnpm vitest run server/test/tool-ultra.e2e.test.ts
```

测试使用临时数据目录、真实 DSH 内核、脚本模型和配对的 Node Perch。要同时验证 App 中的批准与拒绝按钮，先构建 App 并准备 Chromium，再额外设置 `SWIFTNEST_WEB_E2E=1`（可用 `SWIFTNEST_CHROMIUM` 指定浏览器）。CI 会运行这条完整链路。
