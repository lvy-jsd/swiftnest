import { spawn } from 'node:child_process';

const [guard, fixture, mode] = process.argv.slice(2);
const child = spawn(process.execPath, ['--import', guard, fixture], {
  env: { ...process.env, LIFECYCLE_MODE: mode },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
child.on('message', (message) => process.send(message));
child.on('error', (error) => {
  throw error;
});
process.on('message', () => {});
