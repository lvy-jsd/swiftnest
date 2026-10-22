/**
 * A minimal Swiftnest capability plugin. Rename it, then replace the `greet` tool with your own.
 * Guide: docs/en/guide/write-a-plugin.md (中文：docs/zh/guide/write-a-plugin.md) in the Swiftnest repository.
 */
import { definePlugin, type Capability } from "@swiftnest/sdk";

export function helloCapability(greeting = "Hello"): Capability {
  return {
    manifest: {
      id: "hello",
      version: "0.0.1",
      title: { en: "Hello", zh: "打招呼" },
      tools: [
        {
          name: "greet",
          description: { en: "Greet someone by name.", zh: "按名字跟人打招呼。" },
          inputSchema: {
            type: "object",
            properties: { name: { type: "string", description: "Who to greet" } },
            required: ["name"],
          },
          // read: only observes, so the default policy runs it without asking.
          risk: "read",
        },
      ],
    },
    async invoke(_tool, args) {
      return `${greeting}, ${String(args.name)}!`;
    },
  };
}

export default definePlugin({
  name: "swiftnest-plugin-hello",
  kind: "capability",
  apiVersion: 1,
  runsOn: "perch",
  setup(ctx) {
    if (ctx.role !== "perch") return;
    ctx.provideCapability(helloCapability(typeof ctx.config.greeting === "string" ? ctx.config.greeting : undefined));
  },
});
