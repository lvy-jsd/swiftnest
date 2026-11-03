import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { initialMemoryState, memoryReducer, watchMemoryChanges } from '../src/memoryState';
import { MemoryPage } from '../src/memory';
import { I18nProvider, translate } from '../src/i18n';
import { ConnectionProvider } from '../src/connection';

it('keeps previous entries and the server rejection until a successful reload', () => {
  const view = { entries: [], topics: [{ name: 'Work', entries: 0 }] };
  let state = memoryReducer(initialMemoryState, { type: 'loaded', view });
  state = memoryReducer(state, { type: 'start' });
  expect(state.busy).toBe(true);
  const error = { text: { key: 'memorySecret' } };
  state = memoryReducer(state, { type: 'failed', error });
  expect(state).toEqual({ view, busy: false, error });
  expect(memoryReducer(state, { type: 'loaded', view })).toEqual({ view, busy: false });
});

it.each(['en', 'zh-CN'] as const)('renders a localized Memory page while disconnected: %s', (locale) => {
  const html = renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ConnectionProvider>
        <MemoryPage onBack={() => {}} />
      </ConnectionProvider>
    </I18nProvider>,
  );
  expect(html).toContain(translate(locale, 'memory'));
  expect(html).toContain(translate(locale, 'memoryHelp'));
  expect(html).toContain(translate(locale, 'pairHelp'));
});

it('refreshes on memory events and reconnect, ignores unrelated events, and aborts on unmount', async () => {
  const refresh = vi.fn(async () => {});
  let signal: AbortSignal | undefined;
  const watchDevices = vi.fn(async (options) => {
    signal = options.signal;
    return (async function* () {
      yield { type: 'plugins-changed' };
      yield { type: 'memory-changed' };
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
    })();
  });
  const client = { watchDevices } as unknown as import('@swiftnest/api').SwiftnestClient;
  const stop = watchMemoryChanges(client, refresh);
  await expect.poll(() => refresh.mock.calls.length).toBe(2);
  stop();
  expect(signal?.aborted).toBe(true);
  expect(watchDevices).toHaveBeenCalledOnce();
});
