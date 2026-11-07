import { describe, expect, it } from 'vitest';
import { allowedOrigins, createProvider, destination, publicAddress } from '../src/web-fetch.js';

describe('web-fetch security policy', () => {
  it('correctly classifies private and public addresses', () => {
    expect(publicAddress('127.0.0.1')).toBe(false);
    expect(publicAddress('192.168.1.1')).toBe(false);
    expect(publicAddress('10.0.0.5')).toBe(false);
    expect(publicAddress('172.16.0.1')).toBe(false);
    expect(publicAddress('::1')).toBe(false);
    expect(publicAddress('fe80::1')).toBe(false);
    expect(publicAddress('fc00::1')).toBe(false);

    // Public unicast IPs
    expect(publicAddress('8.8.8.8')).toBe(true);
    expect(publicAddress('1.1.1.1')).toBe(true);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('rejects URLs resolving to private IP addresses unless whitelisted', async () => {
    const mockResolver = async (host: string) => {
      if (host === 'internal.router') return [{ address: '192.168.1.1', family: 4 }];
      if (host === 'public.example') return [{ address: '93.184.216.34', family: 4 }];
      return [];
    };

    const emptyAllow = new Set<string>();

    await expect(destination('http://127.0.0.1/test', emptyAllow, mockResolver)).rejects.toThrow(
      /non-public destination requires webFetch\.allowOrigins/,
    );

    await expect(destination('http://internal.router/admin', emptyAllow, mockResolver)).rejects.toThrow(
      /non-public destination requires webFetch\.allowOrigins/,
    );

    const dest = await destination('http://public.example/', emptyAllow, mockResolver);
    expect(dest.url.origin).toBe('http://public.example');
    expect(dest.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('permits private destination if origin is explicitly allowed in allowOrigins', async () => {
    const mockResolver = async (host: string) => {
      if (host === 'local.dev') return [{ address: '127.0.0.1', family: 4 }];
      return [];
    };

    const allow = allowedOrigins(['http://local.dev']);
    const dest = await destination('http://local.dev/api', allow, mockResolver);
    expect(dest.url.origin).toBe('http://local.dev');
    expect(dest.addresses).toEqual([{ address: '127.0.0.1', family: 4 }]);

    const provider = createProvider({ allowOrigins: ['http://local.dev'] }, mockResolver);
    expect(provider.id).toBe('http');
    expect(provider.available()).toBe(true);
  });
});
