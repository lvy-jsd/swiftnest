# 两台机器：巢 + 设备

把一台常开的机器（比如家里的服务器）当作**巢**，把笔记本当作**设备**。配好之后，智能体连上巢，就能在笔记本上运行命令、读写文件——只读操作直接执行，其余的等你批准。

> 先在一台机器上跑过[快速开始](./quickstart)会更容易理解。下面的 `swiftnest` 指 `node packages/cli/dist/bin.js`（两台机器都要先 `pnpm install && pnpm build`）。

## 1. 在服务器上启动巢

```bash
swiftnest nest
```

它会显示：

- **巢的指纹**（4 组 4 位，如 `9c6c-2c10-7344-93c7`），配对时要核对；
- 设备连接的端口（默认 `7711`，局域网，端到端加密）；
- 智能体连接的地址（默认 `http://127.0.0.1:7710/mcp`，只在本机监听）。

巢的密钥、已配对设备和审计日志都在 `~/.local/state/swiftnest/nest/`（可用 `SWIFTNEST_HOME` 改）。

**防火墙**：设备要能连到服务器的 TCP `7711`。自动发现巢用的是 mDNS（UDP `5353`）；很多 Linux 发行版（包括 NixOS）默认会挡掉它——挡掉也没关系，设备上加 `--nest ws://<服务器地址>:7711/swiftnest` 就行。

## 2. 配对

在服务器上**另开一个终端**：

```bash
swiftnest pair
```

它显示一个 **6 位配对码**（5 分钟内有效，只能配一台设备）和巢的指纹。

在笔记本上：

```bash
swiftnest perch --name laptop --pair 123456
# 找不到巢时：
swiftnest perch --name laptop --pair 123456 --nest ws://192.168.1.10:7711/swiftnest
```

然后**两边各确认一次指纹**：

| 在哪里 | 显示什么 | 你要做什么 |
|---|---|---|
| 笔记本 | 巢的指纹 | 和 `swiftnest pair` 显示的比一比，一样就回答 `y` |
| 服务器（`swiftnest pair` 的终端） | 笔记本的指纹 | 和笔记本启动时显示的比一比，一样就回答 `y` |

为什么要两步：配对码证明"是主人允许的"，但 6 位数可以被中间人离线猜出来；指纹一致才证明"中间没有人"。

配好后笔记本显示 `● 已在线`。以后只要运行 `swiftnest perch --name laptop`，它会用保存的配对自动连上，断线也会自己重连。

**共享哪些文件**：默认是家目录，用 `--roots ~/projects,~/notes` 收窄。无论怎么设置，`~/.ssh`、`~/.gnupg`、云服务凭据、密码库、浏览器资料和 Swiftnest 自己的密钥都**永远拒绝**访问。

## 3. 连接智能体

在服务器上（智能体和巢在同一台机器时）：

- **Claude Code**：`claude mcp add --transport http swiftnest http://127.0.0.1:7710/mcp`
- **Cursor、DSH 等 HTTP MCP 客户端**：填 `http://127.0.0.1:7710/mcp`
- **Claude Desktop**：在 `claude_desktop_config.json` 里加
  ```json
  "swiftnest": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:7710/mcp"] }
  ```

智能体会看到 `laptop__shell__run`、`laptop__files__read` 这样的工具。试着说："在 laptop 上运行 `echo ok`"。

## 4. 审批

- `ls`、`cat`、`df` 这类只读命令、读文件：直接执行。
- 其他命令、写文件：等你批准。`rm`、`sudo`、删除文件这类**敏感**操作同样要批准，规则也不能把它们改成自动放行。

在巢的终端里会直接问你 `[y/N]`。巢在后台运行时，用：

```bash
swiftnest pending              # 看等待批准的调用（显示原始参数和风险）
swiftnest approve <任务号>
swiftnest deny <任务号>
```

无人处理的审批 10 分钟后自动拒绝。智能体可以用 `swiftnest__task_cancel` 取消运行中的调用，设备上的进程会被真正终止。

## 5. 查看和撤销

```bash
swiftnest devices                     # 已配对的设备、是否在线、有哪些工具
swiftnest audit -n 50                 # 最近的审计记录：谁、在哪台设备、做了什么、结果如何
swiftnest revoke laptop               # 立即断开并删除配对；它必须重新配对才能回来
```

在笔记本上按 **Ctrl+C** 也会立即断开。

## 出问题时

| 现象 | 原因和办法 |
|---|---|
| 笔记本一直显示"正在寻找巢" | mDNS 被防火墙挡了：加 `--nest ws://<服务器地址>:7711/swiftnest` |
| `NOT_PAIRED` | 这台设备没配过、或已被吊销：重新 `swiftnest pair` |
| `NEST_KEY_CHANGED` | 这个地址上的巢不是当初配对的那个（重装了巢，或有人冒充）：确认后重新配对 |
| `PAIRING_CLOSED` | 巢现在不在配对：先运行 `swiftnest pair`，5 分钟内用配对码 |
| `NEST_NOT_RUNNING` | `swiftnest pair` 等命令找不到正在运行的巢：先 `swiftnest nest` |
