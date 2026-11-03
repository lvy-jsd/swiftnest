/**
 * A Perch on the other end of a secure channel. Link plugins only move frames; everything here is shared by all links:
 *   Nest side  acceptPerch(): checks the device is paired (or runs pairing), then attaches it as a PerchConnection;
 *   Perch side connectToNest(): pairs if asked, says hello, then executes the Nest's calls on this device.
 * Every message is validated against the protocol schema; anything unexpected ends the session.
 */
import {
  LinkMessage,
  PROTOCOL_VERSION,
  type CapabilityManifest,
  type InvokeResult,
  isText,
  text,
} from '@swiftnest/protocol';
import type { z } from 'zod';
import { acceptChannel, initiateChannel, type FrameTransport, type SecureChannel } from './channel.js';
import { SwiftnestFailure } from './errors.js';
import { fingerprintOf, type Identity } from './identity.js';
import type { PerchConnection } from './link.js';
import { createLogger, type Logger } from './log.js';
import type { Nest } from './nest.js';
import { pairingProof, type DeviceStore, type PairingManager } from './pairing.js';
import type { Perch } from './perch.js';
import { classification, type Classification } from './policy.js';

type Msg = z.infer<typeof LinkMessage>;
type Result = z.infer<typeof InvokeResult>;

/** Ordered reader over a channel: setup steps `expect()` one message; afterwards everything goes to `handle()`. */
function mailbox(channel: SecureChannel) {
  const queue: Msg[] = [];
  let waiter: ((m: Msg) => void) | undefined;
  let handler: ((m: Msg) => void) | undefined;
  let closedWith: string | undefined;
  const closers = new Set<(reason: string) => void>();
  channel.onMessage((raw) => {
    const parsed = LinkMessage.safeParse(raw);
    if (!parsed.success) {
      channel.close('protocol error');
      return;
    }
    if (handler) handler(parsed.data);
    else if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(parsed.data);
    } else queue.push(parsed.data);
  });
  channel.onClose((reason) => {
    closedWith = reason ?? 'disconnected';
    for (const fn of closers) fn(closedWith);
  });
  return {
    expect<T extends Msg['type']>(types: T[], timeoutMs: number, what: string): Promise<Extract<Msg, { type: T }>> {
      return new Promise((resolve, reject) => {
        const settle = (m: Msg) => {
          clearTimeout(timer);
          closers.delete(onClose);
          if (m.type === 'bye') return reject(new SwiftnestFailure(m.code, m.message));
          if (!(types as string[]).includes(m.type)) {
            channel.close('protocol error');
            return reject(
              new SwiftnestFailure('PROTOCOL_ERROR', text('expectedDuringGot', types.join(' or '), what, m.type)),
            );
          }
          resolve(m as Extract<Msg, { type: T }>);
        };
        const onClose = (reason: string) => {
          clearTimeout(timer);
          reject(new SwiftnestFailure('CHANNEL_CLOSED', text('connectionClosedDuring', what, reason), undefined, true));
        };
        const timer = setTimeout(() => {
          closers.delete(onClose);
          waiter = undefined;
          reject(new SwiftnestFailure('TIMEOUT', text('noAnswerDuring', what), undefined, true));
        }, timeoutMs);
        if (queue.length) return settle(queue.shift()!);
        if (closedWith !== undefined) return onClose(closedWith);
        closers.add(onClose);
        waiter = settle;
      });
    },
    handle(fn: (m: Msg) => void) {
      handler = fn;
      for (const m of queue.splice(0)) fn(m);
    },
    onClose(fn: (reason: string) => void) {
      if (closedWith !== undefined) fn(closedWith);
      else closers.add(fn);
    },
  };
}

function bye(channel: SecureChannel, code: string, message: string) {
  try {
    channel.send({ type: 'bye', code, message });
  } catch {
    /* already closed */
  }
  channel.close(code);
}

// ---------------------------------------------------------------- Nest side

export interface AcceptPerchOptions {
  /** Defaults to the Nest's own identity, paired-device list and pairing manager. */
  identity?: Identity;
  devices?: DeviceStore;
  /** `false` refuses pairing over this link altogether. */
  pairing?: PairingManager | false;
  /** Link name shown in the panel: "lan", "relay"… */
  via: string;
  logger?: Logger;
  timeoutMs?: number;
  /** How long a pairing waits for both people to compare fingerprints. */
  confirmTimeoutMs?: number;
}

