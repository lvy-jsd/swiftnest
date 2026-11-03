/** Run one installer command, streaming each output line to the log. */
import { text } from '@swiftnest/core';
import { spawn } from 'node:child_process';
import { ServerFailure } from './i18n.js';

export type Log = (line: string) => void;

function collect(stream: NodeJS.ReadableStream, log: Log): void {
  let pending = '';
  stream.on('data', (chunk: Buffer) => {
    const lines = (pending + chunk.toString('utf8')).split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) if (line) log(line);
  });
  stream.on('end', () => {
    if (pending) log(pending);
  });
}

export function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: Log): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    collect(child.stdout!, log);
    collect(child.stderr!, log);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolveRun();
      else reject(new ServerFailure(text('pluginCommandFailed', command, String(code))));
    });
  });
}
