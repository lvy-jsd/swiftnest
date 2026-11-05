import { DesktopIcon, DeviceMobileIcon } from '@phosphor-icons/react';
import { localizedError } from '@swiftnest/api';
import { useI18n } from './i18n';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { Pill } from './components/Pill';
import { useThisDevice, type ThisDeviceState } from './devices/useThisDevice';
import { SharingSettings, SharedFolders, ConnectionSettings } from './devices/ThisDeviceSettings';
import { ThisDevicePairing } from './devices/ThisDevicePairing';
export { perchAddress, type PerchSettings, type PerchSnapshot } from './devices/useThisDevice';

/** Only the native runtime supplies this consent and configuration surface. */
export function ThisDevice() {
  const state = useThisDevice();
  if (!state.snapshot || !state.draft || state.snapshot.platform === 'ios') return null;
  return <ThisDeviceCard state={state as ThisDeviceState} />;
}

function ThisDeviceHeader({ state }: { state: ThisDeviceState }) {
  const { t } = useI18n();
  const phase = state.snapshot.phase;
  const label =
    phase === 'online'
      ? 'online'
      : phase === 'connecting'
        ? 'connecting'
        : phase === 'confirming'
          ? 'confirmDevice'
          : phase === 'offline'
            ? 'offline'
            : 'deviceStopped';
  const Icon = state.phone ? DeviceMobileIcon : DesktopIcon;
  return (
    <header className="device-card-header">
      <Icon size={32} aria-hidden="true" />
      <div>
        <h2>{t('thisDevice')}</h2>
        <p>{t(state.phone ? 'thisPhoneHelp' : 'thisDeviceHelp')}</p>
      </div>
      <Pill
        dot
        role="status"
        tone={
          state.snapshot.watching
            ? 'accent'
            : phase === 'online'
              ? 'success'
              : phase === 'confirming'
                ? 'waiting'
                : 'neutral'
        }
      >
        {t(label)}
      </Pill>
    </header>
  );
}

function ThisDeviceCard({ state }: { state: ThisDeviceState }) {
  const { t, locale } = useI18n();
  return (
    <Card className="device-card this-device" aria-label={t('thisDevice')}>
      <ThisDeviceHeader state={state} />
      {state.shownFailure && (
        <p role="alert">
          {t('deviceActionFailed')} {localizedError(state.shownFailure, locale).message}
        </p>
      )}
      <SharingSettings state={state} />
      <label className="field">
        {t('deviceDisplayName')}
        <input
          value={state.draft.name}
          maxLength={128}
          onChange={(event) => state.setDraft({ ...state.draft, name: event.target.value })}
        />
      </label>
      <SharedFolders state={state} />
      <ConnectionSettings state={state} />
      <div className="device-actions">
        <Button
          variant="primary"
          disabled={state.busy || !state.draft.name.trim() || (state.draft.enabled && !state.foldersReady)}
          onClick={() => void state.save()}
        >
          {t('save')}
        </Button>
      </div>
      <ThisDevicePairing state={state} />
    </Card>
  );
}
