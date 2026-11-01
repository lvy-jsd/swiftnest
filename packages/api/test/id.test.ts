import { describe, expect, it, vi } from 'vitest';
import { randomId } from '../src/transport.js';
describe('plain LAN HTTP request ids', () => {
  it('generates unique UUIDs using getRandomValues when randomUUID is unavailable', () => {
    const original = globalThis.crypto;
    try {
      vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) });
      const ids = Array.from({ length: 100 }, randomId);
      expect(new Set(ids).size).toBe(100);
      expect(ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});
