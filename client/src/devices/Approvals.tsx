import { localizedReason, type DeviceApproval } from '@swiftnest/api';
import { useState } from 'react';
import { useConnection } from '../connection';
import { useI18n } from '../i18n';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { SheetPage } from '../components/pages';
import { VirtualList } from '../components/VirtualList';
import { useDevices } from './hub';

function ApprovalDetails({ approval }: { approval: DeviceApproval }) {
  const { t, locale } = useI18n();
  return (
    <>
      <p>
        <strong>
          {approval.device} · {approval.capability}.{approval.tool}
        </strong>
      </p>
      <p>
        {t('requestedBy')}: {approval.client.name ?? approval.client.id}
      </p>
      <p>
        {t('risk')}: {t(approval.risk)} · {approval.reason && localizedReason(approval, locale)}
      </p>
      <pre>{JSON.stringify(approval.args, null, 2)}</pre>
    </>
  );
}

function ApprovalList({
  compact,
  onSelect,
  onAnswer,
}: {
  compact: boolean;
  onSelect: (id: string) => void;
  onAnswer: (approval: DeviceApproval, accept: boolean) => void;
}) {
  const { approvals, busy } = useDevices();
  const { t } = useI18n();
  if (!approvals.length) return null;
  return (
    <>
      {compact ? (
        approvals.length > 0 && (
          <div className="approval-banner" role="status">
            <Button onClick={() => onSelect(approvals[0]!.id)}>
              {t('pendingApprovals')} · {approvals.length}
            </Button>
            <a href="#/devices">{t('devices')}</a>
          </div>
        )
      ) : (
        <>
          {approvals.length > 0 && <h2>{t('pendingApprovals')}</h2>}
          <VirtualList
            items={approvals}
            itemKey={(approval) => approval.id}
            label={t('pendingApprovals')}
            renderItem={(approval) => (
              <Card className="device-card approval-card">
                <ApprovalDetails approval={approval} />
                <div className="device-actions">
                  <Button disabled={busy} onClick={() => onAnswer(approval, false)}>
                    {t('deny')}
                  </Button>
                  <Button disabled={busy} onClick={() => onSelect(approval.id)}>
                    {t('reviewApproval')}
                  </Button>
                </div>
              </Card>
            )}
          />
        </>
      )}
    </>
  );
}

export function DeviceApprovals({ compact = false }: { compact?: boolean }) {
  const { approvals, error, busy, act } = useDevices();
  const { store } = useConnection();
  const { t } = useI18n();
  const [selected, setSelected] = useState<string>();
  const approval = approvals.find((approval) => approval.id === selected);
  const answer = (approval: DeviceApproval, accept: boolean) =>
    void act(() => store.client!.answerDeviceApproval(approval.id, accept));
  return (
    <>
      {error && <p role="alert">{t('devicesFailed')}</p>}
      <ApprovalList compact={compact} onSelect={setSelected} onAnswer={answer} />
      <SheetPage
        open={!!approval}
        title={t('reviewApproval')}
        onClose={() => setSelected(undefined)}
        actions={
          <>
            <Button disabled={busy} onClick={() => approval && answer(approval, false)}>
              {t('deny')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => approval && answer(approval, true)}>
              {t('approve')}
            </Button>
          </>
        }
      >
        {approval && <ApprovalDetails approval={approval} />}
      </SheetPage>
    </>
  );
}
