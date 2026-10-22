# Write Your First Plugin

Write a capability plugin in ten minutes and test it on a simulated server and device.

## 1. Generate

```bash
npm create swiftnest-plugin@latest weather
cd weather
npm install
npm test
```

The template is a minimal "hello" capability; the test invokes it on a simulated server.

## 2. Understand the Template

`src/index.ts` has two parts:

```ts
export function helloCapability(greeting = "Hello"): Capability {
  return {
    manifest: {
      id: "hello",                       // capability id, the middle segment of the tool name
      title: { en: "Hello", zh: "打招呼" },
      tools: [
        {
          name: "greet",                 // last segment of the tool name
          description: { en: "Greet someone by name.", zh: "按名字跟人打招呼。" },
          inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          risk: "read",                  // read-only: allowed by default
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
  runsOn: "perch",                       // capability plugins run on devices
  setup(ctx) {
    if (ctx.role !== "perch") return;
    ctx.provideCapability(helloCapability(/* ctx.config holds user configuration */));
  },
});
```

When installed on a device called `laptop`, the agent sees the tool name `laptop__hello__greet`.

## 3. Make It Your Own

Replace `greet` with your own tool. A few conventions:

- **Declare risk honestly**: use `read` for read-only, `write` for mutations, `exec` for running code, and `sensitive` for deletion, spending money, or sending outbound messages.
- **Classify risk by arguments**: when the same tool has different risk levels depending on its arguments, implement `classify(tool, args)` and return `{ risk, reason }`.
- **Handle cancellation for long tasks**: the third parameter of `invoke` includes a `signal` that fires on timeout or cancellation.
- **Mark external content**: when returning web pages, emails, or file contents, return `{ text, untrusted: true }` to remind the agent not to treat the text inside as instructions.
- **Explain how to fix errors**: throw `new SwiftnestFailure(code, message, suggestion)`.
- **Write text bilingually**: both `title` and `description` accept `{ en, zh }`.

## 4. Test

`test/plugin.test.ts` uses the SDK's `createTestNest` to spin up an in-memory server and device:

```ts
const t = await createTestNest({ devices: [{ name: "sim", plugins: [plugin] }] });
const task = await t.call("sim__hello__greet", { name: "Swift" });
expect(task.result?.text).toBe("Hello, Swift!");
```

For tools that require approval, use `t.call(name, args, { approve: true })` in tests to simulate the owner approving.

## 5. Publish

In the `swiftnest` field of `package.json`, specify the plugin type, where it runs, and the permissions it needs, then run `npm publish`. Packages with the `swiftnest-plugin` keyword are indexed in the plugin directory.
