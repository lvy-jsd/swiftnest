/** Small owner settings files: read leniently, written atomically (temp file, then rename), one write at a time. */
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';

/** The file's JSON, or undefined when it does not exist yet. Other read errors are real failures. */
export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export class JsonFileWriter {
  private writes = Promise.resolve();

  constructor(private readonly file: string) {}

  /** Queue a write; `saved` runs once the file holds `value`, so readers never see unsaved state. */
  write(value: unknown, saved: () => void): Promise<void> {
    const write = this.writes.then(async () => {
      await writeFile(`${this.file}.tmp`, JSON.stringify(value), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
      saved();
    });
    this.writes = write.catch(() => {});
    return write;
  }

  flush(): Promise<void> {
    return this.writes;
  }
}
