import { parseArgs } from 'node:util';

export function parseCliArgs(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command =
    positionals.length === 1 && positionals[0] === 'start'
      ? 'start'
      : positionals.length === 2 && positionals[0] === 'tools' && positionals[1] === 'install'
        ? 'tools-install'
        : undefined;
  return { values, command };
}
