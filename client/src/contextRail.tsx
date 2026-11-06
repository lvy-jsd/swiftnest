import { useConnection } from './connection';
import { useDevices } from './devices';
import { useApprovalInbox } from './inboxState';
import { useI18n } from './i18n';

/** Read shared snapshots only: the shell providers own all network subscriptions. */
export function ContextRail() {
  const { sessions, status, error: connectionError } = useConnection();
  const { devices, error: deviceError } = useDevices();
  const { inbox, error: inboxError } = useApprovalInbox();
  const { t } = useI18n();
  const online = devices.filter((device) => device.online);
  // A connected hub with no device list is "none", not "unknown"; only a
  // broken or absent connection justifies the unavailable copy.
  const devicesKnown = status === 'connected' && !deviceError;
  const approvalsKnown = status === 'connected' && !inboxError && !!inbox;
  const approvals = approvalsKnown
    ? inbox.items.length
      ? t('inboxPendingCount').replace('{count}', String(inbox.items.length))
      : t('rail.nothingWaiting')
    : t('rail.unavailable');
  const updated = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const today = [
    ...updated.filter((session) => session.running === true),
    ...updated.filter((session) => !session.running).slice(0, 3),
  ];
  return (
    <aside className="context-rail" aria-label={t('rail.context')}>
      <section className="context-rail__card" aria-labelledby="rail-devices">
        <h2 id="rail-devices">{t('devices')}</h2>
        {devicesKnown ? (
          online.length ? (
            <>
              <p>{t('shell.devicesOnline').replace('{count}', String(online.length))}</p>
              <ul>
                {online.slice(0, 3).map((device) => (
                  <li key={device.device}>{device.name || device.device}</li>
                ))}
                {online.length > 3 && <li>+{online.length - 3}</li>}
              </ul>
            </>
          ) : (
            <p>{t('rail.noDevices')}</p>
          )
        ) : (
          <p>{t('rail.unavailable')}</p>
        )}
      </section>
      <section className="context-rail__card" aria-labelledby="rail-approvals">
        <h2 id="rail-approvals">{t('rail.waiting')}</h2>
        <a href="#/approvals" aria-label={`${t('rail.waiting')}: ${approvals}`}>
          {approvals}
        </a>
      </section>
      <section className="context-rail__card" aria-labelledby="rail-today">
        <h2 id="rail-today">{t('rail.today')}</h2>
        {status !== 'connected' || connectionError ? (
          <p>{t('rail.unavailable')}</p>
        ) : today.length ? (
          <ul>
            {today.map((session) => (
              <li key={session.sessionId}>
                <a href={`#/chats/${encodeURIComponent(session.sessionId)}`}>
                  <span>{session.title || t('untitledChat')}</span>
                  {session.running === true && (
                    <span className="context-rail__running">
                      <span className="status-dot" />
                      {t('shell.runningChats')}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('noChats')}</p>
        )}
      </section>
    </aside>
  );
}
