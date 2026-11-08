/** Hold pairing at a barrier to exercise both restore/render orderings without sleeps. */
import { createRoot } from 'react-dom/client';
import { App } from '../../src/App';
import { ConnectionProvider, ConnectionStore, type ConnectionState } from '../../src/connection';
import { ThemeProvider } from '../../src/design/theme';
import { I18nProvider } from '../../src/i18n';
import '../../src/styles.css';

const order = new URL(location.href).searchParams.get('restore');
const store = new ConnectionStore();
let state: ConnectionState = { status: 'disconnected', root: '', sessions: [] };
const listeners = new Set<() => void>();
const update = (patch: Partial<ConnectionState>) => {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
};
store.getSnapshot = () => state;
store.subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
store.restore = () => update({ status: 'connecting', pluginRestart: 'reconnecting' });
let release!: () => void;
const paired = new Promise<void>((resolve) => (release = resolve));
let calls = 0;
store.pair = async () => {
  calls++;
  await paired;
  update({ status: 'connected', pluginRestart: undefined });
  return true;
};
if (order === 'before') store.restore();
Object.assign(window, { pairingTest: { release, calls: () => calls, snapshot: () => state } });
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <I18nProvider initialLocale="en">
      <ConnectionProvider store={store}>
        <App />
      </ConnectionProvider>
    </I18nProvider>
  </ThemeProvider>,
);
