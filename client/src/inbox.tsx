import type { ApprovalItem } from '@swiftnest/api';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { ChatIcon } from './components/ChatIcon';
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
  const remaining = new Date(item.expiresAt).getTime() - Date.now();
  const expiry =
    remaining > 0
      ? t('inboxExpiresInMinutes').replace(
          '{minutes}',
          new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute', unitDisplay: 'long' }).format(
            Math.ceil(remaining / 60_000),
          ),
        )
      : t('inboxExpired');
  return (
    <Card className="device-card approval-card" aria-label={t('toolApproval')}>
      <header className="approval-card__header">
        <strong>{item.requester}</strong>
        <span className="approval-card__risk" data-risk={item.risk}>
          {t(item.risk)}
        </span>
      </header>
      <p className="approval-card__tool">
        <code>{item.tool}</code>
      </p>
      <p className="approval-card__reason">{item.displayReason?.[locale] ?? item.summary}</p>
      <p className="approval-card__metadata">
        {item.requester} · {item.device}
      </p>
      <p className="approval-card__expiry">
        <ChatIcon name="clock" />
        <time dateTime={item.expiresAt} title={new Date(item.expiresAt).toLocaleString(locale)}>
          {expiry}
        </time>
      </p>
      <details>
        <summary>{t('inboxDetails')}</summary>
        <pre>{JSON.stringify(item.args, null, 2)}</pre>
      </details>
      <div className="device-actions approval-card__actions">
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
