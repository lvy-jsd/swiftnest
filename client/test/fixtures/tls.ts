/** Local test certificate only; the child trusts this CA and Playwright accepts it explicitly. */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerConfig } from '../../../server/src/config';
import { profileDir } from '../../../server/src/profile';

export async function testTls(config: ServerConfig, host: string): Promise<NodeJS.ProcessEnv> {
  const certFile = join(config.home, 'test-cert.pem');
  const keyFile = join(config.home, 'test-key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '1',
      '-subj',
      '/CN=Swiftnest test',
      '-addext',
      `subjectAltName=IP:${host}`,
    ],
    { stdio: 'ignore' },
  );
  await mkdir(profileDir(config), { recursive: true });
  await writeFile(
    join(profileDir(config), 'user.patch.yml'),
    `- id: webserver
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
    tls: ${JSON.stringify({ certFile, keyFile })}
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
`,
  );
  return { NODE_EXTRA_CA_CERTS: certFile };
}
