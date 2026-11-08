// A real process with a controllable readiness/termination contract; no model or registry.
import { createServer } from 'node:http';

if (process.env.LIFECYCLE_MODE === 'ignore-term') process.on('SIGTERM', () => {});
const server = createServer((_req, res) => res.end('alive'));
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`fixture:${JSON.stringify({ pid: process.pid, port })}`);
  if (process.env.LIFECYCLE_MODE !== 'unready') console.log(`dsh web: http://127.0.0.1:${port}/?token=fixture`);
  process.send?.({ pid: process.pid, port });
});

// Hold the real CLI entry only in launch-path tests, after the parent guard is installed.
if (process.env.LIFECYCLE_PRELOAD === '1') await new Promise(() => {});
