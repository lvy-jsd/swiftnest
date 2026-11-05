import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { loadConfig, validate } from '../src/config.js';

it('keeps automatic memory, Gemini media and search settings independent with environment precedence', () => {
  const home = mkdtempSync(join(tmpdir(), 'swiftnest-search-memory-config-'));
  try {
    const path = join(home, 'server.yml');
    writeFileSync(
      path,
      'memory: { enabled: true, auto: false }\nmedia: { geminiUploads: true }\nsearch: { semantic: false }\n',
    );
    const config = loadConfig(path, {});
    expect(config.memory).toEqual({ enabled: true, auto: false });
    expect(config.media).toEqual({ geminiUploads: true });
    expect(config.search).toMatchObject({ enabled: true, semantic: false });
    const overridden = loadConfig(path, { SWIFTNEST_MEMORY_AUTO: 'true', SWIFTNEST_SEARCH: 'false' });
    expect(overridden.memory?.auto).toBe(true);
    expect(overridden.search).toMatchObject({ enabled: false, semantic: false });
    expect(overridden.media).toEqual(config.media);
    expect(() => validate({ ...config, memory: { enabled: true, auto: 'yes' as unknown as boolean } })).toThrow(
      /memory.auto/,
    );
    expect(() => validate({ ...config, search: { ...config.search!, enabled: 'yes' as unknown as boolean } })).toThrow(
      /search settings/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it('defaults to private local search and applies validated file/env overrides', () => {
  const config = loadConfig(undefined, {});
  expect(config.search).toEqual({
    enabled: true,
    semantic: true,
    embeddings: { source: 'local', cloudConsent: false },
  });
  expect(loadConfig(undefined, { SWIFTNEST_SEARCH: 'false', SWIFTNEST_SEARCH_SEMANTIC: 'false' }).search).toMatchObject(
    { enabled: false, semantic: false },
  );
  for (const env of [
    { SWIFTNEST_SEARCH: '1' },
    { SWIFTNEST_SEARCH_SEMANTIC: 'yes' },
    { SWIFTNEST_SEARCH_CLOUD_EMBEDDINGS: '1' },
    { SWIFTNEST_SEARCH_EMBEDDING_SOURCE: 'remote' },
    { SWIFTNEST_SEARCH_EMBEDDING_MODEL: 'bad model' },
  ]) {
    expect(() => loadConfig(undefined, env)).toThrow();
  }
  const home = mkdtempSync(join(tmpdir(), 'swiftnest-search-config-'));
  try {
    const path = join(home, 'server.yml');
    writeFileSync(
      path,
      'search:\n  semantic: false\n  embeddings:\n    source: cloud\n    model: text-embedding-3-small\n',
    );
    expect(
      loadConfig(path, { SWIFTNEST_SEARCH_SEMANTIC: 'true', SWIFTNEST_SEARCH_EMBEDDING_SOURCE: 'local' }).search,
    ).toEqual({
      enabled: true,
      semantic: true,
      embeddings: { source: 'local', model: 'text-embedding-3-small', cloudConsent: false },
    });
    writeFileSync(path, 'search:\n  enabled: 1\n');
    expect(() => loadConfig(path, {})).toThrow();
    expect(() =>
      validate({ ...config, search: { ...config.search!, semantic: 'yes' as unknown as boolean } }),
    ).toThrow();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
