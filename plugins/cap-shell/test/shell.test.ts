import { createTestNest, type TestNest } from "@swiftnest/sdk";
import { PathGuard } from "@swiftnest/core";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { classifyCommand, DEFAULT_READ_ONLY, tokenize } from "../src/index.js";

const guard = new PathGuard();

describe("classifyCommand", () => {
  it.each([
    ["echo ok", "read"],
    ["df -h", "read"],
    ['grep -n "a b" file.txt', "read"],
    ["cat rm.txt", "read"],
    ["head -n 5 notes.txt", "read"],
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
    expect(classifyCommand(cmd, DEFAULT_READ_ONLY, guard).risk).toBe(risk);
  });

  it("escalates a read-only command that reads a protected location", () => {
    const r = classifyCommand("cat .ssh/id_rsa", DEFAULT_READ_ONLY, guard);
    expect(r.risk).toBe("sensitive");
    expect(r.reason).toMatch(/protected/);
  });

  it("escalates a read-only command that reads outside the shared folders", () => {
    expect(classifyCommand("cat /etc/passwd", DEFAULT_READ_ONLY, guard).risk).toBe("exec");
    expect(classifyCommand("ls -la /tmp", DEFAULT_READ_ONLY, guard).risk).toBe("exec");
  });

  it("keeps a read-only command inside the shared folders as read", () => {
    expect(classifyCommand("cat notes.txt", DEFAULT_READ_ONLY, guard).risk).toBe("read");
  });

  it("honours extra read-only programs from config", () => {
    expect(classifyCommand("git status", DEFAULT_READ_ONLY, guard).risk).toBe("exec");
    expect(classifyCommand("git status", ["git"], guard).risk).toBe("read");
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
    const r = await t.call("sim__shell__run", { command: "ls a-folder-that-does-not-exist" });
    expect(r.state).toBe("succeeded");
    expect(r.result?.text).toMatch(/\[exit code [1-9]/);
  });

  it("refuses a read-only command that reads a protected location, even after approval", async () => {
    t = await createTestNest({ devices: [{ name: "sim", plugins: [plugin] }] });
    const r = await t.call("sim__shell__run", { command: "cat .ssh/id_rsa" }, { approve: true });
    expect(r.state).toBe("failed");
    expect(r.error?.code).toBe("PATH_REFUSED");
  });

  it("asks before a read-only command reads outside the shared folders", async () => {
    t = await createTestNest({ devices: [{ name: "sim", plugins: [plugin] }] });
    const task = await t.nest.call("sim__shell__run", { command: "cat /etc/passwd" }, { id: "test" });
    expect(task.state).toBe("pending_approval");
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