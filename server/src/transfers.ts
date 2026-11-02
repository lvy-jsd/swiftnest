import { localizedError, ServerFailure } from './i18n.js';
/** Durable, nonblocking transfer coordinator. Approval grants one immutable identity/path/metadata binding. */
import { randomBytes } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  Nest,
  Perch,
  memoryLink,
  type BinaryPeer,
  type FileBinding,
  type FileStreamOptions,
  type StreamOffer,
} from "@swiftnest/core";
import type { Transfer, TransferRequest } from "@swiftnest/api";
import {
  atomicJson,
  FileStorage,
  FileCipher,
  fileInbox,
  storageEndpoint,
  transferId,
  type Journal,
} from "./file-storage.js";

interface Saved extends Transfer {
  binding: FileBinding;
  approved?: boolean;
}
const SERVER = "server-files";
export class Transfers {
  private records = new Map<string, Saved>();
  private jobs = new Map<
    string,
    { stop: AbortController; streams: string[]; done: Promise<void> }
  >();
  private writes = Promise.resolve();
  private closed = false;
  private constructor(
    readonly nest: Nest,
    readonly storage: FileStorage,
    private path: string,
    private publish: () => void,
  ) {}
  static async open(
    nest: Nest,
    home: string,
    quota: number,
    publish: () => void,
  ) {
    await mkdir(join(home, "files"), { recursive: true, mode: 0o700 });
    const storage = new FileStorage(
      join(home, "files"),
      join(home, "devices", "file-receipts"),
      nest.identity.publicKey,
      quota,
    );
    const self = new Transfers(
      nest,
      storage,
      join(home, "devices", "transfers.json"),
      publish,
    );
    try {
      for (const saved of JSON.parse(
        await readFile(self.path, "utf8"),
      ) as Saved[]) {
        if (
          !["complete", "cancelled", "paused", "failed"].includes(saved.state)
        )
          saved.state = "waiting";
        self.records.set(saved.id, saved);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const perch = new Perch({
      device: SERVER,
      identity: nest.identity,
      logger: nest.logger,
    });
    perch.addCapability(storage.capability());
    nest.attach({ ...memoryLink(perch), internal: true });
    for (const r of self.records.values())
      if (r.state === "waiting") self.launch(r);
    return self;
  }
  list(): Transfer[] {
    return [...this.records.values()].map(
      ({ binding: _binding, approved: _approved, ...r }) => structuredClone(r),
    );
  }
  private async save() {
    const snapshot = [...this.records.values()].map((r) => structuredClone(r));
    this.writes = this.writes.then(() => atomicJson(this.path, snapshot));
    await this.writes;
    this.publish();
  }
  private resolve(ref: TransferRequest["source"]) {
    if (ref.device === "server")
      return { device: SERVER, identity: this.nest.identity.publicKey };
    const d = this.nest.devicesStore.list().find((d) => d.slug === ref.device);
    if (!d) throw new ServerFailure(`Unknown paired device ${ref.device}`);
    return { device: d.device, identity: d.publicKey };
  }
  private async call(
    device: string,
    tool: string,
    args: Record<string, unknown>,
    r?: Saved,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const task = await this.nest.call(`${device}__transfer__${tool}`, args, {
      id: "file-transfer",
      name: "File transfer",
    });
    if (r && tool === "receive") {
      r.approvalId = task.id;
      r.state = task.state === "pending_approval" ? "approval" : "preparing";
      await this.save();
    }
    let result = task;
    try {
      while (["pending_approval", "queued", "running"].includes(result.state)) {
        signal?.throwIfAborted();
        result = await this.nest.tasks.wait(task.id, 1000);
      }
      if (result.state !== "succeeded")
        throw new ServerFailure(result.error?.message ?? result.state, result.error?.code, result.error?.hint ?? result.error?.suggestion);
      return result.result!.data;
    } finally {
      if (signal?.aborted) await this.nest.tasks.cancel(task.id);
    }
  }
  async start(request: TransferRequest): Promise<Transfer> {
    if (this.closed) throw new ServerFailure("Transfers stopped");
    for (const ref of [request.source, request.destination])
      if (
        !ref ||
        typeof ref.device !== "string" ||
        typeof ref.path !== "string" ||
        !ref.path ||
        ref.path.length > 4096
      )
        throw new ServerFailure("Expected source and destination device/path");
    if (
      request.source.device === "server" &&
      request.destination.device === "server"
    )
      throw new ServerFailure("Choose a device endpoint");
    if (!["auto", "relay"].includes(request.routing ?? "auto"))
      throw new ServerFailure("Invalid routing");
    const source = this.resolve(request.source),
      destination = this.resolve(request.destination);
    const meta = (await this.call(source.device, "inspect", {
      path: request.source.path,
    })) as FileBinding["meta"];
    const binding: FileBinding = {
      source: source.identity,
      destination: destination.identity,
      sourcePath: request.source.path,
      destinationPath: request.destination.path,
      meta,
    };
    const id = transferId(binding);
    const existing = this.records.get(id);
    if (existing) return this.list().find((r) => r.id === id)!;
    if (
      [...this.records.values()].filter(
        (r) => !["complete", "cancelled", "failed"].includes(r.state),
      ).length >= 32
    )
      throw new ServerFailure("Too many transfers");
    const r: Saved = {
      id,
      source: request.source,
      destination: request.destination,
      name: request.source.path.split(/[\\/]/).at(-1)!,
      size: meta.size,
      offset: 0,
      state: "preparing",
      speed: 0,
      eta: null,
      routing: request.routing ?? "auto",
      route: "relay",
      updatedAt: Date.now(),
      binding,
    };
    this.records.set(id, r);
    await this.save();
    this.launch(r);
    return this.list().find((t) => t.id === id)!;
  }
  async action(
    id: string,
    action: "pause" | "resume" | "cancel" | "retry",
  ): Promise<Transfer> {
    const r = this.records.get(id);
    if (!r) throw new ServerFailure("Unknown transfer");
    if (r.state === "complete") return this.list().find((t) => t.id === id)!;
    if (action === "pause" || action === "cancel") {
      r.state = action === "pause" ? "paused" : "cancelled";
      const job = this.jobs.get(id);
      job?.stop.abort();
      for (const stream of job?.streams ?? [])
        this.nest.streams.closeId(stream);
      await job?.done;
      r.state = action === "pause" ? "paused" : "cancelled";
      r.speed = 0;
      r.eta = null;
      await this.save();
    } else {
      if (r.state === "cancelled")
        throw new ServerFailure("Cancelled transfer cannot resume");
      r.state = "waiting";
      r.error = undefined;
      r.failure = undefined;
      await this.save();
      this.launch(r);
    }
    return this.list().find((t) => t.id === id)!;
  }
  private launch(r: Saved) {
    if (this.jobs.has(r.id) || this.closed) return;
    const stop = new AbortController();
    const job = { stop, streams: [] as string[], done: Promise.resolve() };
    this.jobs.set(r.id, job);
    job.done = this.run(r, job)
      .catch(async (e) => {
        if (!stop.signal.aborted) {
          r.state = "failed";
          r.error = e instanceof Error ? e.message : String(e);
          r.failure = localizedError(e, "en");
          r.speed = 0;
          r.eta = null;
          await this.save();
        }
      })
      .finally(() => {
        for (const id of job.streams) this.nest.streams.closeId(id);
        this.jobs.delete(r.id);
      });
  }
  private async run(
    r: Saved,
    job: { stop: AbortController; streams: string[] },
  ) {
    const signal = job.stop.signal;
    while (!this.closed && !signal.aborted) {
      const source = this.resolve(r.source),
        destination = this.resolve(r.destination);
      if (
        source.identity !== r.binding.source ||
        destination.identity !== r.binding.destination
      )
        throw new ServerFailure("Paired identity changed; start a new transfer");
      if (
        [source.device, destination.device].some(
          (d) =>
            d !== SERVER && !this.nest.devices().some((l) => l.device === d),
        )
      ) {
        r.state = "waiting";
        r.speed = 0;
        await this.save();
        await delay(1500, undefined, { signal });
        continue;
      }
      const currentMeta = await this.call(
        source.device,
        "inspect",
        { path: r.source.path },
        undefined,
        signal,
      );
      if (JSON.stringify(currentMeta) !== JSON.stringify(r.binding.meta))
        throw new ServerFailure("Source changed; start a new transfer");
      if (!r.approved) {
        const receipt = (await this.nest
          .readTransferStatus(destination.device, r.id)
          .catch(() => undefined)) as Journal | undefined;
        if (!receipt || transferId(receipt.binding) !== r.id)
          await this.call(
            destination.device,
            "receive",
            {
              binding: r.binding,
              display: {
                name: r.name,
                size: r.size,
                source: r.source,
                destination: r.destination,
              },
            },
            r,
            signal,
          );
        r.approved = true;
        await this.save();
      }
      const key = randomBytes(32).toString("base64url"),
        cipherId = randomBytes(16).toString("hex"),
        directTicket = randomBytes(24).toString("base64url");
      const file: FileStreamOptions = {
        binding: r.binding,
        sender: true,
        key,
        cipherId,
        candidates: [],
        directTicket,
        listen:
          r.routing !== "relay" &&
          source.device !== SERVER &&
          destination.device !== SERVER,
      };
      let inbox: ReturnType<typeof fileInbox> | undefined;
      let endpoint: Promise<void> | undefined;
      let endpointError: unknown;
      const attempt = new AbortController();
      const abort = () => attempt.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      let lastTime = Date.now(),
        lastOffset = r.offset,
        lastProgress = Date.now();
      const progress = (j: Journal) => {
        const now = Date.now();
        if (j.offset !== lastOffset || j.state === "complete")
          lastProgress = now;
        r.speed =
          j.offset >= lastOffset
            ? (j.offset - lastOffset) / Math.max(0.001, (now - lastTime) / 1000)
            : 0;
        r.eta = r.speed > 0 ? (r.size - j.offset) / r.speed : null;
        r.offset = j.offset;
        r.route = j.route as Transfer["route"];
        r.state = j.state === "complete" ? "complete" : "running";
        r.hash = j.hash ?? undefined;
        r.updatedAt = now;
        lastTime = now;
        lastOffset = j.offset;
      };
      try {
        let a: StreamOffer | undefined, b: StreamOffer | undefined;
        if (source.device !== SERVER) {
          a = await this.nest.openFileStream(source.device, file);
          job.streams.push(a.id);
        }
        const receiver = {
          ...file,
          sender: false,
          listen: false,
          candidates: a?.candidates ?? [],
        };
        if (destination.device !== SERVER) {
          b = await this.nest.openFileStream(destination.device, receiver);
          job.streams.push(b.id);
        }
        if (signal.aborted) throw signal.reason;
        if (a && b) {
          let sendA: ((v: Uint8Array) => void) | undefined,
            sendB: ((v: Uint8Array) => void) | undefined;
          let endA: (() => void) | undefined, endB: (() => void) | undefined;
          let ended = false;
          const close = () => {
            if (ended) return;
            ended = true;
            endA?.();
            endB?.();
          };
          const pa: BinaryPeer = {
            bufferedAmount: 0,
            send: (v) => sendB?.(v),
            onData: (f) => {
              sendA = f;
            },
            onEnd: (f) => {
              endA = f;
            },
            close,
          };
          const pb: BinaryPeer = {
            bufferedAmount: 0,
            send: (v) => sendA?.(v),
            onData: (f) => {
              sendB = f;
            },
            onEnd: (f) => {
              endB = f;
            },
            close,
          };
          this.nest.streams.attachOwner(a.id, pa);
          this.nest.streams.attachOwner(b.id, pb);
        } else {
          const serverFile = source.device === SERVER ? file : receiver;
          inbox = fileInbox(
            new FileCipher(serverFile, serverFile.sender),
            attempt.signal,
          );
          this.nest.streams.attachOwner((a ?? b)!.id, inbox.peer);
          endpoint = storageEndpoint(this.storage, serverFile, inbox, progress);
          void endpoint.catch((e) => {
            endpointError = e;
          });
        }
        r.state = "running";
        r.error = undefined;
        r.failure = undefined;
        await this.save();
        while (!signal.aborted) {
          if (endpointError) throw endpointError;
          const j =
            destination.device === SERVER
              ? await this.storage.load(r.id)
              : ((await this.nest.readTransferStatus(
                  destination.device,
                  r.id,
                )) as Journal);
          progress(j);
          await this.save();
          if (j.state === "complete") {
            r.speed = 0;
            r.eta = 0;
            await this.save();
            break;
          }
          // Detect dead relay attempts quickly; direct attempts report progress through their durable receiver journal.
          if (job.streams.some((id) => !this.nest.streams.has(id)))
            throw new ServerFailure("Link dropped");
          if (Date.now() - lastProgress > 1800000)
            throw new ServerFailure("Transfer stalled");
          await delay(1000, undefined, { signal });
        }
        if (this.records.get(r.id)?.state === "complete") return;
      } catch (e) {
        if (signal.aborted) throw e;
        if (
          /Source changed|identity|denied|Not approved|quota|protected|outside|exists/i.test(
            String(e),
          )
        )
          throw e;
        r.state = "waiting";
        r.error = e instanceof Error ? e.message : String(e);
        r.failure = localizedError(e, "en");
        r.speed = 0;
        r.eta = null;
        await this.save();
      } finally {
        attempt.abort();
        inbox?.close();
        for (const id of job.streams) this.nest.streams.closeId(id);
        job.streams.length = 0;
        await endpoint?.catch(() => {});
        signal.removeEventListener("abort", abort);
      }
      await delay(1500, undefined, { signal });
    }
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) {
      job.stop.abort();
      for (const id of job.streams) this.nest.streams.closeId(id);
    }
    await Promise.all([...this.jobs.values()].map((j) => j.done));
    await this.writes;
  }
}
