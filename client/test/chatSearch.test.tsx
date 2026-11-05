import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
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
