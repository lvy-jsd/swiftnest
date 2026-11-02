import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  startDevices,
  ADMIN_URL_ENV,
  ADMIN_TOKEN_ENV,
} from "../src/devices.js";
import { loadConfig } from "../src/config.js";
import { FileCipher } from "../src/file-storage.js";
import type { FileStreamOptions } from "@swiftnest/core";
import type { Transfer } from "@swiftnest/api";

async function hash(path: string) {
  const h = createHash("sha256");
  for await (const data of createReadStream(path)) h.update(data);
  return h.digest("hex");
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "perch-files-"));
  const children: ChildProcessWithoutNullStreams[] = [];
  const errors: string[] = [];
  const hub = await startDevices(
    loadConfig(undefined, {
      SWIFTNEST_HOME: join(home, "server"),
      SWIFTNEST_DEVICES_HOST: "127.0.0.1",
      SWIFTNEST_DEVICES_PORT: "0",
      SWIFTNEST_DEVICES_MDNS: "false",
    }),
  );
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(
      hub.env[ADMIN_URL_ENV] + "/swiftnest/api/devices" + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer " + hub.env[ADMIN_TOKEN_ENV],
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data;
  };
  async function host(name: string) {
    const root = join(home, name);
    await mkdir(root);
    const dir = join(home, name + "-state");
    let states: any[] = [];
    let child: ChildProcessWithoutNullStreams;
    const send = (v: unknown) => child.stdin.write(JSON.stringify(v) + "\n");
    const launch = async () => {
      states = [];
      child = spawn(resolve("target/debug/examples/interop"), [dir], {
        env: { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "" },
      });
      children.push(child);
      createInterface({ input: child.stdout }).on("line", (l) =>
        states.push(JSON.parse(l)),
      );
      child.stderr.on("data", (d) => errors.push(String(d)));
      await expect.poll(() => !!states.at(-1)?.settings).toBe(true);
    };
    await launch();
    const { code } = hub.nest.pairing.start();
    send({
      op: "start",
      settings: {
        ...states.at(-1).settings,
        name,
        enabled: true,
        roots: [root],
        url: hub.lanUrl,
      },
      code,
    });
    await expect
      .poll(() => states.at(-1)?.confirmationPending, { timeout: 10000 })
      .toBe(true);
    send({ op: "confirm", accept: true });
    await expect.poll(() => hub.nest.pairing.pending().length).toBe(1);
    hub.nest.pairing.confirm(hub.nest.pairing.pending()[0]!.id, true);
    await expect.poll(() => states.at(-1)?.phase).toBe("online");
    const device = states.at(-1).settings.slug;
    const slug = hub.nest.devicesStore.get(device)!.slug;
    return {
      root,
      dir,
      slug,
      device,
      send,
      kill: () => child.kill("SIGKILL"),
      restart: async () => {
        await launch();
        send({ op: "start", settings: states.at(-1).settings });
        await expect
          .poll(() => states.at(-1)?.phase, { timeout: 15000 })
          .toBe("online");
      },
    };
  }
  return {
    home,
    hub,
    api,
    host,
    errors,
    close: async () => {
      for (const child of children) {
        child.stdin.end();
        child.kill("SIGTERM");
      }
      await Promise.all(
        children.map((c) =>
          c.exitCode !== null || c.signalCode !== null
            ? Promise.resolve()
            : new Promise((r) => c.once("exit", r)),
        ),
      );
      await hub.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

for (const routing of ["relay", "auto"] as const)
  it.skipIf(process.env.SWIFTNEST_TRANSFER_E2E !== "1")(
    `200 MiB two Rust Perches: ${routing}, corrupt chunk, kill at half, restart, resume, one approval`,
    async () => {
      const f = await fixture();
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        const a = await f.host("computer"),
          b = await f.host("phone");
        const source = join(a.root, "video.bin"),
          target = join(b.root, "video.bin");
        const input = await open(source, "w");
        const block = Buffer.alloc(4 * 1024 * 1024, 0xa7);
        for (let i = 0; i < 50; i++) {
          block.writeUInt32BE(i, 0);
          await input.write(block);
        }
        await input.close();
        // Instrument the relay in this TEST ONLY: alter an authenticated chunk hash, then re-encrypt.
        const offers = new Map<string, FileStreamOptions>();
        const originalOpen = f.hub.nest.openFileStream.bind(f.hub.nest);
        f.hub.nest.openFileStream = async (device, file) => {
          const offer = await originalOpen(device, file);
          offers.set(offer.id, file);
          return offer;
        };
        const attach = f.hub.nest.streams.attachDevice.bind(f.hub.nest.streams);
        let corrupted = false,
          retransmitted = false,
          lastBadOffset = -1;
        f.hub.nest.streams.attachDevice = (id, ticket, peer) => {
          const file = offers.get(id);
          if (file?.sender && routing === "relay") {
            const decoder = new FileCipher(file, false),
              encoder = new FileCipher(file, true);
            const wrapped = {
              ...peer,
              onData(fn: (v: Uint8Array) => void) {
                peer.onData((raw) => {
                  const [flag, data] = decoder.open(raw);
                  let out = data;
                  if (flag === 4) {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === "chunk") {
                      if (!corrupted) {
                        lastBadOffset = msg.offset;
                        msg.hash = "0".repeat(64);
                        corrupted = true;
                        out = Buffer.from(JSON.stringify(msg));
                      } else if (msg.offset === lastBadOffset)
                        retransmitted = true;
                    }
                  }
                  fn(encoder.seal(flag, out));
                });
              },
            };
            return attach(id, ticket, wrapped);
          }
          return attach(id, ticket, peer);
        };
        const transfer = (await f.api("/transfers", {
          source: { device: a.slug, path: source },
          destination: { device: b.slug, path: target },
          routing,
        })) as Transfer;
        await expect
          .poll(
            async () =>
              ((await f.api("/transfers")) as Transfer[]).find(
                (r) => r.id === transfer.id,
              )?.state,
          )
          .toBe("approval");
        await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
        const approval = f.hub.nest.tasks
          .list({ state: "pending_approval" })
          .find((t) => t.tool === "receive")!;
        expect(approval.risk).toBe("write");
        expect((approval.args.binding as any).meta.size).toBe(
          200 * 1024 * 1024,
        );
        let killed = false,
          restarting: Promise<void> | undefined,
          half = 0;
        timer = setInterval(() => {
          void (async () => {
            if (killed) return;
            const j = JSON.parse(
              await readFile(
                join(b.dir, "transfers", transfer.id + ".json"),
                "utf8",
              ).catch(() => "{}"),
            );
            if (
              !killed &&
              j.offset >= 100 * 1024 * 1024 &&
              j.state !== "complete"
            ) {
              killed = true;
              half = j.offset;
              a.kill();
              b.kill();
              restarting = Promise.all([a.restart(), b.restart()]).then(
                () => {},
              );
            }
          })();
        }, 20);
        await f.hub.nest.tasks.approve(approval.id);
        await expect
          .poll(
            async () =>
              JSON.parse(
                await readFile(
                  join(b.dir, "transfers", transfer.id + ".json"),
                  "utf8",
                ),
              ).offset,
            { timeout: 20000 },
          )
          .toBeGreaterThan(0);
        await f.api(`/transfers/${transfer.id}/pause`, {});
        expect(
          ((await f.api("/transfers")) as Transfer[]).find(
            (r) => r.id === transfer.id,
          )?.state,
        ).toBe("paused");
        await f.api(`/transfers/${transfer.id}/resume`, {});
        await expect
          .poll(
            async () => {
              const r = ((await f.api("/transfers")) as Transfer[]).find(
                (r) => r.id === transfer.id,
              )!;
              if (r.state === "failed") throw new Error(r.error);
              return r.state;
            },
            { timeout: 180000, message: f.errors.join("\n") },
          )
          .toBe("complete");
        expect(killed).toBe(true);
        expect(half).toBeGreaterThanOrEqual(100 * 1024 * 1024);
        expect(half).toBeLessThan(200 * 1024 * 1024);
        await restarting;
        expect(await hash(target)).toBe(await hash(source));
        const final = ((await f.api("/transfers")) as Transfer[]).find(
          (r) => r.id === transfer.id,
        )!;
        expect(final.route).toBe(routing === "auto" ? "direct" : "relay");
        expect(final.hash).toBe(await hash(source));
        expect(
          f.hub.nest.tasks.list().filter((t) => t.tool === "receive"),
        ).toHaveLength(1);
        if (routing === "relay") {
          expect(corrupted).toBe(true);
          expect(retransmitted).toBe(true);
        }
        if (routing === "relay") {
          // Both server directions use the same binary mechanism; server writes also wait for approval.
          const upload = (await f.api("/transfers", {
            source: { device: b.slug, path: target },
            destination: { device: "server", path: "archive.bin" },
            routing: "relay",
          })) as Transfer;
          await expect
            .poll(() =>
              f.hub.nest.tasks
                .list({ state: "pending_approval" })
                .some((t) => t.device === "server-files"),
            )
            .toBe(true);
          await f.hub.nest.tasks.approve(
            f.hub.nest.tasks
              .list({ state: "pending_approval" })
              .find((t) => t.device === "server-files")!.id,
          );
          await expect
            .poll(
              async () =>
                ((await f.api("/transfers")) as Transfer[]).find(
                  (r) => r.id === upload.id,
                )?.state,
              { timeout: 120000 },
            )
            .toBe("complete");
          expect(await hash(join(f.home, "server/files/archive.bin"))).toBe(
            await hash(source),
          );
          const download = (await f.api("/transfers", {
            source: { device: "server", path: "archive.bin" },
            destination: { device: a.slug, path: join(a.root, "download.bin") },
            routing: "relay",
          })) as Transfer;
          await expect
            .poll(() =>
              f.hub.nest.tasks
                .list({ state: "pending_approval" })
                .some((t) => t.device === a.device),
            )
            .toBe(true);
          await f.hub.nest.tasks.approve(
            f.hub.nest.tasks
              .list({ state: "pending_approval" })
              .find((t) => t.device === a.device)!.id,
          );
          await expect
            .poll(
              async () =>
                ((await f.api("/transfers")) as Transfer[]).find(
                  (r) => r.id === download.id,
                )?.state,
              { timeout: 120000 },
            )
            .toBe("complete");
          expect(await hash(join(a.root, "download.bin"))).toBe(
            await hash(source),
          );
        }
      } finally {
        if (timer) clearInterval(timer);
        await f.close();
      }
    },
    420000,
  );

