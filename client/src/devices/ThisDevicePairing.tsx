import { Button } from '../components/Button';
import { SheetPage } from '../components/pages';
import { useI18n } from '../i18n';
import { native, type PerchSnapshot, type ThisDeviceState } from './useThisDevice';

type Props = { state: ThisDeviceState };

function ConfirmServer({ state }: Props) {
  const { t } = useI18n();
  if (!state.snapshot.nestFingerprint) return null;
  return (
    <div className="pairing-request this-device-group">
      <p>{t('nestFingerprint')}</p>
      <code className="pairing-fingerprint">{state.snapshot.nestFingerprint}</code>
      <p>{t('compareFingerprints')}</p>
      {state.snapshot.confirmationPending ? (
        <div className="device-actions">
          <Button
            variant="primary"
            disabled={state.busy}
            onClick={() => void state.act(() => native('perch_confirm', { accept: true }))}
          >
            {t('fingerprintMatches')}
          </Button>
          <Button
            variant="ghost"
            disabled={state.busy}
            onClick={() => void state.act(() => native('perch_confirm', { accept: false }))}
          >
            {t('deny')}
          </Button>
        </div>
      ) : (
        <p>{t('waitingServerConfirm')}</p>
      )}
    </div>
  );
}

export function ThisDevicePairing({ state }: Props) {
  const { t } = useI18n();
  return (
    <>
      {!state.snapshot.settings.nestKey && (
        <div className="this-device-group">
          <p>{t('devicePairHelp')}</p>
          <label className="field">
            {t('pairingCode')}
            <input
              className="pairing-code-input"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              pattern="[0-9]{6}"
              value={state.code}
              onChange={(event) => state.setCode(event.target.value.replace(/\D/g, ''))}
            />
          </label>
          <Button
            variant="primary"
            disabled={
              state.busy ||
              !state.foldersReady ||
              !state.draft.url ||
              !/^\d{6}$/.test(state.code) ||
              state.snapshot.phase === 'confirming'
            }
            onClick={() => void state.save({ ...state.draft, enabled: true }, state.code)}
          >
            {t(state.phone ? 'pairThisPhone' : 'pairThisDevice')}
          </Button>
        </div>
      )}
      <ConfirmServer state={state} />
      {state.snapshot.settings.nestKey && (
        <Button variant="ghost" disabled={state.busy} onClick={() => state.setUnpair(true)}>
          {t(state.phone ? 'unpairThisPhone' : 'unpairThisDevice')}
        </Button>
      )}
      <UnpairDevice state={state} />
    </>
  );
}

function UnpairDevice({ state }: Props) {
  const { t } = useI18n();
  const title = t(state.phone ? 'unpairThisPhone' : 'unpairThisDevice');
  return (
    <SheetPage
      open={state.unpair}
      title={title}
      onClose={() => state.setUnpair(false)}
      actions={
        <>
          <Button onClick={() => state.setUnpair(false)}>{t('cancel')}</Button>
          <Button
            variant="danger"
            disabled={state.busy}
            onClick={() =>
              void state.act(async () => {
                await state.store.unpair();
                const value = await native<PerchSnapshot>('perch_unpair');
                state.setDraft(value.settings);
                state.setUnpair(false);
              })
            }
          >
            {title}
          </Button>
        </>
      }
    >
      <p>{t(state.phone ? 'unpairThisPhoneHelp' : 'unpairThisDeviceHelp')}</p>
    </SheetPage>
  );
}
