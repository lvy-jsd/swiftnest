import { FolderIcon, XIcon } from '@phosphor-icons/react';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { ListRow } from '../components/ListRow';
import { useI18n } from '../i18n';
import { PhonePermissions } from './PhonePermissions';
import { native, type ThisDeviceState } from './useThisDevice';

type Props = { state: ThisDeviceState };

function WatchingNotice({ state }: Props) {
  const { t } = useI18n();
  if (!state.snapshot.watching) return null;
  return (
    <div role="status" className="desktop-watching">
      <p>{t(state.snapshot.ownerControl ? 'desktopControlled' : 'desktopWatching')}</p>
      <Button
        variant="danger"
        disabled={state.busy}
        onClick={() =>
          void state.act(async () => {
            await native('perch_stop_view');
            state.setDraft((previous) => (previous ? { ...previous, allowLiveView: false } : previous));
          })
        }
      >
        {t('stopLiveView')}
      </Button>
    </div>
  );
}

export function SharingSettings({ state }: Props) {
  const { t } = useI18n();
  return (
    <div className="this-device-group">
      <ListRow
        title={t(state.phone ? 'letIvyUsePhone' : 'letIvyControl')}
        value={
          <input
            type="checkbox"
            aria-label={t(state.phone ? 'letIvyUsePhone' : 'letIvyControl')}
            checked={state.snapshot.settings.enabled}
            disabled={state.busy || (!state.snapshot.settings.enabled && (!state.foldersReady || !state.draft.url))}
            onChange={(event) => {
              if (event.target.checked) void state.save({ ...state.draft, enabled: true });
              else
                void state.act(async () => {
                  await native('perch_disable');
                  state.setDraft((previous) => (previous ? { ...previous, enabled: false } : previous));
                });
            }}
          />
        }
      />
      {state.phone ? (
        <PhonePermissions />
      ) : (
        <ListRow
          title={t('allowLiveView')}
          subtitle={t('allowLiveViewHelp')}
          value={
            <input
              type="checkbox"
              aria-label={t('allowLiveView')}
              checked={!!state.draft.allowLiveView}
              disabled={state.busy}
              onChange={(event) => void state.save({ ...state.draft, allowLiveView: event.target.checked })}
            />
          }
        />
      )}
      <WatchingNotice state={state} />
    </div>
  );
}

export function SharedFolders({ state }: Props) {
  const { t } = useI18n();
  if (state.phone) return <p>{t('phoneFilesHelp')}</p>;
  const add = () =>
    void state.act(async () => {
      const paths = await native<string[]>('perch_pick_folders');
      state.setDraft((previous) =>
        previous ? { ...previous, roots: [...new Set([...previous.roots, ...paths])] } : previous,
      );
    });
  return (
    <section className="this-device-group" aria-label={t('sharedFolders')}>
      <h3>{t('sharedFolders')}</h3>
      <p>{t('sharedFoldersHelp')}</p>
      {!state.draft.roots.length && <p>{t('noSharedFolders')}</p>}
      {state.draft.roots.map((path) => (
        <ListRow
          key={path}
          className="shared-folder"
          icon={<FolderIcon size={24} />}
          title={path}
          value={
            <IconButton
              variant="ghost"
              disabled={state.busy}
              aria-label={`${t('removeFolder')}: ${path}`}
              onClick={() => state.setDraft({ ...state.draft, roots: state.draft.roots.filter((p) => p !== path) })}
            >
              <XIcon size={20} />
            </IconButton>
          }
        />
      ))}
      <Button variant="soft" disabled={state.busy} onClick={add}>
        {t('addSharedFolder')}
      </Button>
      <ListRow
        title={t('keepBackground')}
        subtitle={t('backgroundHelp')}
        value={
          <input
            type="checkbox"
            aria-label={t('keepBackground')}
            checked={state.draft.background}
            disabled={state.busy}
            onChange={(event) => state.setDraft({ ...state.draft, background: event.target.checked })}
          />
        }
      />
    </section>
  );
}

export function ConnectionSettings({ state }: Props) {
  const { t } = useI18n();
  return (
    <details className="device-details">
      <summary>{t('devicesAdvanced')}</summary>
      <label className="field">
        {t('deviceServerAddress')}
        <input
          type="url"
          value={state.draft.url}
          onChange={(event) => state.setDraft({ ...state.draft, url: event.target.value })}
        />
      </label>
      <p>{t('deviceAddressHelp')}</p>
      <ListRow title={t('deviceFingerprint')} subtitle={state.snapshot.fingerprint} />
    </details>
  );
}
