import { autoStateSchema, memoryOperations, type MemoryOperation } from './auto-schema.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { message, text } from '@swiftnest/protocol';
import { ServerFailure } from './failure.js';
import { entryLine, indexDocument, parseMemory, type MemoryEntry } from './format.js';
import { characters, memoryRules } from './rules.js';
import {
  applyPending,
  cleanMemoryTemps,
  memoryFiles,
  removeMemoryFile,
  atomicMemoryFile,
  memoryPath,
  readMemoryFile,
  readPending,
  repairJournal,
  validTopic,
  type PendingMemory,
} from './disk.js';

import type { MemoryView } from '@swiftnest/protocol';
export type { MemoryView } from '@swiftnest/protocol';

export function validateEntry(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new ServerFailure(text('memoryInvalidEntry'));
  const cleaned = value.trim();
  if (characters(cleaned) > memoryRules.entry) throw new ServerFailure(text('memoryEntryLimit', memoryRules.entry));
  rejectSecrets(cleaned);
  return cleaned;
}

function rejectSecrets(content: string): void {
  if (memoryRules.secrets.some((pattern) => pattern.test(content))) throw new ServerFailure(text('memorySecret'));
}

/** All public async operations serialize in one process. Each disk transaction is synchronous:
 * the synchronous DSH prompt provider can recover/read without observing a half-written change. */
