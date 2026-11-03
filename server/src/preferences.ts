/** The owner's saved preferences (today only the language), written atomically. */
import { JsonFileWriter, readJsonFile } from './json-store.js';

export type Language = 'zh-CN' | 'en';

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'zh-CN';
}

export class Preferences {
  private readonly writer: JsonFileWriter;

  private constructor(
    file: string,
    public lang: Language,
  ) {
    this.writer = new JsonFileWriter(file);
  }

  /** Load `file`, falling back to `fallback` when it does not exist yet. */
  static async open(file: string, fallback: Language): Promise<Preferences> {
    const lang = (readJsonFile(file) as { lang?: unknown } | null | undefined)?.lang;
    return new Preferences(file, isLanguage(lang) ? lang : fallback);
  }

  /** Persist a new language; writes are serialized and `lang` changes only once saved. */
  setLanguage(lang: Language): Promise<void> {
    return this.writer.write({ lang }, () => {
      this.lang = lang;
    });
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }
}
