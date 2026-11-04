#!/usr/bin/env node
import { message, localizedError } from './i18n.js';
import { installPlugins } from './plugin-install.js';
import { parseCliArgs } from './cli-args.js';
import { loadConfig, type ServerConfig } from './config.js';
import { type RunningKernel, startKernel } from './kernel.js';
import { readPluginSettings, withPluginSettings } from './plugin-settings.js';
import { pairingUrl, webAppUrl } from './pairing.js';

let selectedLanguage: 'zh-CN' | 'en' = process.env.SWIFTNEST_LANG === 'en' ? 'en' : 'zh-CN';

function printLinks(kernel: RunningKernel, config: ServerConfig): void {
  console.log(message('ready', config.lang, [kernel.url]));
  console.log(message('links', config.lang));
  console.log(`  ${message('browser', config.lang)}: ${kernel.url}?token=${kernel.token}`);
  const root = kernel.channelPairing.addresses.lan[0] ?? kernel.url;
  console.log(`  Swiftnest App:        ${pairingUrl(root, kernel.token, kernel.channelPairing)}`);
  console.log(`  ${message('webApp', config.lang)}: ${webAppUrl(root, kernel.token, kernel.channelPairing)}`);
}

async function main(argv: string[]): Promise<number> {
  const { values, command } = parseCliArgs(argv);
  if (values.help || !command) {
    console.log(message('help', loadConfig(values.config).lang));
    return values.help ? 0 : 2;
  }
  const config = loadConfig(values.config);
  selectedLanguage = config.lang ?? 'zh-CN';
  process.env.SWIFTNEST_LANG = selectedLanguage;
  if (command === 'plugins-install') {
    await installPlugins(withPluginSettings(config, readPluginSettings(config.home)), (line) => console.log(line));
    return 0;
  }
  console.log(message('starting', config.lang, [config.home]));
  const kernel = await startKernel(config, {
    onLine: values.verbose ? (line) => console.log(`  [dsh] ${line}`) : undefined,
    // The launch token changes when DSH restarts for new plugins, so print fresh links each time.
    onReady: (ready) => printLinks(ready, config),
  });

  const shutdown = async () => {
    await kernel.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  kernel.onExit((code) => process.exit(code ?? 1));
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
