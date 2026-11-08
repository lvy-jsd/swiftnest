import { DeviceHubProvider } from '../src/devices';
import type { PropsWithChildren } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary, SwiftnestClient } from '@swiftnest/api';
import { ConnectionProvider, ConnectionStore, type ConnectionState } from '../src/connection';
import { I18nProvider } from '../src/i18n';
import { ChatFilters, IdentityRow, Sidebar } from '../src/shell';
import { groupChats, greetingKey } from '../src/shellState';
import { Suggestions } from '../src/home';
import { Preferences } from '../src/preferences';
import { ApprovalInboxProvider } from '../src/inboxState';
import { PluginsProvider } from '../src/plugins';
import { ThemeProvider } from '../src/design/theme';

const chat = (sessionId: string, date: string): SessionSummary => ({
  sessionId,
  updatedAt: +new Date(date),
  running: false,
  blank: false,
});
const now = new Date(2026, 10, 4, 12);
const localDate = (day: number, hour = 12) => new Date(2026, 10, day, hour).toISOString();
afterEach(() => vi.useRealTimers());

function English({ children }: PropsWithChildren) {
  return <I18nProvider initialLocale="en">{children}</I18nProvider>;
}

describe('chat calendar grouping', () => {
  it('uses a fixed local clock, sorts activity and separates all four calendar groups', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const items = [
      chat('older', localDate(1)),
      chat('today', localDate(4, 0)),
      chat('week', localDate(2)),
      chat('yesterday', localDate(3, 23)),
    ];
    expect(groupChats(items).map(({ chat, group }) => [chat.sessionId, group])).toEqual([
      ['today', 'shell.today'],
      ['yesterday', 'shell.yesterday'],
      ['week', 'shell.thisWeek'],
      ['older', 'shell.older'],
    ]);
    expect(items[0]?.sessionId).toBe('older');
  });
  it('keeps yesterday distinct across a Monday/week/month boundary', () => {
    expect(
      groupChats(
        [chat('sunday', localDate(1)), chat('saturday', new Date(2026, 9, 31).toISOString())],
        new Date(2026, 10, 2),
      ).map(({ group }) => group),
    ).toEqual(['shell.yesterday', 'shell.older']);
  });
  it('translates greetings at their time boundaries', () => {
    expect([0, 11, 12, 17, 18, 23].map(greetingKey)).toEqual([
      'home.morning',
      'home.morning',
      'home.afternoon',
      'home.afternoon',
      'home.evening',
      'home.evening',
    ]);
  });
});

it('hides filter chips without state data and only exposes supported running state', () => {
  const render = (sessions: SessionSummary[]) =>
    renderToStaticMarkup(
      <English>
        <ChatFilters sessions={sessions} runningOnly={false} onChange={() => {}} />
      </English>,
    );
  expect(render([])).toBe('');
  expect(render([{ sessionId: 'legacy', updatedAt: 1 } as SessionSummary])).toBe('');
  const html = render([chat('known', localDate(4))]);
  expect(html).toContain('All');
  expect(html).toContain('Running');
  expect(html).not.toContain('Waiting');
});

it.each([
  ['disconnected', false, 'Disconnected', false],
  ['connecting', false, 'Connecting', false],
  ['connected', false, 'Connected', false],
  ['connected', true, 'Connected', true],
  ['disconnected', true, 'Disconnected', false],
] as const)('identity reflects %s, encrypted=%s', (status, encrypted, label, claim) => {
  const store = new ConnectionStore();
  vi.spyOn(store, 'getSnapshot').mockReturnValue({
    status,
    root: 'http://localhost:3077/',
    sessions: [],
  } satisfies ConnectionState);
  store.client = { connectionEncrypted: encrypted } as SwiftnestClient;
  const html = renderToStaticMarkup(
    <English>
      <ConnectionProvider store={store}>
        <IdentityRow onPreferences={() => {}} />
      </ConnectionProvider>
    </English>,
  );
  expect(html).toContain('localhost:3077');
  expect(html).toContain(label);
  expect(html.includes('Encrypted')).toBe(claim);
});

it('offers four translated suggestions and settings ListRows', () => {
  const html = renderToStaticMarkup(
    <ThemeProvider>
      <English>
        <ConnectionProvider>
          <DeviceHubProvider>
            <PluginsProvider>
              <ApprovalInboxProvider>
                <Suggestions onChoose={() => {}} />
                <Preferences open={true} onClose={() => {}} />
              </ApprovalInboxProvider>
            </PluginsProvider>
          </DeviceHubProvider>
        </ConnectionProvider>
      </English>
    </ThemeProvider>,
  );
  expect(html.match(/class="suggestion card"/g) ?? []).toHaveLength(4);
  expect(html).toContain('Help me plan my day');
  expect(html).toContain('list-row__title">Models');
  expect(html).toContain('list-row__title">Plugins');
});

it('groups rendered chat rows and marks only actual running sessions', () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const store = new ConnectionStore();
  vi.spyOn(store, 'getSnapshot').mockReturnValue({
    status: 'connected',
    root: '',
    sessions: [
      { ...chat('active', localDate(4)), running: true, title: 'Active task' },
      { ...chat('idle', localDate(3)), title: 'Previous task' },
    ],
  });
  const html = renderToStaticMarkup(
    <English>
      <ConnectionProvider store={store}>
        <PluginsProvider>
          <DeviceHubProvider>
            <ApprovalInboxProvider>
              <Sidebar chatId="active" onNewChat={() => {}} onNavigate={() => {}} onPreferences={() => {}} />
            </ApprovalInboxProvider>
          </DeviceHubProvider>
        </PluginsProvider>
      </ConnectionProvider>
    </English>,
  );
  expect(html).toContain('Today');
  expect(html).toContain('Yesterday');
  expect(html).toContain('aria-current="page"');
  expect(html.match(/class="chat-running-dot"/g)).toHaveLength(1);
  expect(html).not.toContain('Waiting');
  expect(html).not.toContain('devices online');
});
