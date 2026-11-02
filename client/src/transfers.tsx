import { translateMessage } from '@swiftnest/api';
import { useState } from 'react';
import type { Transfer } from '@swiftnest/api';
import { useDevices } from './devices';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { isTauriRuntime } from './runtime';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { HubPage, SheetPage } from './components/pages';
const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KiB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MiB`
        : `${(n / 1024 ** 3).toFixed(2)} GiB`;
const stateKey = {
  preparing: 'transferPreparing',
  approval: 'transferApproval',
  waiting: 'transferWaiting',
  running: 'transferRunning',
  paused: 'transferPaused',
  complete: 'transferComplete',
  failed: 'transferFailed',
  cancelled: 'transferCancelled',
} as const;
export function TransferCards({ compact = false }: { compact?: boolean }) {
  const { transfers, busy, act } = useDevices();
  const { store } = useConnection();
  const { t, locale } = useI18n();
  const rows = compact ? transfers.filter((r) => !['complete', 'cancelled'].includes(r.state)).slice(-3) : transfers;
  const action = (r: Transfer, a: 'pause' | 'resume' | 'cancel' | 'retry') =>
    void act(() => store.client!.transferAction(r.id, a));
  return (
    <section className={`transfer-list ${compact ? 'transfer-list--compact' : ''}`} aria-label={t('transfers')}>
      {!compact && !rows.length && <p>{t('transferEmpty')}</p>}
      {rows.map((r) => (
        <Card key={r.id} className="transfer-card">
          <strong>{r.name}</strong>
          <span role="status">{t(stateKey[r.state])}</span>
          <p>
            {r.source.device} → {r.destination.device} · {t(r.route === 'direct' ? 'transferDirect' : 'transferRelay')}
          </p>
          <progress aria-label={r.name} max={r.size || 1} value={r.state === 'complete' ? r.size || 1 : r.offset} />
          <p>
            {bytes(r.offset)} / {bytes(r.size)} · {bytes(r.speed)}/{t('seconds')} · {t('transferETA')}:{' '}
            {r.eta === null ? '—' : `${Math.ceil(r.eta)}${t('seconds')}`}
          </p>
          {r.error && r.state === 'failed' && (
            <p role="alert">
              {translateMessage(r.error, locale)}
              {r.failure && (
                <>
                  <br />
                  {translateMessage(r.failure.hint, locale)} ({r.failure.code})
                </>
              )}
            </p>
          )}
          <div className="device-actions">
            {['running', 'waiting', 'approval', 'preparing'].includes(r.state) && (
              <Button disabled={busy} onClick={() => action(r, 'pause')}>
                {t('transferPause')}
              </Button>
            )}
            {r.state === 'paused' && (
              <Button disabled={busy} onClick={() => action(r, 'resume')}>
                {t('transferResume')}
              </Button>
            )}
            {r.state === 'failed' && (
              <Button disabled={busy} onClick={() => action(r, 'retry')}>
                {t('transferRetry')}
              </Button>
            )}
            {!['complete', 'cancelled'].includes(r.state) && (
              <Button disabled={busy} onClick={() => action(r, 'cancel')}>
                {t('cancel')}
              </Button>
            )}
            {compact && <a href="#/transfers">{t('transfers')}</a>}
          </div>
        </Card>
      ))}
    </section>
  );
}
export function SendFile({ source }: { source?: string }) {
  const { devices, busy, act } = useDevices();
  const { store, status } = useConnection();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(source ?? 'server');
  const [to, setTo] = useState(source ? 'server' : (devices[0]?.slug ?? 'server'));
  const [path, setPath] = useState('');
  const [target, setTarget] = useState('');
  const choices = (
    <>
      <option value="server">{t('transferServer')}</option>
      {devices
        .filter((d) => d.paired && d.slug)
        .map((d) => (
          <option key={d.slug} value={d.slug}>
            {d.name ?? d.slug}
          </option>
        ))}
    </>
  );
  return (
    <>
      <Button
        disabled={status !== 'connected'}
        onClick={() => {
          setFrom(source ?? 'server');
          setTo(source ? 'server' : (devices[0]?.slug ?? 'server'));
          setOpen(true);
        }}
      >
        {t('sendFileTo')}
      </Button>
      <SheetPage
        open={open}
        title={t('sendFileTo')}
        onClose={() => setOpen(false)}
        actions={
          <Button
            variant="primary"
            disabled={busy || !path || !target || from === to}
            onClick={() =>
              void act(() =>
                store.client!.startTransfer({
                  source: { device: from, path },
                  destination: { device: to, path: target },
                }),
              ).then((ok) => {
                if (ok) {
                  setOpen(false);
                  window.location.hash = '/transfers';
                }
              })
            }
          >
            {t('transferStart')}
          </Button>
        }
      >
        <p>{t('transferHelp')}</p>
        <label className="field">
          {t('transferSource')}
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {choices}
          </select>
        </label>
        <label className="field">
          {t('transferPath')}
          <input value={path} onChange={(e) => setPath(e.target.value)} />
        </label>
        {isTauriRuntime() && (
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const { invoke } = await import('@tauri-apps/api/core');
                const file = await invoke<string | null>('perch_pick_file');
                if (!file) return;
                const snapshot = await invoke<{ settings: { slug: string } }>('perch_snapshot');
                const self = devices.find((d) => d.device === snapshot.settings.slug);
                if (self?.slug) setFrom(self.slug);
                setPath(file);
              })
            }
          >
            {t('transferPick')}
          </Button>
        )}
        <label className="field">
          {t('transferDestination')}
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {choices}
          </select>
        </label>
        <label className="field">
          {t('transferPath')}
          <input value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
      </SheetPage>
    </>
  );
}
export function TransfersPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  return (
    <HubPage title={t('transfers')} subtitle={t('transferHelp')} onBack={onBack}>
      <SendFile />
      <TransferCards />
    </HubPage>
  );
}
