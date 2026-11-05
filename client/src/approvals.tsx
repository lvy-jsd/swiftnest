import type { ChatRow } from './chat';
import { useApprovalInbox } from './inboxState';
import { InboxApproval } from './inbox';
import { useI18n } from './i18n';

/** Chat rows reference the shared pending entry; they never own a decision. */
export function ApprovalCard({ request }: { request: Extract<ChatRow, { kind: 'approval' }> }) {
  const { inbox } = useApprovalInbox();
  const { t } = useI18n();
  const item = inbox?.items.find((item) => item.id === request.requestId);
  if (item) return <InboxApproval item={item} />;
  return (
    <article className="event-card" aria-label={t('toolApproval')}>
      <strong>{t('toolApproval')}</strong>
      <p>{request.toolName}</p>
      <p>{t('toolApprovalSettled')}</p>
    </article>
  );
}
