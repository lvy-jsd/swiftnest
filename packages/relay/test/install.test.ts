import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
it('has valid POSIX shell syntax', () => {
  expect(spawnSync('sh', ['-n', installer]).status).toBe(0);
});
it('runs TLS with an exact Caddy version and digest', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-install-'));
  const script = (await readFile(installer, 'utf8')).replace(
    'relay_dir=/opt/swiftnest-relay',
    'relay_dir="$RELAY_TEST_DIR/relay"',
  );
  const bin = join(home, 'bin');
  const stubs = {
    id: 'echo 0',
    'apt-get': ':',
    systemctl: ':',
    git: ':',
    openssl: 'echo test-secret',
    docker: 'printf \'%s\\n\' "$@"',
  };
  try {
    await mkdir(bin);
    await Promise.all(
      Object.entries(stubs).map(([name, body]) => writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })),
    );
    const result = spawnSync('sh', ['-c', script, installer, 'relay.example.com'], {
      encoding: 'utf8',
      env: { ...process.env, RELAY_TEST_DIR: home, PATH: `${bin}${delimiter}${process.env.PATH}` },
      timeout: 1000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^caddy:2\.\d+\.\d+@sha256:[a-f0-9]{64}$/m);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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