it.skipIf(process.env.SWIFTNEST_TRANSFER_E2E !== "1")(
  "auto routing fallback uses encrypted relay when the exchanged candidate is unreachable",
  async () => {
    const f = await fixture();
    try {
      const a = await f.host("computer"),
        b = await f.host("phone");
      await writeFile(join(a.root, "small.bin"), Buffer.alloc(65536, 0x3d));
      const open = f.hub.nest.openFileStream.bind(f.hub.nest);
      f.hub.nest.openFileStream = async (device, file) => {
        const offer = await open(device, file);
        if (file.sender) offer.candidates = ["ws://127.0.0.1:9/file"];
        return offer;
      };
      const r = (await f.api("/transfers", {
        source: { device: a.slug, path: join(a.root, "small.bin") },
        destination: { device: b.slug, path: join(b.root, "small.bin") },
      })) as Transfer;
      await expect
        .poll(() => f.hub.nest.tasks.list({ state: "pending_approval" }).length)
        .toBe(1);
      await f.hub.nest.tasks.approve(
        f.hub.nest.tasks.list({ state: "pending_approval" })[0]!.id,
      );
      await expect
        .poll(
          async () =>
            ((await f.api("/transfers")) as Transfer[]).find(
              (t) => t.id === r.id,
            )?.state,
          { timeout: 20000 },
        )
        .toBe("complete");
      expect(
        ((await f.api("/transfers")) as Transfer[]).find((t) => t.id === r.id)
          ?.route,
      ).toBe("relay");
      expect(await hash(join(b.root, "small.bin"))).toBe(
        await hash(join(a.root, "small.bin")),
      );
    } finally {
      await f.close();
    }
  },
  40000,
);
