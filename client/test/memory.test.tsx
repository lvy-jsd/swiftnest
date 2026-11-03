import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { initialMemoryState, memoryReducer } from '../src/memoryState';
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
