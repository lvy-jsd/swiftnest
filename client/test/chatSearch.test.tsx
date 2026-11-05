import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ChatList } from '../src/chatList';
import { I18nProvider } from '../src/i18n';
import { ResultSnippet } from '../src/chatSearch';

it('renders highlights as escaped text, including quotes from historical conversations', () => {
  const html = renderToStaticMarkup(
    <ResultSnippet
      result={{
        id: 1,
        sessionId: 'old',
        title: 'Trip',
        time: 1,
        role: 'user',
        snippet: '<script>alert(1)</script> 杭州',
        highlights: [
          [0, 8],
          [26, 28],
        ],
      }}
    />,
  );
  expect(html).toContain('<mark>&lt;script&gt;</mark>');
  expect(html).not.toContain('<script>');
  expect(html).toContain('杭州');
});

it('uses compact grouped shell rows for multiple historical matches in one chat', () => {
  const result = {
    id: 1,
    sessionId: 'old/chat',
    title: 'Travel notes',
    time: 1,
    role: 'user' as const,
    snippet: '杭州 bicycle',
    highlights: [[0, 2]] as [number, number][],
  };
  const html = renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ChatList
        chatId="old/chat"
        onNavigate={() => {}}
        sessions={[1, 2].map((id) => ({
          sessionId: result.sessionId,
          updatedAt: id,
          title: result.title,
          running: true,
          blank: false,
          result: { ...result, id, time: id },
        }))}
      />
    </I18nProvider>,
  );
  expect(html).toContain('aria-label="Matching conversations"');
  expect(html.match(/class="chat-group-title"/g)).toHaveLength(1);
  expect(html).toContain('Earlier');
  expect(html.match(/aria-current="page"/g)).toHaveLength(2);
  expect(html.match(/class="chat-running-dot"/g)).toHaveLength(2);
  expect(html.match(/<mark>杭州<\/mark>/g)).toHaveLength(2);
  expect(html.match(/<time dateTime=/g)).toHaveLength(2);
  expect(html.match(/href="#\/chats\/old%2Fchat"/g)).toHaveLength(2);
  expect(html).not.toContain('type="search"');
});
