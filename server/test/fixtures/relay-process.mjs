import { startRelay } from '../../../packages/relay/dist/index.js';
const relay = await startRelay({ secret: process.env.SWIFTNEST_RELAY_SECRET, port: 0 });
process.send({ url: relay.url });
process.once('message', () => {
  void relay.close().then(() => process.disconnect());
});
