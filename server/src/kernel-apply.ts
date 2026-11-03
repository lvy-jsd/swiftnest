/**
 * Applying owner changes (plugins, models) by restarting the DSH kernel. One instance is
 * shared by every settings page, so only one restart runs at a time. If the kernel cannot
 * start with the change, the change's own rollback restores what last booted and the
 * kernel restarts again, so a novice is never left without a running server.
 */
import type { ApplyState } from '@swiftnest/api';
import { text, type MessageKey } from '@swiftnest/core';
import type { Log } from './command.js';
import { localizedError, message, ServerFailure } from './i18n.js';
import type { Language } from './preferences.js';

/**
 * The App's apply request travels through the kernel's own proxy. Wait this long before
 * stopping the kernel, so the answer reaches the App first.
 */
export const RESTART_GRACE_MS = 300;

export interface KernelApplyDeps {
  /** Restart the DSH kernel with the current settings. */
  restart(): Promise<void>;
  /** The kernel could not start even after the rollback. */
  fail(error: unknown): void;
  log: Log;
  lang: Language;
}

/** One kind of change: how to prepare it, undo it and report it. */
export interface KernelChange {
  /** Work before the restart, such as installing plugins. */
  prepare?(): Promise<void>;
  /** Restore the settings the kernel last booted with. */
  rollback(): Promise<void>;
  /** Tell the page its view changed. */
  changed(): void;
  messages: { applied: MessageKey; rolledBack: MessageKey; busy: MessageKey };
}

export interface ApplyView {
  state: ApplyState;
  rolledBack?: true;
  error?: ReturnType<typeof localizedError>;
}

export class KernelApply {
  private state: ApplyState = 'idle';
  private failure?: unknown;
  private rolledBack = false;
  /** The change the state belongs to; other pages see a running apply only as busy. */
  private owner?: KernelChange;

  constructor(private readonly deps: KernelApplyDeps) {}

  get busy(): boolean {
    return this.state === 'installing' || this.state === 'restarting';
  }

  /** What `change`'s page shows: its own last apply, or idle. */
  view(change: KernelChange, lang: Language): ApplyView {
    if (this.owner !== change) return { state: 'idle' };
    return {
      state: this.state,
      ...(this.rolledBack ? { rolledBack: true } : {}),
      ...(this.failure === undefined ? {} : { error: localizedError(this.failure, lang) }),
    };
  }

  /** Prepare and restart in the background; follow progress with `view`. */
  start(change: KernelChange): void {
    if (this.busy) throw new ServerFailure(text(change.messages.busy));
    this.owner?.changed();
    this.owner = change;
    this.failure = undefined;
    this.rolledBack = false;
    this.setState('installing');
    void this.run(change);
  }

  private async run(change: KernelChange): Promise<void> {
    try {
      await change.prepare?.();
      this.setState('restarting');
      await new Promise((resolve) => setTimeout(resolve, RESTART_GRACE_MS));
      await this.deps.restart();
      this.deps.log(message(change.messages.applied, this.deps.lang));
      this.setState('idle');
    } catch (error) {
      this.failure = error;
      if (this.state === 'restarting') await this.rollback(change);
      this.setState('failed');
    }
  }

  private async rollback(change: KernelChange): Promise<void> {
    this.rolledBack = true;
    this.deps.log(message(change.messages.rolledBack, this.deps.lang));
    try {
      await change.rollback();
      await this.deps.restart();
    } catch (error) {
      this.deps.fail(error);
    }
  }

  private setState(state: ApplyState): void {
    this.state = state;
    this.owner?.changed();
  }
}
