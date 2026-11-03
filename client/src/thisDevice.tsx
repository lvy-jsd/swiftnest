import { localizedError, type Text } from '@swiftnest/api';
import { useEffect, useState } from 'react';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import type { StringKey } from './i18n';
import { isTauriRuntime } from './runtime';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { SheetPage } from './components/pages';

export type PerchSettings = {
  name: string;
  slug: string;
  enabled: boolean;
  background: boolean;
  allowLiveView?: boolean;
  roots: string[];
  url: string;
  nestKey: string | null;
};
export type PerchSnapshot = {
  settings: PerchSettings;
  phase: string;
  fingerprint: string;
  nestFingerprint: string | null;
  confirmationPending: boolean;
  /** English prose plus catalog text, rendered in the App's language. */
  error: { code: string; message: string; text?: Text } | null;
  platform: 'desktop' | 'android' | 'ios';
  watching?: boolean;
  ownerControl?: boolean;
};
export function perchAddress(root: string): string {
  try {
    const url = new URL(root);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.port = '7711';
    url.pathname = '/swiftnest';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}
async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}
type PhoneStatus = { accessibility: boolean; notifications: boolean };

/** Android: the two system permissions phone tools depend on, each with a shortcut to its settings page. */
function PhonePermissions() {
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
    <div className="field-groups">
      <h3>{t('phonePermissions')}</h3>
      {rows.map((row) => (
        <div key={row.kind}>
          <p>
            <strong>{t(row.label)}</strong> · {t(status?.[row.kind] ? 'permissionOn' : 'permissionOff')}
          </p>
          <p>{t(row.help)}</p>
          <Button onClick={() => void native('phone_open_settings', { kind: row.kind })}>
            {t('openSystemSettings')}
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Loaded only by the native runtime: desktop shares folders and the screen, Android shares the phone. */
export function ThisDevice() {
  const { t, locale } = useI18n();
  const { root } = useConnection();
  const [snapshot, setSnapshot] = useState<PerchSnapshot>();
  const [draft, setDraft] = useState<PerchSettings>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  /** What the last native call threw, if it failed. */
  const [failure, setFailure] = useState<{ error: unknown }>();
  const [unpair, setUnpair] = useState(false);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const read = async () => {
      try {
        const value = await native<PerchSnapshot>('perch_snapshot');
        if (disposed) return;
        setSnapshot(value);
        setDraft((previous) => previous ?? { ...value.settings, url: value.settings.url || perchAddress(root) });
      } catch (error) {
        if (!disposed) setFailure({ error });
      }
    };
    void read();
    const timer = setInterval(() => void read(), 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [root]);
  if (!snapshot || !draft || snapshot.platform === 'ios') return null;
  const phone = snapshot.platform === 'android';
  const shownFailure = failure?.error ?? snapshot.error;
  // Desktop needs shared folders before it can be enabled; the phone uses the App's own folder.
  const foldersReady = phone || draft.roots.length > 0;
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await action();
      setSnapshot(await native<PerchSnapshot>('perch_snapshot'));
    } catch (error) {
      setFailure({ error });
    } finally {
      setBusy(false);
    }
  };
  const save = (settings = draft, pairingCode?: string) =>
    act(async () => {
      const value = await native<PerchSnapshot>('perch_configure', { settings, code: pairingCode ?? null });
      setSnapshot(value);
      setDraft(value.settings);
      if (pairingCode) setCode('');
    });
  const phase =
    snapshot.phase === 'online'
      ? 'online'
      : snapshot.phase === 'connecting'
        ? 'connecting'
        : snapshot.phase === 'confirming'
          ? 'confirmDevice'
          : snapshot.phase === 'offline'
            ? 'offline'
            : 'deviceStopped';
  return (
    <Card className="device-card this-device" aria-label={t('thisDevice')}>
      <h2>{t('thisDevice')}</h2>
      <p>{t(phone ? 'thisPhoneHelp' : 'thisDeviceHelp')}</p>
      <label className="switch-field">
        {t(phone ? 'letIvyUsePhone' : 'letIvyControl')}
        <input
          type="checkbox"
          checked={snapshot.settings.enabled}
          disabled={busy || (!snapshot.settings.enabled && (!foldersReady || !draft.url))}
          onChange={(event) => {
            if (event.target.checked) void save({ ...draft, enabled: true });
            else
              void act(async () => {
                await native('perch_disable');
                setDraft((previous) => (previous ? { ...previous, enabled: false } : previous));
              });
          }}
        />
      </label>
      {phone ? (
        <PhonePermissions />
      ) : (
        <>
          <label className="switch-field">
            {t('allowLiveView')}
            <input
              type="checkbox"
              checked={!!draft.allowLiveView}
              disabled={busy}
              onChange={(event) => void save({ ...draft, allowLiveView: event.target.checked })}
            />
          </label>
          <p>{t('allowLiveViewHelp')}</p>
        </>
      )}
      {snapshot.watching && (
        <div role="status" className="desktop-watching">
          <p>{t(snapshot.ownerControl ? 'desktopControlled' : 'desktopWatching')}</p>
          <Button
            onClick={() =>
              void act(async () => {
                await native('perch_stop_view');
                setDraft((previous) => (previous ? { ...previous, allowLiveView: false } : previous));
              })
            }
          >
            {t('stopLiveView')}
          </Button>
        </div>
      )}
      <p role="status" className={snapshot.phase === 'online' ? 'device-online' : undefined}>
        {t(phase)}
      </p>
      {shownFailure && (
        <p role="alert">
          {t('deviceActionFailed')} {localizedError(shownFailure, locale).message}
        </p>
      )}
      <label className="field">
        {t('deviceDisplayName')}
        <input
          value={draft.name}
          maxLength={128}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label className="field">
        {t('deviceServerAddress')}
        <input
          type="url"
          value={draft.url}
          placeholder="ws://server:7711/swiftnest"
          onChange={(event) => setDraft({ ...draft, url: event.target.value })}
        />
      </label>
      <p>{t('deviceAddressHelp')}</p>
      {!phone && (
        <>
          <h3>{t('sharedFolders')}</h3>
          <p>{t('sharedFoldersHelp')}</p>
          {draft.roots.length === 0 && <p>{t('noSharedFolders')}</p>}
          {draft.roots.map((path) => (
            <div className="device-actions" key={path}>
              <code className="shared-folder">{path}</code>
              <Button
                disabled={busy}
                aria-label={`${t('removeFolder')}: ${path}`}
                onClick={() => setDraft({ ...draft, roots: draft.roots.filter((p) => p !== path) })}
              >
                {t('removeFolder')}
              </Button>
            </div>
          ))}
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const paths = await native<string[]>('perch_pick_folders');
                setDraft((previous) =>
                  previous ? { ...previous, roots: [...new Set([...previous.roots, ...paths])] } : previous,
                );
              })
            }
          >
            {t('addSharedFolder')}
          </Button>
          <label className="switch-field">
            {t('keepBackground')}
            <input
              type="checkbox"
              checked={draft.background}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, background: event.target.checked })}
            />
          </label>
          <p>{t('backgroundHelp')}</p>
        </>
      )}
      {phone && <p>{t('phoneFilesHelp')}</p>}
      <Button disabled={busy || !draft.name.trim() || (draft.enabled && !foldersReady)} onClick={() => void save()}>
        {t('save')}
      </Button>
      <p>
        {t('deviceFingerprint')}: <code>{snapshot.fingerprint}</code>
      </p>
      {!snapshot.settings.nestKey && (
        <>
          <p>{t('devicePairHelp')}</p>
          <label className="field">
            {t('pairingCode')}
            <input
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              pattern="[0-9]{6}"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
          </label>
          <Button
            variant="primary"
            disabled={busy || !foldersReady || !draft.url || !/^\d{6}$/.test(code) || snapshot.phase === 'confirming'}
            onClick={() => void save({ ...draft, enabled: true }, code)}
          >
            {t(phone ? 'pairThisPhone' : 'pairThisDevice')}
          </Button>
        </>
      )}
      {snapshot.nestFingerprint && (
        <div className="field-groups">
          <p>
            {t('nestFingerprint')}: <code>{snapshot.nestFingerprint}</code>
          </p>
          <p>{t('compareFingerprints')}</p>
          {snapshot.confirmationPending ? (
            <div className="device-actions">
              <Button disabled={busy} onClick={() => void act(() => native('perch_confirm', { accept: false }))}>
                {t('deny')}
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void act(() => native('perch_confirm', { accept: true }))}
              >
                {t('fingerprintMatches')}
              </Button>
            </div>
          ) : (
            <p>{t('waitingServerConfirm')}</p>
          )}
        </div>
      )}
      {snapshot.settings.nestKey && (
        <Button disabled={busy} onClick={() => setUnpair(true)}>
          {t(phone ? 'unpairThisPhone' : 'unpairThisDevice')}
        </Button>
      )}
      <SheetPage
        open={unpair}
        title={t(phone ? 'unpairThisPhone' : 'unpairThisDevice')}
        onClose={() => setUnpair(false)}
        actions={
          <>
            <Button onClick={() => setUnpair(false)}>{t('cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const value = await native<PerchSnapshot>('perch_unpair');
                  setDraft(value.settings);
                  setUnpair(false);
                })
              }
            >
              {t(phone ? 'unpairThisPhone' : 'unpairThisDevice')}
            </Button>
          </>
        }
      >
        <p>{t(phone ? 'unpairThisPhoneHelp' : 'unpairThisDeviceHelp')}</p>
      </SheetPage>
    </Card>
  );
}
