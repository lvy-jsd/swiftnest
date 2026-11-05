import { InboxList } from '../inbox';
import { useApprovalInbox } from '../inboxState';

/** The device page is another view of the shared inbox. */
export function DeviceApprovals() {
  const { inbox } = useApprovalInbox();
  return <InboxList items={inbox?.items.filter((item) => item.kind !== 'dsh') ?? []} />;
}
