import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli-args.js';
import { message } from '../src/i18n.js';

describe('server CLI arguments', () => {
  it('parses start and plugins install with config, verbosity and help', () => {
    expect(parseCliArgs(['start', '-c', 'server.yml', '-v'])).toEqual({
      command: 'start',
      values: { config: 'server.yml', verbose: true },
    });
    expect(parseCliArgs(['--config', 'server.yml', 'plugins', 'install'])).toEqual({
      command: 'plugins-install',
      values: { config: 'server.yml' },
    });
    expect(parseCliArgs(['plugins', 'install', '--help']).values.help).toBe(true);
  });
  it.each(
    [
      [],
      ['plugins'],
      ['plugins', 'remove'],
      ['tools', 'install'],
      ['start', 'extra'],
      ['plugins', 'install', 'extra'],
    ].map((args) => ({ args })),
  )('rejects unsupported command $args', ({ args }) => {
    expect(parseCliArgs(args).command).toBeUndefined();
  });
  it('rejects unknown options', () => {
    expect(() => parseCliArgs(['plugins', 'install', '--force'])).toThrow();
  });
  it.each(['zh-CN', 'en'] as const)('documents installation and disabling in %s', (lang) => {
    expect(message('help', lang)).toContain('swiftnest-server plugins install');
    expect(message('help', lang)).toContain('SWIFTNEST_PLUGINS');
  });
});
