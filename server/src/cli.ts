#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { startKernel } from "./kernel.js";
import { pairingUrl } from "./pairing.js";

const HELP = `swiftnest-server — run Swiftnest Server

Usage:
  swiftnest-server start [--config <file>] [--verbose]

Environment overrides: SWIFTNEST_HOME, SWIFTNEST_HOST, SWIFTNEST_PORT,
SWIFTNEST_MODEL_BASE_URL, SWIFTNEST_MODEL_ID, and the key variable named by
model.apiKeyEnv (default SWIFTNEST_MODEL_API_KEY).`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || positionals[0] !== "start") {
    console.log(HELP);
    return values.help ? 0 : 2;
  }
  const config = loadConfig(values.config);
  console.log(`Starting Swiftnest Server (data in ${config.home})…`);
  const kernel = await startKernel(config, {
    onLine: values.verbose ? (line) => console.log(`  [dsh] ${line}`) : undefined,
  });
  console.log(`Ready: ${kernel.url}`);
  console.log(`Links below are valid until the server restarts.`);
  console.log(`  Browser (DSH Web UI): ${kernel.url}?token=${kernel.token}`);
  console.log(`  Swiftnest App:        ${pairingUrl(kernel.url, kernel.token)}`);

  const shutdown = async () => {
    await kernel.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  kernel.child.once("exit", (code) => process.exit(code ?? 1));
  return new Promise(() => {});
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