/** Run one incoming connection to completion of setup; resolves with the attached connection. */
export async function acceptPerch(nest: Nest, t: FrameTransport, opts: AcceptPerchOptions): Promise<PerchConnection> {
  const o = {
    ...opts,
    identity: opts.identity ?? nest.identity,
    devices: opts.devices ?? nest.devicesStore,
    pairing: opts.pairing === false ? undefined : (opts.pairing ?? nest.pairing),
  };
  const timeoutMs = o.timeoutMs ?? 10_000;
  const logger = o.logger ?? createLogger('link');
  const { channel, hello } = await acceptChannel(t, {
    identity: o.identity,
    timeoutMs,
    screen(h) {
      if (h.pairing && !o.pairing?.active)
        throw new SwiftnestFailure('PAIRING_CLOSED', text('nestNotPairingRightNow'), text('hintRunPairOnNestFirst'));
      if (!h.pairing && o.devices.get(h.device)?.publicKey !== h.id)
        throw new SwiftnestFailure('NOT_PAIRED', text('notPairedNest', h.device), text('hintPairDeviceFirst'));
    },
  });
  const box = mailbox(channel);
  const device = hello.device;
  const key = channel.peerPublicKey;

  if (hello.pairing) {
    const pairing = o.pairing!;
    const req = await box.expect(['pair'], timeoutMs, 'pairing');
    if (!pairing.verify(req.proof, channel.transcriptHash)) {
      channel.send({ type: 'pair_status', status: 'rejected', message: 'Wrong or expired pairing code.' });
      bye(channel, 'PAIRING_REJECTED', 'Wrong or expired pairing code.');
      throw new SwiftnestFailure('PAIRING_REJECTED', text('pairingAttemptUsedWrongExpiredCode', device));
    }
    const taken = o.devices.get(device);
    if (taken && taken.publicKey !== key) {
      const message = `The name "${device}" is already used by another paired device.`;
      channel.send({ type: 'pair_status', status: 'rejected', message });
      bye(channel, 'DEVICE_NAME_TAKEN', message);
      throw new SwiftnestFailure('DEVICE_NAME_TAKEN', message, text('hintPickAnotherName'));
    }
    channel.send({ type: 'pair_status', status: 'code_ok' });
    const { candidate, answer } = pairing.offer(device, key, o.confirmTimeoutMs);
    box.onClose(() => pairing.withdraw(candidate.id));
    const remote = box.expect(['pair_confirm'], o.confirmTimeoutMs ?? 5 * 60_000, 'fingerprint confirmation').then(
      (m) => m.accept,
      () => false,
    );
    // Both must say yes; the first no ends it at once (no waiting for the other person).
    const { owner, there } = await new Promise<{ owner: boolean; there: boolean }>((resolve) => {
      let ownerSays: boolean | undefined;
      let deviceSays: boolean | undefined;
      const settle = () => {
        if (ownerSays === false || deviceSays === false)
          resolve({ owner: ownerSays !== false, there: deviceSays !== false });
        else if (ownerSays && deviceSays) resolve({ owner: true, there: true });
      };
      void answer.then((v) => {
        ownerSays = v;
        settle();
      });
      void remote.then((v) => {
        deviceSays = v;
        settle();
      });
    });
    if (!there) pairing.withdraw(candidate.id);
    if (!owner || !there) {
      const message = !owner
        ? 'The Nest owner did not confirm the fingerprint.'
        : 'The device did not confirm the Nest fingerprint.';
      channel.send({ type: 'pair_status', status: 'rejected', message });
      bye(channel, 'PAIRING_REJECTED', message);
      throw new SwiftnestFailure('PAIRING_REJECTED', text('pairingNotConfirmed', device, message));
    }
    await o.devices.add({ device, publicKey: key, pairedAt: new Date().toISOString() });
    channel.send({ type: 'pair_status', status: 'paired' });
    logger.info(text('pairLog', device, fingerprintOf(key)));
  }

  const h = await box.expect(['hello'], timeoutMs, 'hello');
  if (h.device !== device || h.publicKey !== key || h.protocol !== PROTOCOL_VERSION) {
    bye(channel, 'PROTOCOL_ERROR', 'The hello does not match the handshake or the protocol version.');
    throw new SwiftnestFailure('PROTOCOL_ERROR', text('deviceSentHelloNotMatchHandshake', device));
  }

  const record = o.devices.get(device);
  if (record && ((h.kind && record.kind !== h.kind) || (h.name && record.name !== h.name))) {
    await o.devices.add({ ...record, kind: h.kind ?? record.kind, name: h.name ?? record.name });
  }
  const conn = remoteConnection(channel, box, {
    device,
    publicKey: key,
    via: o.via,
    capabilities: h.capabilities,
    extensions: h.extensions,
    nest,
    logger,
  });
  try {
    nest.attach(conn);
  } catch (e) {
    const err = SwiftnestFailure.from(e, 'ATTACH_FAILED');
    bye(channel, err.code, err.message);
    throw e;
  }
  channel.send({ type: 'welcome' });
  return conn;
}

