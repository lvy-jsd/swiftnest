import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ApprovalItem } from '@swiftnest/api';
import { I18nProvider, translate } from '../src/i18n';
import { ConnectionProvider } from '../src/connection';
import { ApprovalInboxProvider } from '../src/inboxState';
import { InboxApproval } from '../src/inbox';

it.each(['en', 'zh-CN'] as const)(
  'renders escaped approval details in %s and cannot answer while disconnected',
  (locale) => {
    const item: ApprovalItem = {
      id: 'test',
      kind: 'dsh',
      requester: '<script>requester</script>',
      summary: 'fallback',
      displayReason: { en: 'Read the report?', 'zh-CN': '允许读取报告吗？' },
      risk: 'sensitive',
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      state: 'pending',
      args: { path: '<private>' },
      tool: 'read',
      device: 'test',
    };
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale={locale}>
        <ConnectionProvider>
          <ApprovalInboxProvider>
            <InboxApproval item={item} />
          </ApprovalInboxProvider>
        </ConnectionProvider>
      </I18nProvider>,
    );
    expect(html).toContain(item.displayReason![locale]);
    expect(html).toContain(translate(locale, 'inboxDetails'));
    expect(html).toContain('&lt;script&gt;requester&lt;/script&gt;');
    expect(html).toContain('&lt;private&gt;');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain('<details open');
    // The owner sees which tool is asking without opening the details fold-out.
    expect(html.split('<details')[0]).toContain('<code>read</code>');
  },
);
