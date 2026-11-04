import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatSearchResult, ChatSearchSettings } from '@swiftnest/protocol';
import { chunkText, fullTextQuery, fuseRanks, snippet } from './text.js';

export interface SearchHeader {
  id: string;
  origin?: string;
}
export interface SearchEvent {
  seq: number;
  time: number;
  type: string;
  data: unknown;
}
interface SearchRow {
  seq: number;
  id: number;
  sessionId: string;
  title: string;
  time: number;
  role: 'user' | 'assistant';
  text: string;
}

export class ChatIndex {
  readonly db: DatabaseSync;
  constructor(home: string) {
    const directory = join(home, 'search');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, 'chats.db'));
    chmodSync(join(directory, 'chats.db'), 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL DEFAULT -1);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL, seq INTEGER NOT NULL, chunk INTEGER NOT NULL,
        time INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', UNIQUE(sessionId, seq, chunk));
      CREATE VIRTUAL TABLE IF NOT EXISTS chats USING fts5(text, title, content='messages', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS messages_insert AFTER INSERT ON messages BEGIN
        INSERT INTO chats(rowid,text,title) VALUES (new.id,new.text,new.title); END;
      CREATE TRIGGER IF NOT EXISTS messages_delete AFTER DELETE ON messages BEGIN
        INSERT INTO chats(chats,rowid,text,title) VALUES ('delete',old.id,old.text,old.title); END;
      CREATE TRIGGER IF NOT EXISTS messages_update AFTER UPDATE ON messages BEGIN
        INSERT INTO chats(chats,rowid,text,title) VALUES ('delete',old.id,old.text,old.title);
        INSERT INTO chats(rowid,text,title) VALUES (new.id,new.text,new.title); END;
      CREATE TABLE IF NOT EXISTS vectors (id INTEGER PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }
  close() {
    this.db.close();
  }
  through(id: string): number {
    return (this.db.prepare('SELECT seq FROM sessions WHERE id=?').get(id)?.seq as number | undefined) ?? -1;
  }
  consume(header: SearchHeader, events: readonly SearchEvent[]) {
    if (header.origin === 'subagent') return;
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO sessions(id) VALUES (?)').run(header.id);
      for (const event of events) {
        if (event.seq <= this.through(header.id)) continue;
        if (event.seq !== this.through(header.id) + 1) break;
        this.append(header.id, event);
        this.db.prepare('UPDATE sessions SET seq=? WHERE id=?').run(event.seq, header.id);
      }
    });
  }
  private append(id: string, event: SearchEvent) {
    const data = event.data as Record<string, unknown>;
    if (event.type === 'session/title' && typeof data.title === 'string') {
      this.db.prepare('UPDATE sessions SET title=? WHERE id=?').run(data.title, id);
      this.db.prepare('UPDATE messages SET title=? WHERE sessionId=?').run(data.title, id);
    }
    const role = event.type === 'assistant/message' ? 'assistant' : event.type === 'user/message' ? 'user' : null;
    if (!role || (role === 'user' && (data.source as { kind?: string })?.kind !== 'user')) return;
    const content = role === 'user' ? data.content : (data.message as { content?: unknown })?.content;
    const value = messageText(content);
    for (const [chunk, text] of chunkText(value).entries()) {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO messages(sessionId,seq,chunk,time,role,text,title) SELECT ?,?,?,?,?,?,title FROM sessions WHERE id=?',
        )
        .run(id, event.seq, chunk, event.time, role, text, id);
    }
  }
  deleteSession(id: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM vectors WHERE id IN (SELECT id FROM messages WHERE sessionId=?)').run(id);
      this.db.prepare('DELETE FROM messages WHERE sessionId=?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    });
  }
  prune(ids: Set<string>) {
    for (const row of this.db.prepare('SELECT id FROM sessions').all()) {
      if (!ids.has(row.id as string)) this.deleteSession(row.id as string);
    }
  }
  rebuild() {
    this.transaction(() => {
      this.db.exec('DELETE FROM vectors; DELETE FROM messages; DELETE FROM sessions;');
      this.db.exec("INSERT INTO chats(chats) VALUES ('rebuild')");
    });
  }
  count(): number {
    return this.db.prepare('SELECT count(*) AS count FROM (SELECT DISTINCT sessionId,seq FROM messages)').get()!
      .count as number;
  }
  configuredSettings(config: ChatSearchSettings): ChatSearchSettings {
    const previous = this.db.prepare("SELECT value FROM metadata WHERE key='configuration'").get()?.value;
    const serialized = JSON.stringify(config);
    if (previous !== serialized) {
      this.saveSettings(config);
      this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('configuration',?)").run(serialized);
    }
    return this.settings() ?? config;
  }
  settings(): ChatSearchSettings | undefined {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key='settings'").get();
    return row ? JSON.parse(row.value as string) : undefined;
  }
  saveSettings(settings: ChatSearchSettings) {
    this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('settings',?)").run(JSON.stringify(settings));
  }
  lexical(query: string, limit = 100): number[] {
    const { match, short } = fullTextQuery(query);
    const where = short.map(() => "(m.text LIKE ? ESCAPE '\\' OR m.title LIKE ? ESCAPE '\\')");
    const args: SQLInputValue[] = short.flatMap((term) => [term, term]);
    if (match) {
      where.unshift('chats MATCH ?');
      args.unshift(match);
    }
    const from = match ? 'chats JOIN messages m ON m.id=chats.rowid' : 'messages m';
    return this.db
      .prepare(`SELECT m.id FROM ${from} WHERE ${where.join(' AND ') || '0'}
      ORDER BY ${match ? 'bm25(chats)' : 'm.time DESC'},m.id LIMIT ?`)
      .all(...args, limit)
      .map((row) => row.id as number);
  }
  results(query: string, limit: number, semantic: number[] = []): ChatSearchResult[] {
    const ids = fuseRanks(this.lexical(query), semantic);
    const seen = new Set<string>();
    const results: ChatSearchResult[] = [];
    for (const id of ids) {
      const row = this.db
        .prepare('SELECT m.*,s.title FROM messages m JOIN sessions s ON s.id=m.sessionId WHERE m.id=?')
        .get(id) as unknown as SearchRow | undefined;
      if (!row || seen.has(`${row.sessionId}:${row.seq}`)) continue;
      seen.add(`${row.sessionId}:${row.seq}`);
      results.push({
        id: row.id,
        sessionId: row.sessionId,
        title: row.title,
        time: row.time,
        role: row.role,
        ...snippet(row.text, query),
      });
      if (results.length >= limit) break;
    }
    return results;
  }
  private transaction(action: () => void) {
    this.db.exec('BEGIN');
    try {
      action();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}
