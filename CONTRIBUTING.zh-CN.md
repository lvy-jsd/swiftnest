# 贡献指南

谢谢你愿意参与 Swiftnest！这份指南会帮你在十分钟内跑起来。

## 开发环境

- Node.js 24 或更新
- pnpm（`corepack enable` 即可）

```bash
pnpm install
pnpm build        # 编译所有包
pnpm test         # 跑全部测试（直接测源码，不用先编译）
```

## 仓库结构

| 目录 | 内容 |
|---|---|
| `packages/protocol` | 各组件共用的数据格式（zod） |
| `packages/core` | 核心：插件宿主、身份、能力注册、权限代理、审计、任务状态机、服务器和设备 |
| `packages/sdk` | 写插件用的开发包，带模拟服务器和模拟设备 |
| `packages/cli` | `swiftnest` 命令行 |
| `packages/create-swiftnest-plugin` | `npm create swiftnest-plugin` |
| `plugins/*` | 官方插件，和社区插件地位相同 |
| `templates/*` | 插件模板 |
| `docs/zh`、`docs/en` | 中英文档 |

## 写插件

最简单的贡献方式是写一个插件，通常就是把一个现成的 MCP 服务或几行代码包装成能力。见 [写第一个插件](docs/zh/guide/write-a-plugin.md)。

## 提交改动

1. 先开一个 issue 说明你想做什么（小改动可以直接提 PR）。
2. 代码要有测试；`pnpm build && pnpm test` 必须通过。
3. 用户能看到的文字（命令行输出、错误信息、文档）要**中英双语**：
   - 命令行和错误信息：在对应的 i18n 字典里同时写 `en` 和 `zh`；
   - 文档：`docs/zh` 和 `docs/en` 各改一份。只会一种语言也没关系，在 PR 里说明，维护者会补上（我们用本地模型初译 + 人工校对）。
4. 错误信息要说清楚"哪里错、为什么、怎么修"（`SwiftnestFailure` 的 `suggestion` 字段）。
5. 涉及安全的改动（权限、审批、配对、密钥）请在 PR 里单独说明影响。

## 安全问题

请不要在公开 issue 里报告漏洞，先私下联系维护者。

## 许可证

提交即表示你同意你的贡献以 [Apache-2.0](LICENSE) 授权。
