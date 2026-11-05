import type { ApprovalSettings } from '@swiftnest/api';
import { useConnection } from './connection';
import { useApprovalInbox } from './inboxState';
import { useI18n } from './i18n';

export function ApprovalSettingsFields() {
  const { inbox, busy, act } = useApprovalInbox();
  const { store } = useConnection();
  const { t } = useI18n();
  if (!inbox) return null;
  const settings = inbox.settings;
  const save = (next: ApprovalSettings) => void act(() => store.client!.updateApprovalSettings(next));
  return (
    <fieldset disabled={busy}>
      <legend>{t('inboxTitle')}</legend>
      <label className="switch-field">
        <span>{t('inboxRemind')}</span>
        <input
          type="checkbox"
          role="switch"
          checked={settings.remind}
          aria-checked={settings.remind}
          onChange={(event) => save({ ...settings, remind: event.target.checked })}
        />
      </label>
      <details className="event-card">
        <summary>{t('inboxAdvanced')}</summary>
        <label className="switch-field">
          <span>{t('inboxAutoAllow')}</span>
          <input
            type="checkbox"
            role="switch"
            checked={settings.autoAllowLowRisk}
            aria-checked={settings.autoAllowLowRisk}
            onChange={(event) => save({ ...settings, autoAllowLowRisk: event.target.checked })}
          />
        </label>
        <TimeoutFields settings={settings} save={save} />
      </details>
    </fieldset>
  );
}

function TimeoutFields({ settings, save }: { settings: ApprovalSettings; save: (next: ApprovalSettings) => void }) {
  const { t } = useI18n();
  return (
    <>
      <p>{t('inboxTimeoutHelp')}</p>
      {(['dsh', 'device', 'transfer'] as const).map((kind) => (
        <label className="field" key={kind}>
          <span>
            {t(kind === 'dsh' ? 'inboxChatTimeout' : kind === 'device' ? 'inboxDeviceTimeout' : 'inboxTransferTimeout')}
          </span>
          <input
            type="number"
            required
            min={1}
            max={86400}
            step={1}
            defaultValue={settings.timeouts[kind] / 1000}
            key={settings.timeouts[kind]}
            onBlur={(event) => {
              if (event.target.checkValidity())
                save({ ...settings, timeouts: { ...settings.timeouts, [kind]: Number(event.target.value) * 1000 } });
              else event.target.value = String(settings.timeouts[kind] / 1000);
            }}
          />
        </label>
      ))}
    </>
  );
}
