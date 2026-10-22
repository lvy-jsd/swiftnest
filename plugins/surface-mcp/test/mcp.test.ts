/**
 * M0 acceptance (design §14): in a simulated environment an MCP client calls sim__shell__run("echo ok"),
 * gets "ok" back, and the call is in the audit log. Also: risky calls wait for approval instead of running.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import shell from "@swiftnest/cap-shell";
import { memoryLink, MemoryAuditLog, Nest, Perch, silentLogger } from "@swiftnest/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveMcpHttp } from "../src/index.js";

type TextContent = { type: "text"; text: string }[];

describe("MCP surface (M0 acceptance)", () => {
  let nest: Nest;
  let audit: MemoryAuditLog;
  let perch: Perch;
  let http: Awaited<ReturnType<typeof serveMcpHttp>>;
  let client: Client;

  beforeEach(async () => {
    audit = new MemoryAuditLog();
    nest = new Nest({ audit, logger: silentLogger });
    perch = await new Perch({ device: "sim", logger: silentLogger }).use(shell);
    nest.attach(memoryLink(perch));
    http = await serveMcpHttp(nest, { port: 0, waitSeconds: 5 });
    client = new Client({ name: "acceptance-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
  });

  afterEach(async () => {
    await client.close();
    await http.close();
    await nest.close();
    await perch.close();
  });

  it("lists device tools with device-prefixed names, plus the task tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("sim__shell__run");
    expect(names).toEqual(expect.arrayContaining(["swiftnest__devices", "swiftnest__task_wait", "swiftnest__task_status", "swiftnest__task_cancel"]));
    expect(names).not.toContain("swiftnest__task_approve"); // agents must never approve themselves
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9_-]{1,64}$/); // valid OpenAI / Anthropic function names
  });

  it('runs sim__shell__run("echo ok") and records it in the audit log', async () => {
    const res = await client.callTool({ name: "sim__shell__run", arguments: { command: "echo ok" } });
    expect(res.isError).toBeFalsy();
    expect((res.content as TextContent)[0]!.text).toBe("ok");
    const taskId = (res.structuredContent as { task_id: string }).task_id;
    const entries = await audit.query({ taskId });
    expect(entries.map((e) => e.state)).toEqual(["queued", "running", "succeeded"]);
    expect(entries[0]).toMatchObject({ device: "sim", capability: "shell", tool: "run", args: { command: "echo ok" }, client: { id: "mcp:acceptance-test" } });
  });

  it("does not run a destructive command; it waits for the owner and can be cancelled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swiftnest-"));
    const victim = join(dir, "keep-me");
    writeFileSync(victim, "x");
    const res = await client.callTool({ name: "sim__shell__run", arguments: { command: `rm -f ${victim}` } });
    const s = res.structuredContent as { task_id: string; state: string };
    expect(s.state).toBe("pending_approval");
    expect((res.content as TextContent)[0]!.text).toMatch(/approval/);
    expect(existsSync(victim)).toBe(true);
    expect(nest.tasks.get(s.task_id)?.risk).toBe("sensitive");

    const cancelled = await client.callTool({ name: "swiftnest__task_cancel", arguments: { task_id: s.task_id } });
    expect((cancelled.structuredContent as { state: string }).state).toBe("cancelled");
    expect(existsSync(victim)).toBe(true);
  });

  it("returns a task id for approved work and delivers the result through task_wait", async () => {
    const res = await client.callTool({ name: "sim__shell__run", arguments: { command: "echo approved | tr a-z A-Z" } });
    const { task_id } = res.structuredContent as { task_id: string };
    await nest.tasks.approve(task_id, "test owner");
    const done = await client.callTool({ name: "swiftnest__task_wait", arguments: { task_id, seconds: 5 } });
    expect((done.content as TextContent)[0]!.text).toBe("APPROVED");
  });

  it("explains unknown tools instead of failing silently", async () => {
    const res = await client.callTool({ name: "sim__nope__run", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as TextContent)[0]!.text).toMatch(/UNKNOWN_TOOL[\s\S]*How to fix/);
  });

  it("notifies clients when a device joins", async () => {
    const changed = new Promise<void>((resolve) => client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()));
    // The client opens its notification stream right after initialize; give it a moment in this fast test.
    await new Promise((r) => setTimeout(r, 300));
    const laptop = await new Perch({ device: "laptop", logger: silentLogger }).use(shell);
    nest.attach(memoryLink(laptop));
    await changed;
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("laptop__shell__run");
    await laptop.close();
  });
});
