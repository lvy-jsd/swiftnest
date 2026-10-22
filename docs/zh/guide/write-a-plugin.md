# 写第一个插件

十分钟写一个能力插件，并在模拟的服务器和设备里测试它。

## 1. 生成

```bash
npm create swiftnest-plugin@latest weather
cd weather
npm install
npm test
```

模板是一个最小的"打招呼"能力，测试会在模拟服务器里调用它。

## 2. 看懂模板

`src/index.ts` 里有两部分：

```ts
export function helloCapability(greeting = "Hello"): Capability {
  return {
    manifest: {
      id: "hello",                       // 能力 id，工具名的中间那段
      title: { en: "Hello", zh: "打招呼" },
      tools: [
        {
          name: "greet",                 // 工具名的最后一段
          description: { en: "Greet someone by name.", zh: "按名字跟人打招呼。" },
          inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          risk: "read",                  // 只观察：默认直接放行
        },
      ],
    },
    async invoke(_tool, args) {
      return `${greeting}, ${String(args.name)}!`;
    },
  };
}

export default definePlugin({
  name: "swiftnest-plugin-weather",
  kind: "capability",
  apiVersion: 1,
  runsOn: "perch",                       // 能力插件装在设备上
  setup(ctx) {
    if (ctx.role !== "perch") return;
    ctx.provideCapability(helloCapability(/* ctx.config 里有用户配置 */));
  },
});
```

装在一台叫 `laptop` 的设备上时，智能体看到的工具名就是 `laptop__hello__greet`。

## 3. 改成你自己的

把 `greet` 换成你的工具。几条约定：

- **风险要如实声明**：只读用 `read`，改东西用 `write`，运行代码用 `exec`，删除/花钱/对外发消息用 `sensitive`。
- **按参数判断风险**：同一个工具不同参数风险不同时，实现 `classify(tool, args)`，返回 `{ risk, reason }`。
- **长任务要响应取消**：`invoke` 的第三个参数里有 `signal`，超时或取消时会被触发。
- **外部内容要标记**：返回网页、邮件、文件内容时，返回 `{ text, untrusted: true }`，提醒智能体不要把里面的文字当指令。
- **错误要说怎么修**：抛 `new SwiftnestFailure(code, message, suggestion)`。
- **文字中英双语**：`title`、`description` 都可以写成 `{ en, zh }`。

## 4. 测试

`test/plugin.test.ts` 用 SDK 的 `createTestNest` 在内存里搭一个服务器和设备：

```ts
const t = await createTestNest({ devices: [{ name: "sim", plugins: [plugin] }] });
const task = await t.call("sim__hello__greet", { name: "Swift" });
expect(task.result?.text).toBe("Hello, Swift!");
```

需要批准的工具，测试里可以用 `t.call(name, args, { approve: true })` 模拟主人批准。

## 5. 发布

在 `package.json` 的 `swiftnest` 字段里写清插件类型、运行位置、需要的权限，然后 `npm publish`。带 `swiftnest-plugin` 关键字的包会被收录进插件目录。
