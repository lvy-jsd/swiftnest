import { useEffect, useState } from 'react';
import { useI18n, type StringKey } from '../i18n';
import { Button } from '../components/Button';
import { Pill } from '../components/Pill';
import { ListRow } from '../components/ListRow';
import { native } from './useThisDevice';

type PhoneStatus = { accessibility: boolean; notifications: boolean };

/** Android: the two system permissions phone tools depend on, each with a shortcut to its settings page. */
export function PhonePermissions() {
  const { t } = useI18n();
  const [status, setStatus] = useState<PhoneStatus>();
  useEffect(() => {
    let disposed = false;
    const read = async () => {
      try {
        const value = await native<PhoneStatus>('phone_status');
        if (!disposed) setStatus(value);
      } catch {
        /* The next poll retries. */
      }
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  const rows: { kind: keyof PhoneStatus; label: StringKey; help: StringKey }[] = [
    { kind: 'accessibility', label: 'phoneAccessibility', help: 'phoneAccessibilityHelp' },
    { kind: 'notifications', label: 'phoneNotificationAccess', help: 'phoneNotificationAccessHelp' },
  ];
  return (
    <div className="this-device-permissions">
      <h3>{t('phonePermissions')}</h3>
      {rows.map((row) => (
        <ListRow
          key={row.kind}
          title={t(row.label)}
          subtitle={t(row.help)}
          value={
            <div className="permission-actions">
              {status && (
                <Pill dot tone={status?.[row.kind] ? 'success' : 'neutral'}>
                  {t(status?.[row.kind] ? 'permissionOn' : 'permissionOff')}
                </Pill>
              )}
              <Button variant="soft" onClick={() => void native('phone_open_settings', { kind: row.kind })}>
                {t('openSystemSettings')}
              </Button>
            </div>
          }
        />
      ))}
    </div>
  );
}
