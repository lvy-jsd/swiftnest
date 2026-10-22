import { createTestNest, type TestNest } from "@swiftnest/sdk";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { classifyCommand, tokenize } from "../src/index.js";

describe("classifyCommand", () => {
  it.each([
    ["ls -la /tmp", "read"],
    ["echo ok", "read"],
    ["df -h", "read"],
    ['grep -n "a b" file.txt', "read"],
    ["cat rm.txt", "read"],
    ["ls | wc -l", "exec"],
    ["echo hi > out.txt", "exec"],
    ["ls ~/projects", "exec"],
    ["python3 script.py", "exec"],
    ["rm -rf /", "sensitive"],
    ["ls; rm -rf ~", "sensitive"],
    ["sudo ls", "sensitive"],
    ["mkfs.ext4 /dev/sda1", "sensitive"],
    ["find . -name x -delete", "sensitive"],
    ["/usr/bin/shutdown now", "sensitive"],
    ['echo "unbalanced', "exec"],
  ])("%s → %s", (cmd, risk) => {
    expect(classifyCommand(cmd).risk).toBe(risk);
  });

  it("honours extra read-only programs from config", () => {
    expect(classifyCommand("git status").risk).toBe("exec");
    expect(classifyCommand("git status", ["git"]).risk).toBe("read");
  });

  it("tokenizes quotes", () => {
    expect(tokenize(`grep -n "a b" 'c d'`)).toEqual(["grep", "-n", "a b", "c d"]);
    expect(tokenize(`echo ""`)).toEqual(["echo", ""]);
    expect(tokenize(`echo "x`)).toBeNull();
  });
});

describe("shell capability", () => {
  let t: TestNest;
  afterEach(() => t?.close());

  it("runs read-only commands without asking", async () => {
    t = await createTestNest({ devices: [{ name: "sim", plugins: [plugin] }] });
    const r = await t.call("sim__shell__run", { command: "echo hello" });
    expect(r.state).toBe("succeeded");
    expect(r.result?.text).toBe("hello");
  });

  it("reports the exit code and stderr of failing commands", async () => {
    t = await createTestNest({ devices: [{ name: "sim", plugins: [plugin] }] });
    const r = await t.call("sim__shell__run", { command: "ls /definitely/not/here" });
    expect(r.state).toBe("succeeded");
    expect(r.result?.text).toMatch(/\[exit code [1-9]/);
  });

  it("kills commands that run past their timeout", async () => {
    t = await createTestNest({ devices: [{ name: "sim", plugins: [plugin] }] });
    const task = await t.nest.call("sim__shell__run", { command: "sleep 5" }, { id: "test" }, 300);
    await t.nest.tasks.approve(task.id);
    const done = await t.nest.tasks.wait(task.id, 5_000);
    expect(done.state).toBe("timed_out");
    expect(done.error?.retryable).toBe(true);
  });

  it("explains a missing program", async () => {
    t = await createTestNest({ devices: [{ name: "sim", plugins: [plugin] }] });
    const r = await t.call("sim__shell__run", { command: "definitely-not-a-program-xyz" }, { approve: true });
    expect(r.result?.text ?? r.error?.message).toMatch(/not found|exit code 127/);
  });
});
