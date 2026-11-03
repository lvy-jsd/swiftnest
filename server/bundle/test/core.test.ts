import { describe, expect, it } from 'vitest';
import { apply, health, probeModel } from '../src/core.js';

describe('swiftnest-core', () => {
  it('reports an unconfigured model as unknown', async () => {
    expect(await probeModel(undefined)).toBeNull();
  });

  it('probes <baseUrl>/models', async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const h = await health({ version: '1.2.3', modelBaseUrl: 'http://m/v1/' }, '0.2.1-rc.5', fake);
    expect(seen).toEqual(['http://m/v1/models']);
    expect(h).toEqual({
      ok: true,
      swiftnest: '1.2.3',
      dsh: '0.2.1-rc.5',
      model: { configured: true, reachable: true },
    });
  });

  it('counts a gateway without /models as reachable, a 5xx as not', async () => {
    const status = (s: number) => (async () => new Response('', { status: s })) as unknown as typeof fetch;
    expect(await probeModel('http://m/v1', status(404))).toBe(true);
    expect(await probeModel('http://m/v1', status(502))).toBe(false);
  });

  it('treats a failing endpoint as unreachable', async () => {
    const fake = (async () => {
      throw new Error('refused');
    }) as unknown as typeof fetch;
    expect(await probeModel('http://m/v1', fake)).toBe(false);
  });

  it('registers health and App routes and disposes them with the plugin', async () => {
    const routes: string[] = [];
    const disposers: (() => void)[] = [];
    await apply({
      webServer: {
        register: (r) => {
          routes.push(r.path);
          return () => routes.splice(routes.indexOf(r.path), 1);
        },
      },
      effect: (fn) => {
        disposers.push(fn());
      },
    });
    expect(routes).toEqual(['/app', '/swiftnest/health']);
    for (const dispose of disposers) dispose();
    expect(routes).toEqual([]);
  });
});
