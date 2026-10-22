/** CLI strings in both languages (design: zh and en on equal footing). Language: --lang, else LC_ALL / LANG. */
export type Lang = "en" | "zh";

export function detectLang(flag?: string): Lang {
  const v = (flag ?? process.env.SWIFTNEST_LANG ?? process.env.LC_ALL ?? process.env.LANG ?? "").toLowerCase();
  return v.startsWith("zh") ? "zh" : "en";
}

const STRINGS = {
  usage: {
    en: `Swiftnest — turn your devices into capabilities any agent can call safely.

Usage:
  Server (Nest), on the always-on machine:
    swiftnest nest [--lan-port 7711] [--mcp-port 7710] [--no-mdns]
        Run the Nest: devices connect to it over the LAN, agents over MCP (http://127.0.0.1:7710/mcp).
    swiftnest pair                 Show a one-time pairing code and confirm the device's fingerprint.
    swiftnest devices              Paired devices, online or not.
    swiftnest revoke <device>      Disconnect a device and forget it (it must pair again).
    swiftnest pending              Calls waiting for your approval.
    swiftnest approve <task-id>    Approve one.   swiftnest deny <task-id>   Deny one.
    swiftnest audit [-n 20] [--device laptop]   The latest audit entries.

  Device (Perch), on each machine you want agents to use:
    swiftnest perch --name laptop --pair <code> [--nest ws://host:7711/swiftnest]
        First run: pair with the code from \`swiftnest pair\`, then stay connected.
    swiftnest perch --name laptop [--roots ~/projects,~/notes] [--read-only git]
        Later runs: connect with the saved pairing. Ctrl+C disconnects at once.

  Try it on one machine:
    swiftnest playground [--port 7710] [--devices sim] [--stdio]
  swiftnest doctor     Check this machine and tell you how to fix problems.
  swiftnest version    Print the version.

  Every command takes --lang zh|en.
`,
    zh: `Swiftnest（燕巢）—— 把你的设备变成任何智能体都能安全调用的能力。

用法：
  服务器（巢），在常开的机器上：
    swiftnest nest [--lan-port 7711] [--mcp-port 7710] [--no-mdns]
        运行巢：设备经局域网连进来，智能体经 MCP 连进来（http://127.0.0.1:7710/mcp）。
    swiftnest pair                 显示一次性配对码，并核对设备的指纹。
    swiftnest devices              已配对的设备（在线或离线）。
    swiftnest revoke <设备>        断开并忘记一台设备（之后必须重新配对）。
    swiftnest pending              等你批准的调用。
    swiftnest approve <任务号>     批准。   swiftnest deny <任务号>   拒绝。
    swiftnest audit [-n 20] [--device laptop]   最近的审计记录。

  设备（栖点），在每台想让智能体使用的机器上：
    swiftnest perch --name laptop --pair <配对码> [--nest ws://地址:7711/swiftnest]
        第一次：用 \`swiftnest pair\` 显示的配对码配对，然后保持连接。
    swiftnest perch --name laptop [--roots ~/projects,~/notes] [--read-only git]
        以后：用保存的配对直接连接。按 Ctrl+C 立即断开。

  在一台机器上先试试：
    swiftnest playground [--port 7710] [--devices sim] [--stdio]
  swiftnest doctor     检查这台机器，并告诉你问题怎么修。
  swiftnest version    显示版本。

  所有命令都可以加 --lang zh|en。
`,
  },
  playgroundReady: {
    en: (url: string, devices: string) => `
🪺 Swiftnest playground is running.
   Devices: ${devices}
   MCP endpoint (Streamable HTTP): ${url}

Connect an agent:
  • Cursor / DSH / any HTTP MCP client: add the URL above.
  • Claude Desktop: use the stdio form, e.g. in claude_desktop_config.json
      "swiftnest": { "command": "npx", "args": ["swiftnest", "playground", "--stdio"] }

Try asking the agent: "run \`uname -a\` on sim".
Read-only commands run at once; anything else waits for you to approve here.
Audit log: %AUDIT%
Press Ctrl+C to stop.
`,
    zh: (url: string, devices: string) => `
🪺 Swiftnest 练习场已启动。
   设备：${devices}
   MCP 端点（Streamable HTTP）：${url}

连接智能体：
  • Cursor / DSH / 任何支持 HTTP 的 MCP 客户端：填上面的地址。
  • Claude Desktop：用 stdio 方式，在 claude_desktop_config.json 里写
      "swiftnest": { "command": "npx", "args": ["swiftnest", "playground", "--stdio"] }

试着对智能体说："在 sim 上运行 \`uname -a\`"。
只读命令会直接执行；其他命令会在这里等你批准。
审计日志：%AUDIT%
按 Ctrl+C 停止。
`,
  },
  approvalPrompt: {
    en: (client: string, device: string, tool: string, args: string, risk: string, reason: string) =>
      `\n⚠️  Approval needed\n   From:   ${client}\n   Device: ${device}\n   Tool:   ${tool}\n   Args:   ${args}\n   Risk:   ${risk} — ${reason}\n   Approve? [y/N] `,
    zh: (client: string, device: string, tool: string, args: string, risk: string, reason: string) =>
      `\n⚠️  需要你批准\n   来自：${client}\n   设备：${device}\n   工具：${tool}\n   参数：${args}\n   风险：${risk} —— ${reason}\n   批准吗？[y/N] `,
  },
  noTerminalTask: {
    en: (id: string) => `   (No terminal input here. Approve with \`swiftnest approve ${id}\` or deny with \`swiftnest deny ${id}\`; it expires after 10 minutes.)`,
    zh: (id: string) => `   （这里没有终端输入。用 \`swiftnest approve ${id}\` 批准，或 \`swiftnest deny ${id}\` 拒绝；10 分钟后过期。）`,
  },
  approved: { en: "   ✓ approved", zh: "   ✓ 已批准" },
  denied: { en: "   ✗ denied", zh: "   ✗ 已拒绝" },
  stdioNoApproval: {
    en: "stdio mode: there is no terminal to approve in, so calls that need approval will expire (denied). Use the HTTP mode to approve interactively.",
    zh: "stdio 模式下没有终端可以审批，需要批准的调用会超时被拒绝。想交互审批请用 HTTP 模式。",
  },
  doctorOk: { en: "✓", zh: "✓" },
  doctorNode: {
    en: (v: string) => `Node.js ${v} is too old; Swiftnest needs 24 or newer. Install it from https://nodejs.org/ or with your package manager.`,
    zh: (v: string) => `Node.js ${v} 版本太旧，Swiftnest 需要 24 或更新。可以从 https://nodejs.org/ 或系统包管理器安装。`,
  },
  doctorNodeOk: { en: (v: string) => `Node.js ${v}`, zh: (v: string) => `Node.js ${v}` },
  doctorPlatform: {
    en: (p: string) => `Platform ${p}: the shell capability supports Linux and macOS today; Windows support is planned.`,
    zh: (p: string) => `平台 ${p}：命令行能力目前支持 Linux 和 macOS，Windows 支持在计划中。`,
  },
  doctorPlatformOk: { en: (p: string) => `Platform ${p}`, zh: (p: string) => `平台 ${p}` },
  doctorState: {
    en: (d: string) => `Cannot write to ${d}. Fix the permissions, or set SWIFTNEST_HOME to a writable directory.`,
    zh: (d: string) => `无法写入 ${d}。请修正权限，或把 SWIFTNEST_HOME 设为一个可写的目录。`,
  },
  doctorStateOk: { en: (d: string) => `State directory ${d}`, zh: (d: string) => `数据目录 ${d}` },
  doctorPort: {
    en: (p: number) => `Port ${p} is in use. Stop whatever uses it, or start the playground with --port <another>.`,
    zh: (p: number) => `端口 ${p} 已被占用。停掉占用它的程序，或用 --port <其他端口> 启动练习场。`,
  },
  doctorPortOk: { en: (p: number) => `Port ${p} is free`, zh: (p: number) => `端口 ${p} 可用` },
  doctorSummary: {
    en: (n: number) => (n ? `\n${n} problem(s) found.` : "\nAll good."),
    zh: (n: number) => (n ? `\n发现 ${n} 个问题。` : "\n一切正常。"),
  },
  // ------------------------------------------------------------ Nest
  nestReady: {
    en: (fp: string, lanPort: number, mcp: string, audit: string, interactive: boolean) => `
🪺 Swiftnest Nest is running.
   Nest fingerprint: ${fp}
   Devices connect on port ${lanPort} (LAN, end-to-end encrypted).
   Agents connect to: ${mcp}

Add a device:
   1. Here (another terminal):   swiftnest pair
   2. On the device:             swiftnest perch --name laptop --pair <code>
      (if it cannot find this Nest: add --nest ws://<this machine's address>:${lanPort}/swiftnest;
       a host firewall must allow TCP ${lanPort}, and UDP 5353 for automatic discovery)

Connect an agent:
   • Claude Code:     claude mcp add --transport http swiftnest ${mcp}
   • Cursor / DSH / any HTTP MCP client: the URL above
   • Claude Desktop:  "swiftnest": { "command": "npx", "args": ["-y", "mcp-remote", "${mcp}"] }

${interactive ? "Approvals appear here." : "No terminal: approve with `swiftnest pending` / `swiftnest approve <id>`."}
Audit log: ${audit}
Press Ctrl+C to stop.
`,
    zh: (fp: string, lanPort: number, mcp: string, audit: string, interactive: boolean) => `
🪺 Swiftnest 巢已启动。
   巢的指纹：${fp}
   设备连接端口：${lanPort}（局域网，端到端加密）
   智能体连接地址：${mcp}

添加设备：
   1. 在这台机器（另开一个终端）：swiftnest pair
   2. 在设备上：                   swiftnest perch --name laptop --pair <配对码>
      （如果设备找不到巢：加上 --nest ws://<这台机器的地址>:${lanPort}/swiftnest；
        防火墙需要放行 TCP ${lanPort}，自动发现还需要 UDP 5353）

连接智能体：
   • Claude Code：     claude mcp add --transport http swiftnest ${mcp}
   • Cursor / DSH / 任何 HTTP MCP 客户端：填上面的地址
   • Claude Desktop：  "swiftnest": { "command": "npx", "args": ["-y", "mcp-remote", "${mcp}"] }

${interactive ? "审批请求会显示在这里。" : "没有终端：用 `swiftnest pending` / `swiftnest approve <任务号>` 审批。"}
审计日志：${audit}
按 Ctrl+C 停止。
`,
  },
  pairStarted: {
    en: (code: string, until: string, fp: string) => `
Pairing code: ${code}   (valid until ${until}, one device)
Nest fingerprint: ${fp}   ← the device will show this; check it matches.

On the device run:  swiftnest perch --name <name> --pair ${code}
Waiting for the device…
`,
    zh: (code: string, until: string, fp: string) => `
配对码：${code}   （有效期到 ${until}，只能配一台设备）
巢的指纹：${fp}   ← 设备上会显示这个，请核对是否一致。

在设备上运行：swiftnest perch --name <名字> --pair ${code}
正在等待设备……
`,
  },
  pairHeadless: {
    en: "No terminal here: once the device connects, list it with `swiftnest pair --pending` and confirm with `swiftnest pair --confirm <id>` (or answer in the Nest's own terminal).",
    zh: "这里没有终端：设备连上后，用 `swiftnest pair --pending` 查看，再用 `swiftnest pair --confirm <编号>` 确认（也可以在巢自己的终端里回答）。",
  },
  pairConfirmPrompt: {
    en: (device: string, fp: string) => `\n🔑 Device "${device}" wants to pair.\n   Its fingerprint: ${fp}\n   Does the device show the same fingerprint? [y/N] `,
    zh: (device: string, fp: string) => `\n🔑 设备 "${device}" 请求配对。\n   它的指纹：${fp}\n   设备上显示的指纹一样吗？[y/N] `,
  },
  noTerminalPair: {
    en: (id: string) => `   (No terminal input here. Confirm with \`swiftnest pair --confirm ${id}\` or refuse with \`swiftnest pair --reject ${id}\`.)`,
    zh: (id: string) => `   （这里没有终端输入。用 \`swiftnest pair --confirm ${id}\` 确认，或 \`swiftnest pair --reject ${id}\` 拒绝。）`,
  },
  pairOwnerYes: { en: "   ✓ confirmed on the Nest (the device must confirm too)", zh: "   ✓ 巢这边已确认（设备那边也要确认）" },
  pairOwnerNo: { en: "   ✗ refused", zh: "   ✗ 已拒绝" },
  pairPendingRow: {
    en: (id: string, device: string, fp: string) => `${id}  "${device}"  fingerprint ${fp}`,
    zh: (id: string, device: string, fp: string) => `${id}  "${device}"  指纹 ${fp}`,
  },
  pairNoneWaiting: { en: "No device is waiting to pair.", zh: "没有等待配对的设备。" },
  pairNoSuch: { en: "No device is waiting with that id.", zh: "没有这个编号的待配对设备。" },
  pairExpired: { en: "The pairing code expired. Run `swiftnest pair` again.", zh: "配对码已过期。请重新运行 `swiftnest pair`。" },
  devicesNone: { en: "No paired devices yet. Add one with `swiftnest pair`.", zh: "还没有配对的设备。用 `swiftnest pair` 添加。" },
  devicesRow: {
    en: (d: string, online: boolean, via: string | undefined, since: string, tools: string) => `${online ? "●" : "○"} ${d.padEnd(16)} ${online ? `online via ${via}` : "offline"}   paired ${since}${tools ? `\n    ${tools}` : ""}`,
    zh: (d: string, online: boolean, via: string | undefined, since: string, tools: string) => `${online ? "●" : "○"} ${d.padEnd(16)} ${online ? `在线（${via}）` : "离线"}   配对于 ${since}${tools ? `\n    ${tools}` : ""}`,
  },
  needArg: { en: (usage: string) => `Usage: ${usage}`, zh: (usage: string) => `用法：${usage}` },
  revoked: { en: (d: string) => `Revoked ${d}: disconnected and forgotten.`, zh: (d: string) => `已吊销 ${d}：已断开并删除配对。` },
  revokeUnknown: { en: (d: string) => `No device called ${d}.`, zh: (d: string) => `没有叫 ${d} 的设备。` },
  pendingNone: { en: "Nothing is waiting for approval.", zh: "没有等待批准的调用。" },
  pendingRow: {
    en: (id: string, device: string, tool: string, args: string, risk: string, reason: string) => `${id}  ${device} ${tool} ${args}\n    risk ${risk}: ${reason}`,
    zh: (id: string, device: string, tool: string, args: string, risk: string, reason: string) => `${id}  ${device} ${tool} ${args}\n    风险 ${risk}：${reason}`,
  },
  auditNone: { en: "The audit log is empty.", zh: "审计日志是空的。" },

  // ------------------------------------------------------------ Perch
  perchNotPaired: {
    en: (name: string) => `Device "${name}" is not paired with a Nest yet.`,
    zh: (name: string) => `设备 "${name}" 还没有和巢配对。`,
  },
  perchNotPairedHint: {
    en: (name: string) => `On the Nest run \`swiftnest pair\`, then here: swiftnest perch --name ${name} --pair <code>`,
    zh: (name: string) => `先在巢上运行 \`swiftnest pair\`，再在这里运行：swiftnest perch --name ${name} --pair <配对码>`,
  },
  perchStarting: {
    en: (name: string, fp: string, roots: string) => `🐦 Swiftnest device "${name}" (fingerprint ${fp})\n   Shares: shell commands, and files in ${roots}\n   Ctrl+C disconnects at once.\n`,
    zh: (name: string, fp: string, roots: string) => `🐦 Swiftnest 设备 "${name}"（指纹 ${fp}）\n   共享：命令行，以及 ${roots} 里的文件\n   按 Ctrl+C 立即断开。\n`,
  },
  perchFpPrompt: {
    en: (fp: string) => `\n🔑 The Nest's fingerprint: ${fp}\n   Is it the same as the one \`swiftnest pair\` shows on the Nest? [y/N] `,
    zh: (fp: string) => `\n🔑 巢的指纹：${fp}\n   和巢上 \`swiftnest pair\` 显示的一样吗？[y/N] `,
  },
  perchFpMatch: { en: (fp: string) => `   ✓ Nest fingerprint ${fp} matches --fingerprint`, zh: (fp: string) => `   ✓ 巢的指纹 ${fp} 与 --fingerprint 一致` },
  perchFpMismatch: {
    en: (fp: string) => `   ✗ Nest fingerprint ${fp} does not match --fingerprint; refusing. Someone may be impersonating the Nest.`,
    zh: (fp: string) => `   ✗ 巢的指纹 ${fp} 与 --fingerprint 不一致，已拒绝。可能有人在冒充巢。`,
  },
  perchFpNoTerminal: {
    en: (fp: string) => `   No terminal to confirm the Nest fingerprint (${fp}). Run again in a terminal, or pass --fingerprint ${fp} after checking it on the Nest.`,
    zh: (fp: string) => `   没有终端来确认巢的指纹（${fp}）。请在终端里重新运行，或在巢上核对后加上 --fingerprint ${fp}。`,
  },
  perchStatus: {
    en: (s: string, d?: string) =>
      ({ searching: "… looking for the Nest", connecting: `… connecting to ${d}`, pairing: "… pairing", online: `● online (${d})`, offline: `○ offline: ${d} — retrying` } as Record<string, string>)[s] ?? s,
    zh: (s: string, d?: string) =>
      ({ searching: "… 正在寻找巢", connecting: `… 正在连接 ${d}`, pairing: "… 正在配对", online: `● 已在线（${d}）`, offline: `○ 已离线：${d} —— 稍后重试` } as Record<string, string>)[s] ?? s,
  },
  perchFinished: {
    en: (code: string, message: string) =>
      code === "DEVICE_DISCONNECTED" ? "Disconnected." : code === "REVOKED" ? "This device was revoked on the Nest; its pairing is deleted. Pair again to reconnect." : `Stopped: ${message} [${code}]`,
    zh: (code: string, message: string) =>
      code === "DEVICE_DISCONNECTED" ? "已断开。" : code === "REVOKED" ? "这台设备已在巢上被吊销，本地配对已删除。要重新连接请重新配对。" : `已停止：${message} [${code}]`,
  },
  unknownCommand: {
    en: (c: string) => `Unknown command "${c}". Run "swiftnest --help" to see the commands.`,
    zh: (c: string) => `未知命令 "${c}"。运行 "swiftnest --help" 查看可用命令。`,
  },
};

type Strings = typeof STRINGS;
export function t<K extends keyof Strings>(lang: Lang, key: K): Strings[K][Lang] {
  return STRINGS[key][lang];
}
