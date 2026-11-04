import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
it('has valid POSIX shell syntax', () => {
  expect(spawnSync('sh', ['-n', installer]).status).toBe(0);
});
it.each([
  '',
  'http://relay.example',
  'relay.example;echo unsafe',
  '127.0.0.1',
  '.example.com',
  '-bad.example',
  'bad..example',
])('refuses an unsafe or missing domain before installing anything: %s', (domain) => {
  const result = spawnSync('sh', [installer, domain], { encoding: 'utf8', timeout: 1000 });
  expect(result.status).not.toBe(0);
  expect(result.error).toBeUndefined();
});
