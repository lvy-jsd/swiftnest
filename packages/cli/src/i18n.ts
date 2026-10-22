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
  swiftnest playground [--port 7710] [--devices sim] [--stdio] [--lang zh|en]
      Run a simulated server (Nest) and devices on this machine, with an MCP endpoint.
  swiftnest doctor     Check this machine and tell you how to fix problems.
  swiftnest version    Print the version.
`,
    zh: `Swiftnest（燕巢）—— 把你的设备变成任何智能体都能安全调用的能力。

用法：
  swiftnest playground [--port 7710] [--devices sim] [--stdio] [--lang zh|en]
      在本机运行一个模拟的服务器（巢）和设备，并提供 MCP 端点。
  swiftnest doctor     检查这台机器，并告诉你问题怎么修。
  swiftnest version    显示版本。
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
  noTerminal: {
    en: "   (No terminal input available, so it cannot be approved here. It stays pending and expires after 10 minutes. Run the playground in an interactive terminal to approve.)",
    zh: "   （没有可用的终端输入，无法在这里批准。它会保持等待状态，10 分钟后过期。请在交互式终端里运行练习场来审批。）",
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
  unknownCommand: {
    en: (c: string) => `Unknown command "${c}". Run "swiftnest --help" to see the commands.`,
    zh: (c: string) => `未知命令 "${c}"。运行 "swiftnest --help" 查看可用命令。`,
  },
};

type Strings = typeof STRINGS;
export function t<K extends keyof Strings>(lang: Lang, key: K): Strings[K][Lang] {
  return STRINGS[key][lang];
}