export class MemoryStore {
  readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();
  private notification = Promise.resolve();
  constructor(
    home: string,
    private step?: (name: string) => void,
    private changed?: () => Promise<void> | void,
  ) {
    this.root = join(home, 'memory');
    memoryPath(this.root, 'MEMORY.md');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.recover();
    this.pruneSnapshots();
  }
  private run<T>(action: () => T): Promise<T> {
    const result = this.queue.then(async () => {
      this.recover();
      const value = action();
      await this.flushNotification();
      return value;
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private recover(): void {
    cleanMemoryTemps(this.root);
    repairJournal(this.root);
    const pending = readPending(this.root);
    if (pending) {
      applyPending(this.root, pending);
      this.notify();
    }
  }
  private notify(): void {
    this.notification = this.notification
      .then(() => this.changed?.())
      .catch(() => {
        // Notifications cannot change the outcome of an already durable transaction.
        console.warn(message('memoryNotificationFailedLog'));
      });
  }
  private async flushNotification(): Promise<void> {
    const notification = this.notification;
    await notification;
    if (this.notification === notification) this.notification = Promise.resolve();
  }
  private documents(): Map<string, string> {
    const files = new Map([['MEMORY.md', readMemoryFile(this.root, 'MEMORY.md') || indexDocument([], [])]]);
    for (const file of memoryFiles(this.root, 'topics')) {
      validTopic(file.slice(7, -3));
      files.set(file, readMemoryFile(this.root, file));
    }
    return files;
  }
  private view(files = this.documents()): MemoryView {
    const entries = [...files].flatMap(
      ([file, content]) => parseMemory(content, file === 'MEMORY.md' ? undefined : file.slice(7, -3)).entries,
    );
    return {
      entries,
      topics: [...files.keys()]
        .filter((file) => file !== 'MEMORY.md')
        .map((file) => {
          const name = file.slice(7, -3);
          return { name, entries: entries.filter((entry) => entry.topic === name).length };
        }),
    };
  }
  list(): Promise<MemoryView> {
    return this.run(() => this.view());
  }
  recall(args: { query?: string; topic?: string } = {}): Promise<MemoryView | { topic: string; content: string }> {
    return this.run(() => {
      if (args.topic !== undefined) return this.topicNow(args.topic);
      const view = this.view();
      if (args.query !== undefined) {
        if (typeof args.query !== 'string') throw new ServerFailure(text('memoryInvalidEntry'));
        const query = args.query.toLocaleLowerCase();
        view.entries = view.entries.filter((entry) => entry.text.toLocaleLowerCase().includes(query));
      }
      return view;
    });
  }
  readTopic(topic: string): Promise<{ topic: string; content: string }> {
    return this.run(() => this.topicNow(topic));
  }
  private topicNow(topic: string) {
    validTopic(topic);
    const files = this.documents();
    const content = files.get(`topics/${topic}.md`);
    if (content === undefined) throw new ServerFailure(text('memoryNotFound'));
    return { topic, content };
  }
  remember(value: unknown, topic?: string, source = 'owner'): Promise<{ saved: boolean; entry: MemoryEntry }> {
    return this.run(() => {
      const files = this.documents();
      const result = this.stageRemember(files, value, topic, source);
      this.commit(files);
      return result;
    });
  }
  private stageRemember(files: Map<string, string>, value: unknown, topic?: string, source = 'owner') {
    const cleaned = validateEntry(value);
    if (topic !== undefined) validTopic(topic);
    const duplicate = this.view(files).entries.find((entry) => entry.topic === topic && entry.text === cleaned);
    if (duplicate) return { saved: false, entry: duplicate };
    const line = entryLine(cleaned, this.source(source), randomUUID());
    this.appendEntry(files, line, topic);
    return { saved: true, entry: parseMemory(`${line}\n`, topic).entries[0]! };
  }

  private appendEntry(files: Map<string, string>, line: string, topic?: string): void {
    const file = topic === undefined ? 'MEMORY.md' : `topics/${topic}.md`;
    if (topic === undefined) {
      const document = parseMemory(files.get(file)!);
      files.set(file, indexDocument([...document.entries.map((entry) => entry.line), line], document.topics));
    } else files.set(file, `${(files.get(file) ?? `# ${topic}\n`).trimEnd()}\n\n${line}\n`);
  }
  private replaceEntry(
    files: Map<string, string>,
    entry: MemoryEntry,
    replacement?: { text: string; source: string; topic?: string },
  ): void {
    const file = entry.topic === undefined ? 'MEMORY.md' : `topics/${entry.topic}.md`;
    const lines = files.get(file)!.split('\n');
    const line = replacement ? entryLine(replacement.text, replacement.source, entry.id) : undefined;
    const sameTopic = replacement?.topic === entry.topic;
    lines.splice(lines.indexOf(entry.line), 1, ...(line && sameTopic ? [line] : []));
    files.set(file, lines.join('\n'));
    if (line && !sameTopic) this.appendEntry(files, line, replacement!.topic);
  }

  edit(match: string, value: unknown): Promise<MemoryView> {
    return this.changeEntry(match, { value });
  }
  forget(match: string): Promise<MemoryView> {
    return this.changeEntry(match);
  }
  private changeEntry(match: string, replacement?: { value: unknown }): Promise<MemoryView> {
    return this.run(() => {
      const value = replacement ? validateEntry(replacement.value) : undefined;
      const files = this.documents();
      const entry = this.view(files).entries.find((entry) => entry.id === match || entry.text === match);
      if (!entry) throw new ServerFailure(text('memoryNotFound'));
      this.replaceEntry(
        files,
        entry,
        value === undefined ? undefined : { text: value, source: 'owner', topic: entry.topic },
      );
      this.commit(files);
      return this.view(files);
    });
  }
  writeTopic(topic: string, content: unknown): Promise<{ topic: string; content: string }> {
    return this.run(() => {
      validTopic(topic);
      if (typeof content !== 'string') throw new ServerFailure(text('memoryInvalidEntry'));
      if (characters(content) > memoryRules.topic) throw new ServerFailure(text('memoryTopicLimit', memoryRules.topic));
      rejectSecrets(content);
      const files = this.documents();
      const old = parseMemory(files.get(`topics/${topic}.md`) ?? '', topic).entries;
      const lines = content.split(/\r?\n/).map((line) => {
        if (!line.trim() || /^#{1,6} /.test(line)) return line;
        const parsed = parseMemory(line, topic).entries[0];
        const value = validateEntry(parsed?.text ?? line.replace(/^- /, ''));
        const existing = old.find((entry) => entry.line === line);
        return existing?.line ?? entryLine(value, 'owner', randomUUID());
      });
      files.set(`topics/${topic}.md`, lines.join('\n'));
      this.commit(files);
      return this.topicNow(topic);
    });
  }
  private source(source: string): string {
    if (!/^[a-zA-Z0-9_:-]{1,160}$/.test(source)) throw new ServerFailure(text('memoryInvalidData'));
    return source;
  }
  private prepare(files: Map<string, string>): void {
    const topics = [...files.keys()].filter((file) => file !== 'MEMORY.md').map((file) => file.slice(7, -3));
    if (topics.length > memoryRules.topics) throw new ServerFailure(text('memoryTopicsLimit', memoryRules.topics));
    const index = parseMemory(files.get('MEMORY.md')!);
    files.set(
      'MEMORY.md',
      indexDocument(
        index.entries.map((entry) => entry.line),
        topics,
      ),
    );
    for (const [file, content] of files) {
      const limit = file === 'MEMORY.md' ? memoryRules.index : memoryRules.topic;
      if (characters(content) > limit)
        throw new ServerFailure(text(file === 'MEMORY.md' ? 'memoryIndexLimit' : 'memoryTopicLimit', limit));
      rejectSecrets(content);
    }
  }
  private commit(files: Map<string, string>, metadata: Record<string, string> = {}): void {
    this.prepare(files);
    const pending: PendingMemory = { id: randomUUID(), time: new Date().toISOString(), files: { ...metadata } };
    for (const [file, content] of files) {
      const before = readMemoryFile(this.root, file);
      if (before === content && existsSync(memoryPath(this.root, file))) continue;
      pending.files[file] = content;
    }
    if (!Object.keys(pending.files).length) return;
    this.redactSnapshots(files, pending);
    atomicMemoryFile(this.root, 'pending.json', JSON.stringify(pending));
    this.step?.('pending.json');
    applyPending(this.root, pending, this.step);
    this.notify();
  }
  private redactSnapshots(files: Map<string, string>, pending: PendingMemory): void {
    const removed = new Set<string>();
    for (const [file, content] of files) {
      const next = new Set(content.split('\n'));
      for (const entry of parseMemory(readMemoryFile(this.root, file)).entries) {
        if (!next.has(entry.line)) removed.add(entry.line);
      }
    }
    if (!removed.size) return;
    for (const file of memoryFiles(this.root, 'snapshots')) {
      const before = readMemoryFile(this.root, file);
      const after = before
        .split('\n')
        .filter((line) => !removed.has(line))
        .join('\n');
      if (before !== after) pending.files[file] = after;
    }
  }
  private autoState() {
    const raw = readMemoryFile(this.root, 'auto.json');
    return autoStateSchema.parse(raw ? JSON.parse(raw) : { cursors: {} });
  }
  autoSettings(defaultEnabled = true): { enabled: boolean } {
    return { enabled: this.autoState().enabled ?? defaultEnabled };
  }
  initializeAuto(defaultEnabled: boolean): void {
    const state = this.autoState();
    const enabled = state.enabled ?? defaultEnabled;
    if (enabled === (state.enabledAt !== undefined)) return;
    state.enabledAt = enabled ? Date.now() : undefined;
    atomicMemoryFile(this.root, 'auto.json', JSON.stringify(state));
  }
  autoEnabledAt(): number {
    return this.autoState().enabledAt ?? Infinity;
  }
  setAuto(enabled: unknown): Promise<{ enabled: boolean }> {
    if (typeof enabled !== 'boolean') return Promise.reject(new ServerFailure(text('memoryAutoMustBoolean')));
    return this.run(() => {
      const state = this.autoState();
      state.enabled = enabled;
      state.enabledAt = enabled ? (state.enabledAt ?? Date.now()) : undefined;
      atomicMemoryFile(this.root, 'auto.json', JSON.stringify(state));
      this.notify();
      return { enabled };
    });
  }
  reviewed(sessionId: string): number {
    return this.autoState().cursors[sessionId] ?? 0;
  }
  recentAuto(): Promise<MemoryEntry[]> {
    return this.run(() =>
      this.view()
        .entries.filter((entry) => entry.source === 'auto')
        .sort((a, b) => b.added.localeCompare(a.added))
        .slice(0, 50),
    );
  }
  /** Commit valid operations and the cursor together, skipping invalid facts.
   * A concurrent change to the supplied baseline still rejects the entire proposal. */
  async applyAuto(
    sessionId: string,
    cursor: number,
    operations: MemoryOperation[],
    baseline: MemoryEntry[],
    allowed: () => boolean,
  ) {
    const validated = memoryOperations.parse(operations);
    return this.run(() => {
      if (!allowed()) return false;
      const files = this.documents();
      const current = this.view(files).entries;
      const expected = new Map(baseline.map((entry) => [entry.id, entry]));
      if (
        current.length !== baseline.length ||
        current.some((entry) => {
          const previous = expected.get(entry.id);
          return previous?.line !== entry.line || previous?.topic !== entry.topic;
        })
      )
        throw new ServerFailure(text('memoryInvalidData'));
      const staged = this.stageAutoBatch(files, validated, baseline);
      const state = this.autoState();
      state.cursors[sessionId] = cursor;
      this.commit(staged.files, { 'auto.json': JSON.stringify(state) });
      if (staged.skipped) console.warn(message('memoryAutoSkippedLog', undefined, [staged.skipped]));
      return true;
    });
  }
  private stageAutoBatch(files: Map<string, string>, operations: MemoryOperation[], baseline: MemoryEntry[]) {
    let skipped = 0;
    for (const operation of operations) {
      const candidate = new Map(files);
      try {
        this.stageAuto(candidate, operation, baseline);
        this.prepare(candidate);
      } catch (error) {
        if (!(error instanceof ServerFailure)) throw error;
        skipped++;
        continue;
      }
      files = candidate;
    }
    return { files, skipped };
  }
  private stageAuto(files: Map<string, string>, operation: MemoryOperation, baseline: MemoryEntry[]): void {
    if (operation.op === 'none') return;
    const value = validateEntry(operation.text);
    if (operation.topic !== undefined) validTopic(operation.topic);
    const entries = this.view(files).entries;
    if (operation.op === 'add') {
      if (!entries.some((entry) => entry.text.toLocaleLowerCase() === value.toLocaleLowerCase()))
        this.stageRemember(files, value, operation.topic, 'auto');
      return;
    }
    const entry = entries.find((item) => item.id === operation.id);
    if (!entry || !baseline.some((item) => item.id === entry.id)) throw new ServerFailure(text('memoryInvalidData'));
    const topic = operation.topic ?? entry.topic;
    this.replaceEntry(files, entry, { text: value, source: 'auto', topic });
  }

  deleteSnapshot(sessionId: string): void {
    this.recover();
    removeMemoryFile(this.root, this.snapshotFile(sessionId));
  }
  private pruneSnapshots(): void {
    const cutoff = Date.now() - memoryRules.snapshotDays * 24 * 60 * 60 * 1000;
    for (const file of memoryFiles(this.root, 'snapshots')) {
      if (statSync(memoryPath(this.root, file)).mtimeMs < cutoff) removeMemoryFile(this.root, file);
    }
  }
  private snapshotFile(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) throw new ServerFailure(text('memoryInvalidData'));
    return `snapshots/${sessionId}.md`;
  }
  /** DSH's section providers are synchronous. This freezes the complete block, including instructions. */
  snapshot(sessionId: string): string {
    this.recover();
    const file = this.snapshotFile(sessionId);
    const saved = readMemoryFile(this.root, file);
    if (saved) return saved;
    const content = `# ${message('memoryHeading')}\n${message('memoryPromptRules')}\n\n${readMemoryFile(this.root, 'MEMORY.md') || indexDocument([], [])}`;
    atomicMemoryFile(this.root, file, content);
    return content;
  }
}
