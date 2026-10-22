# 快速开始

五分钟内，在一台机器上让智能体通过 Swiftnest 安全地运行命令。

## 准备

- Node.js 24 或更新（`node --version` 查看）
- pnpm（`corepack enable`）
- 一个支持 MCP 的智能体客户端，例如 Cursor、DSH，或 Claude Desktop

## 1. 安装并编译

```bash
git clone <本仓库> swiftnest
cd swiftnest
pnpm install
pnpm build
```

## 2. 检查环境

```bash
node packages/cli/dist/bin.js doctor
```

每一项出问题，它都会告诉你怎么修。

## 3. 启动练习场

```bash
node packages/cli/dist/bin.js playground
```

练习场在本机启动一个**模拟的服务器**和一台叫 `sim` 的**模拟设备**，设备上装了"命令行"能力。终端里会显示 MCP 端点地址，默认是 `http://127.0.0.1:7710/mcp`。

想换端口：`--port 7720`；想要多台模拟设备：`--devices sim,laptop`；想看英文：`--lang en`。

## 4. 连接智能体

- **Cursor、DSH 等支持 HTTP 的客户端**：把上面的地址加为 MCP 服务器。
- **Claude Desktop**：它通过启动命令连接（stdio），在 `claude_desktop_config.json` 里加：

  ```json
  { "mcpServers": { "swiftnest": { "command": "node", "args": ["/完整路径/swiftnest/packages/cli/dist/bin.js", "playground", "--stdio"] } } }
  ```

  注意：stdio 模式下没有终端可以审批，需要批准的调用会超时被拒绝。想体验审批，请用 HTTP 模式。

## 5. 试试看

对智能体说：

> 在 sim 上运行 `uname -a`

它会调用 `sim__shell__run`，直接返回结果——因为 `uname` 是只读命令。

再说：

> 在 sim 上创建文件 /tmp/hello

这次智能体会收到"等待主人批准"，练习场的终端里弹出审批，显示**原始命令**和风险说明。按 `y` 批准后命令才会执行，智能体用 `swiftnest__task_wait` 拿到结果。

## 6. 看审计日志

每次调用的每个状态变化都记录在：

```
~/.local/state/swiftnest/playground/audit.jsonl
```

每行一条，包含是哪个智能体、在哪台设备、调用了什么、原始参数、结果如何。

## 下一步

- [核心概念](concepts.md)：服务器、设备、插件、风险等级、任务状态
- [写第一个插件](write-a-plugin.md)
