/** A real TLS terminator: preserve Host/Origin and append the immediate client's IP. */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';

async function proxyCertificate(home: string, host: string) {
  const keyFile = join(home, 'proxy-key.pem');
  const certFile = join(home, 'proxy-cert.pem');
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
      '/CN=Swiftnest proxy test',
      '-addext',
      `subjectAltName=IP:${host}`,
    ],
    { stdio: 'ignore' },
  );
  return { key: await readFile(keyFile), cert: await readFile(certFile) };
}

export async function reverseProxy(home: string, host: string) {
  const certificate = await proxyCertificate(home, host);
  let upstream: URL;
  const sockets = new Set<Duplex>();
  const server = createServer(certificate, (req, res) => {
    const target = request(new URL(req.url!, upstream), { method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode!, response.headers);
      response.pipe(res);
    });
    target.on('error', () => res.destroy());
    req.pipe(target);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    const target = connect(Number(upstream.port), upstream.hostname, () => {
      const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress };
      target.write(
        `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\r\n')}\r\n\r\n`,
      );
      target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
    socket.once('close', () => target.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return {
    url: `https://${host}:${(server.address() as AddressInfo).port}/`,
    forwardTo(url: string) {
      upstream = new URL(url);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
