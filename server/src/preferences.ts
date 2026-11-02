/** The owner's saved preferences (today only the language), written atomically. */
import { readFile, rename, writeFile } from 'node:fs/promises';

export type Language = 'zh-CN' | 'en';

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'zh-CN';
}

export class Preferences {
  private writes = Promise.resolve();

  private constructor(
    private readonly file: string,
    public lang: Language,
  ) {}

  /** Load `file`, falling back to `fallback` when it does not exist yet. */
  static async open(file: string, fallback: Language): Promise<Preferences> {
    try {
      const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
      const lang = (saved as { lang?: unknown } | null)?.lang;
      return new Preferences(file, isLanguage(lang) ? lang : fallback);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return new Preferences(file, fallback);
    }
  }

  /** Persist a new language; writes are serialized and `lang` changes only once saved. */
  setLanguage(lang: Language): Promise<void> {
    const write = this.writes.then(async () => {
      await writeFile(`${this.file}.tmp`, JSON.stringify({ lang }), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
      this.lang = lang;
    });
    this.writes = write.catch(() => {});
    return write;
  }

  flush(): Promise<void> {
    return this.writes;
  }
}
