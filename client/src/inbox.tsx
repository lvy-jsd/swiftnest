import type { ApprovalItem } from '@swiftnest/api';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { DetailPage } from './components/pages';
import { VirtualList } from './components/VirtualList';
import { useConnection } from './connection';
import { useApprovalInbox } from './inboxState';
import { useI18n } from './i18n';

export function ApprovalBadge() {
  const { inbox } = useApprovalInbox();
  const { t } = useI18n();
  return (
    <a
      className="inbox-badge button button--ghost"
      href="#/approvals"
      aria-label={t('inboxPendingCount').replace('{count}', String(inbox?.items.length ?? 0))}
    >
      {t('inboxTitle')} · {inbox?.items.length ?? 0}
    </a>
  );
}
export function InboxApproval({ item }: { item: ApprovalItem }) {
  const { t, locale } = useI18n();
  const { store, status } = useConnection();
  const { busy, act, error } = useApprovalInbox();
  const answer = (allowed: boolean) => void act(() => store.client!.answerInboxApproval(item.id, allowed));
  return (
    <Card className="device-card approval-card" aria-label={t('toolApproval')}>
      <strong>{item.requester}</strong>
      <p>
        <code>{item.tool}</code>
      </p>
      <p>{item.displayReason?.[locale] ?? item.summary}</p>
      <details>
        <summary>{t('inboxDetails')}</summary>
        <p>
          {t('requestedBy')}: {item.requester} · {item.device}
        </p>
        <p>
          {t('risk')}: {t(item.risk)}
        </p>
        <p>
          {t('inboxExpires')}: <time dateTime={item.expiresAt}>{new Date(item.expiresAt).toLocaleString(locale)}</time>
        </p>
        <pre>{JSON.stringify(item.args, null, 2)}</pre>
      </details>
      <div className="device-actions">
        <Button disabled={busy || status !== 'connected'} onClick={() => answer(false)}>
          {t('deny')}
        </Button>
        <Button variant="primary" disabled={busy || status !== 'connected'} onClick={() => answer(true)}>
          {t('approve')}
        </Button>
      </div>
      {error && <p role="alert">{t('toolApprovalFailed')}</p>}
    </Card>
  );
}
export function InboxList({ items, className = 'card-groups' }: { items: ApprovalItem[]; className?: string }) {
  const { t } = useI18n();
  return (
    <VirtualList
      className={className}
      items={items}
      itemKey={(item) => item.id}
      label={t('inboxTitle')}
      renderItem={(item) => <InboxApproval item={item} />}
    />
  );
}
export function ApprovalInboxPage({ onBack }: { onBack: () => void }) {
  const { inbox, error } = useApprovalInbox();
  const { t } = useI18n();
  return (
    <DetailPage title={t('inboxTitle')} onBack={onBack}>
      {error && <p role="alert">{t('toolApprovalFailed')}</p>}
      {inbox && !inbox.items.length && <p>{t('inboxEmpty')}</p>}
      <InboxList items={inbox?.items ?? []} className="page__body card-groups" />
    </DetailPage>
  );
}
