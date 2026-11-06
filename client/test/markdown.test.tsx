import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { MessageMarkdown } from '../src/markdown';

const render = (text: string) =>
  renderToStaticMarkup(
    <I18nProvider>
      <MessageMarkdown text={text} />
    </I18nProvider>,
  );

describe('assistant Markdown', () => {
  it('renders Chinese headings, lists, emphasis, quotes, code and GFM tables', () => {
    const html = render(
      '# 结果\n\n**重点**与 `代码`\n\n- 第一项\n- 第二项\n\n> 引用\n\n```js\nconst value = "<safe>";\n```\n\n| 名称 | 数量 |\n| --- | --- |\n| 手机 | 2 |',
    );
    for (const tag of ['h1', 'strong', 'code', 'ul', 'li', 'blockquote', 'pre', 'table', 'th', 'td'])
      expect(html).toContain(`<${tag}`);
    expect(html).toContain('&lt;safe&gt;');
    expect(html).not.toContain('```');
    expect(html).toContain('复制代码');
    expect(html).toContain('<section class="markdown-table" aria-label="表格"');
  });

  it('renders an unfinished streaming fence and updates it to the final code block', () => {
    expect(render('```ts\nconst value =')).toContain('const value =');
    expect(render('```ts\nconst value = 1;\n```')).toContain('const value = 1;');
    expect(render('')).toBe('<div class="chat-markdown"></div>');
  });

  it('never inserts raw HTML, executable URLs or automatically fetched images', () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src="https://tracker.invalid/pixel">\n\n[危险](javascript:alert%281%29) [设备](swiftnest:pair) [文件](file:///etc/passwd)\n\n![图示](https://images.invalid/chart.png)',
    );
    expect(html).not.toMatch(/<script|<img|javascript:|swiftnest:|file:\/\//);
    expect(html).toContain('href="https://images.invalid/chart.png"');
    expect(html).toContain('图示');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('keeps HTTPS and email links explicit and removes unsafe data and relative destinations', () => {
    const html = render(
      '[网站](https://example.com/?q=%E6%89%8B%E6%9C%BA) [邮件](mailto:test@example.com) [本地](/connect) ![图片](data:image/svg+xml,evil)',
    );
    expect(html).toContain('href="https://example.com/');
    expect(html).toContain('href="mailto:test@example.com"');
    expect(html).not.toContain('href="/connect"');
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('<img');
  });
});