function remoteConnection(
  channel: SecureChannel,
  box: ReturnType<typeof mailbox>,
  o: {
    device: string;
    publicKey: string;
    via: string;
    capabilities: CapabilityManifest[];
    extensions?: string[];
    nest: Nest;
    logger: Logger;
  },
): PerchConnection {
  let caps = o.capabilities;
  let seq = 0;
  let closed = false;
  const results = new Map<string, (r: Result) => void>();
  const classifications = new Map<string, (r: Classification | Error) => void>();
  const capListeners = new Set<() => void>();
  const closeListeners = new Set<() => void>();

  box.handle((m) => {
    switch (m.type) {
      case 'stream_accept':
        o.nest.streams.accept(m.id, channel, m.candidates);
        return;
      case 'stream_close':
        o.nest.streams.close(m.id, channel, m.reason);
        return;
      case 'result':
        results.get(m.taskId)?.(m);
        results.delete(m.taskId);
        return;
      case 'classified': {
        const reasonText = isText(m.reasonText) ? m.reasonText : undefined;
        classifications.get(m.requestId)?.({ risk: m.risk, reason: m.reason, reasonText });
        classifications.delete(m.requestId);
        return;
      }
      case 'capabilities':
        caps = m.capabilities;
        for (const fn of capListeners) fn();
        return;
      case 'bye':
        o.logger.info(text('disconnectedLog', o.device, m.message));
        channel.close(m.code);
        return;
      default:
        o.logger.warn(text('unexpectedMessageClosingLog', o.device, m.type));
        channel.close('protocol error');
    }
  });
  box.onClose(() => {
    closed = true;
    o.nest.streams.closeParent(channel);
    const offline = new SwiftnestFailure(
      'DEVICE_OFFLINE',
      text('wentOffline', o.device),
      text('hintCheckDeviceOnNetwork'),
      true,
    ).toJSON();
    for (const [taskId, done] of results) done({ type: 'result', taskId, ok: false, error: offline });
    results.clear();
    for (const done of classifications.values())
      done(new SwiftnestFailure('DEVICE_OFFLINE', text('wentOffline', o.device), undefined, true));
    classifications.clear();
    for (const fn of closeListeners) fn();
  });

  const send = (m: Msg) => {
    if (closed) throw new SwiftnestFailure('DEVICE_OFFLINE', text('offline', o.device), undefined, true);
    channel.send(m);
  };

  return {
    device: o.device,
    publicKey: o.publicKey,
    via: o.via,
    capabilities: () => caps,
    ...(o.extensions?.includes('streams-v1')
      ? {
          openOwnerStream: (options: { maxDimension: number; displayId: string }) =>
            o.nest.streams.open(channel, options),
          openFileStream: (options: import('./streams.js').FileStreamOptions) =>
            o.nest.streams.open(channel, { maxDimension: 320, displayId: '' }, options),
        }
      : {}),
    classify(capability, tool, args) {
      const requestId = `c${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          classifications.delete(requestId);
          reject(new SwiftnestFailure('TIMEOUT', text('didNotClassifyCallTime', o.device), undefined, true));
        }, 10_000);
        classifications.set(requestId, (r) => {
          clearTimeout(timer);
          r instanceof Error ? reject(r) : resolve(r);
        });
        try {
          send({ type: 'classify', requestId, capability, tool, args });
        } catch (e) {
          clearTimeout(timer);
          classifications.delete(requestId);
          reject(e);
        }
      });
    },
    invoke(req) {
      return new Promise((resolve) => {
        results.set(req.taskId, resolve);
        try {
          send({ type: 'invoke', ...req });
        } catch (e) {
          results.delete(req.taskId);
          resolve({ type: 'result', taskId: req.taskId, ok: false, error: SwiftnestFailure.from(e, 'DEVICE_OFFLINE') });
        }
      });
    },
    cancel(taskId) {
      if (!closed) channel.send({ type: 'cancel', taskId });
    },
    onCapabilitiesChanged(fn) {
      capListeners.add(fn);
      return () => capListeners.delete(fn);
    },
    onClose(fn) {
      if (closed) fn();
      else closeListeners.add(fn);
      return () => closeListeners.delete(fn);
    },
    close(code = 'NEST_CLOSED', message = 'The Nest closed the connection.') {
      if (!closed) bye(channel, code, message);
    },
  };
}

// ---------------------------------------------------------------- Perch side

export interface ConnectOptions {
  identity: Identity;
  /** The pinned Nest key from pairing. Required unless `pairing` is given. */
  nestKey?: string;
  pairing?: {
    code: string;
    /** Show the Nest fingerprint to the person at this device; resolve true if it matches what the Nest shows. */
    confirm(nestFingerprint: string): Promise<boolean>;
  };
  /** Called once pairing completes, with the Nest key to pin (store it before the session goes on). */
  onPaired?(nestKey: string): void | Promise<void>;
  timeoutMs?: number;
  confirmTimeoutMs?: number;
}

export interface NestSession {
  readonly nestKey: string;
  /** Resolves when the session ends: `code` is the Nest's reason (e.g. REVOKED) or "DISCONNECTED". */
  readonly closed: Promise<{ code: string; message: string }>;
  close(): void;
}

export async function connectToNest(perch: Perch, t: FrameTransport, o: ConnectOptions): Promise<NestSession> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  if (!o.pairing && !o.nestKey)
    throw new SwiftnestFailure('NOT_PAIRED', text('deviceNotPairedNestYet'), text('hintStartWithPairCode'));
  const channel = await initiateChannel(t, {
    identity: o.identity,
    device: perch.device,
    pairing: Boolean(o.pairing),
    expectedPeer: o.nestKey,
    timeoutMs,
  });
  const box = mailbox(channel);
  let lastBye: { code: string; message: string } | undefined;

  if (o.pairing) {
    channel.send({ type: 'pair', proof: pairingProof(o.pairing.code, channel.transcriptHash) });
    const status = await box.expect(['pair_status'], timeoutMs, 'pairing');
    if (status.status !== 'code_ok')
      throw new SwiftnestFailure(
        'PAIRING_REJECTED',
        status.message ?? 'The Nest refused the pairing code.',
        text('hintCheckPairingCode'),
      );
    const accept = await o.pairing.confirm(fingerprintOf(channel.peerPublicKey));
    channel.send({ type: 'pair_confirm', accept });
    const done = await box.expect(['pair_status'], o.confirmTimeoutMs ?? 5 * 60_000, 'fingerprint confirmation');
    if (done.status !== 'paired')
      throw new SwiftnestFailure('PAIRING_REJECTED', done.message ?? 'Pairing was not confirmed.');
    await o.onPaired?.(channel.peerPublicKey);
  }

  channel.send(perch.hello());
  await box.expect(['welcome'], timeoutMs, 'hello');

  const offCaps = perch.onCapabilitiesChanged(() => {
    try {
      channel.send({ type: 'capabilities', capabilities: perch.capabilities() });
    } catch {
      /* closed */
    }
  });
  box.handle((m) => {
    switch (m.type) {
      case 'invoke':
        void perch.invoke(m).then((r) => {
          try {
            channel.send(r);
          } catch {
            /* the Nest went away; it already failed the task */
          }
        });
        return;
      case 'cancel':
        perch.cancel(m.taskId);
        return;
      case 'classify': {
        let r: Classification;
        try {
          r = perch.classify(m.capability, m.tool, m.args);
        } catch (e) {
          // Unknown tool or a broken classifier: never report it as harmless.
          const failure = SwiftnestFailure.from(e, 'CLASSIFY_FAILED');
          r = classification(
            'sensitive',
            text('couldNotClassify', isText(failure.text) ? failure.text : failure.message),
          );
        }
        channel.send({ type: 'classified', requestId: m.requestId, ...r });
        return;
      }
      case 'bye':
        lastBye = { code: m.code, message: m.message };
        channel.close(m.code);
        return;
      default:
        channel.close('protocol error');
    }
  });

  const closed = new Promise<{ code: string; message: string }>((resolve) => {
    box.onClose((reason) => {
      offCaps();
      resolve(lastBye ?? { code: 'DISCONNECTED', message: reason });
    });
  });

  return {
    nestKey: channel.peerPublicKey,
    closed,
    close() {
      lastBye = { code: 'DEVICE_DISCONNECTED', message: 'Disconnected on this device.' };
      bye(channel, 'DEVICE_DISCONNECTED', 'Disconnected on the device.');
    },
  };
}
