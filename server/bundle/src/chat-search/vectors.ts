import type { DatabaseSync } from 'node:sqlite';

/** The only vector-storage interface; a personal collection needs no vector service. */
export interface VectorStore {
  pending(model: string): { id: number; text: string }[];
  put(id: number, model: string, vector: number[]): void;
  search(model: string, vector: number[]): number[];
  reset(): void;
}
export class SqliteVectors implements VectorStore {
  constructor(private db: DatabaseSync) {}
  pending(model: string) {
    return this.db
      .prepare(`SELECT m.id,m.text FROM messages m LEFT JOIN vectors v ON v.id=m.id AND v.model=?
      WHERE v.id IS NULL ORDER BY m.id LIMIT 16`)
      .all(model) as unknown as { id: number; text: string }[];
  }
  put(id: number, model: string, vector: number[]) {
    const bytes = Buffer.alloc(vector.length * 4);
    vector.forEach((value, index) => {
      bytes.writeFloatLE(value, index * 4);
    });
    this.db
      .prepare('INSERT OR REPLACE INTO vectors(id,model,vector) SELECT id,?,? FROM messages WHERE id=?')
      .run(model, bytes, id);
  }
  search(model: string, vector: number[]): number[] {
    return this.db
      .prepare('SELECT id,vector FROM vectors WHERE model=?')
      .all(model)
      .map((row) => {
        const bytes = Buffer.from(row.vector as Uint8Array);
        const candidate = Array.from({ length: bytes.length / 4 }, (_, index) => bytes.readFloatLE(index * 4));
        return { id: row.id as number, score: cosine(vector, candidate) };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.id - b.id)
      .slice(0, 100)
      .map((row) => row.id);
  }
  reset() {
    this.db.exec('DELETE FROM vectors');
  }
}
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    left += a[i]! ** 2;
    right += b[i]! ** 2;
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}
