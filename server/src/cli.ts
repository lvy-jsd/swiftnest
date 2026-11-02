#!/usr/bin/env node
import { message, localizedError } from './i18n.js';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { startKernel } from './kernel.js';
import { pairingUrl, webAppUrl } from './pairing.js';

let selectedLanguage: 'zh-CN' | 'en' = process.env.SWIFTNEST_LANG === 'en' ? 'en' : 'zh-CN';

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals[0] !== 'start') {
    console.log(message('help', loadConfig(values.config).lang));
    return values.help ? 0 : 2;
  }
  const config = loadConfig(values.config);
  selectedLanguage = config.lang ?? 'zh-CN';
  process.env.SWIFTNEST_LANG = selectedLanguage;
  console.log(message('starting', config.lang, [config.home]));
  const kernel = await startKernel(config, {
    onLine: values.verbose ? (line) => console.log(`  [dsh] ${line}`) : undefined,
  });
  console.log(message('ready', config.lang, [kernel.url]));
  console.log(message('links', config.lang));
  console.log(`  ${message('browser', config.lang)}: ${kernel.url}?token=${kernel.token}`);
  console.log(`  Swiftnest App:        ${pairingUrl(kernel.url, kernel.token)}`);
  console.log(`  ${message('webApp', config.lang)}: ${webAppUrl(kernel.url, kernel.token)}`);

  const shutdown = async () => {
    await kernel.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  kernel.child.once('exit', (code) => {
    void kernel.stop().then(() => process.exit(code ?? 1));
  });
  return new Promise(() => {});
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const failure = localizedError(err, selectedLanguage);
    console.error(`[${failure.code}] ${failure.message}\n${failure.hint}`);
    process.exit(1);
  },
);
