import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import type { Device, DeviceApproval, DevicePairing, DevicePairingCandidate } from '@swiftnest/api';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { HubPage, SheetPage } from './components/pages';
import { ThisDevice } from './thisDevice';
import { VirtualList } from './components/VirtualList';

type Hub = {
  devices: Device[]; approvals: DeviceApproval[]; candidates: DevicePairingCandidate[];
  error: boolean; busy: boolean;
  act: (action: () => Promise<unknown>) => Promise<boolean>;
};
const Context = createContext<Hub | null>(null);
export function DeviceHubProvider({ children }: PropsWithChildren) {
  const { store, status } = useConnection();
  const client = status === 'connected' ? store.client : undefined;
  const [devices, setDevices] = useState<Device[]>([]);
  const [approvals, setApprovals] = useState<DeviceApproval[]>([]);
  const [candidates, setCandidates] = useState<DevicePairingCandidate[]>([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    if (!client) return;
    const version = ++refreshVersion.current;
    const [d, a, p] = await Promise.all([client.listDevices(), client.listDeviceApprovals(), client.listDevicePairings()]);
    if (store.client !== client || version !== refreshVersion.current) return;
    await store.updateDeviceContext(d);
    if (store.client !== client || version !== refreshVersion.current) return;
    setDevices(d); setApprovals(a); setCandidates(p); setError(false);
  }, [client, store]);
  useEffect(() => {
    setDevices([]); setApprovals([]); setCandidates([]); setError(false);
    if (!client) return;
    const abort = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    const sync = () => refresh().catch(() => { if (!abort.signal.aborted) setError(true); });
    // Periodic snapshots also recover expired pairing candidates or a dropped push.
    const poll = setInterval(() => void sync(), 15_000);
    void sync();
    async function watch() {
      try {
        const stream = await client!.watchDevices({ signal: abort.signal });
        await sync();
        for await (const _ of stream) { if (abort.signal.aborted) break; await sync(); }
      } catch { if (!abort.signal.aborted) setError(true); }
      if (!abort.signal.aborted) retry = setTimeout(() => void watch(), 1500);
    }
    void watch();
    return () => { abort.abort(); clearInterval(poll); clearTimeout(retry); };
  }, [client, refresh]);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); await refresh(); return true; }
    catch { if (store.client === client) setError(true); return false; }
    finally { setBusy(false); }
  };
  return <Context value={{ devices, approvals, candidates, error, busy, act }}>{children}</Context>;
}
function useDevices() { const value = useContext(Context); if (!value) throw new Error('DeviceHubProvider required'); return value; }

export function DeviceApprovals({ compact = false }: { compact?: boolean }) {
  const { approvals, error, busy, act } = useDevices();
  const { store } = useConnection();
  const { t } = useI18n();
  const [selected, setSelected] = useState<string>();
  const approval = approvals.find(a => a.id === selected);
  const answer = (a: DeviceApproval, accept: boolean) => void act(() => store.client!.answerDeviceApproval(a.id, accept));
  const details = (a: DeviceApproval) => <>
    <p><strong>{a.device} · {a.capability}.{a.tool}</strong></p>
    <p>{t('requestedBy')}: {a.client.name ?? a.client.id}</p>
    <p>{t('risk')}: {t(a.risk)} · {a.reason}</p>
    <pre>{JSON.stringify(a.args, null, 2)}</pre>
  </>;
  return <>
    {error && <p role="alert">{t('devicesFailed')}</p>}
    {compact ? approvals.length > 0 && <div className="approval-banner" role="status"><Button onClick={() => setSelected(approvals[0]!.id)}>{t('pendingApprovals')} · {approvals.length}</Button><a href="#/devices">{t('devices')}</a></div> : <>
      {approvals.length > 0 && <h2>{t('pendingApprovals')}</h2>}
      <VirtualList items={approvals} itemKey={a => a.id} label={t('pendingApprovals')} renderItem={a => <Card className="device-card approval-card">{details(a)}<div className="device-actions"><Button disabled={busy} onClick={() => answer(a, false)}>{t('deny')}</Button><Button disabled={busy} onClick={() => setSelected(a.id)}>{t('reviewApproval')}</Button></div></Card>} />
    </>}
    <SheetPage open={!!approval} title={t('reviewApproval')} onClose={() => setSelected(undefined)} actions={<>
      <Button disabled={busy} onClick={() => approval && answer(approval, false)}>{t('deny')}</Button>
      <Button variant="primary" disabled={busy} onClick={() => approval && answer(approval, true)}>{t('approve')}</Button>
    </>}>{approval && details(approval)}</SheetPage>
  </>;
}

export function DevicesPage({ onBack }: { onBack: () => void }) {
  const { devices, candidates, busy, act } = useDevices();
  const { store, status } = useConnection();
  const { t, locale } = useI18n();
  const [pairing, setPairing] = useState<DevicePairing>();
  const [revoking, setRevoking] = useState<Device>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const active = pairing && Date.parse(pairing.expiresAt) > now;
  return <HubPage title={t('devices')} subtitle={t('devicesHelp')} onBack={onBack}>
    <ThisDevice />
    {status !== 'connected' ? <a href="#/pair">{t('pair')}</a> : <Button variant="primary" disabled={busy} onClick={() => void act(async () => setPairing(await store.client!.createDevicePairing()))}>{t('pairDevice')}</Button>}
    {pairing && <Card className="device-card" aria-label={t('pairDevice')}>
      <h2>{t(active ? 'pairingCode' : 'pairingExpired')}</h2>
      {active && <><output className="pairing-code">{pairing.code}</output><p>{t('expires')}: {new Date(pairing.expiresAt).toLocaleTimeString(locale)}</p></>}
      <p>{t('dialAddress')}: <code>{pairing.url}</code></p>
      <p>{t('nestFingerprint')}: <code>{pairing.fingerprint}</code></p><p>{t('compareFingerprints')}</p>
    </Card>}
    {candidates.map(c => <Card key={c.id} className="device-card"><h2>{t('confirmDevice')}</h2><p>{c.device}</p><code>{c.fingerprint}</code><p>{t('compareFingerprints')}</p><div className="device-actions">
      <Button disabled={busy} onClick={() => void act(() => store.client!.confirmDevicePairing(c.id, false))}>{t('deny')}</Button>
      <Button disabled={busy} onClick={() => void act(() => store.client!.confirmDevicePairing(c.id, true))}>{t('fingerprintMatches')}</Button>
    </div></Card>)}
    <DeviceApprovals />
    {!devices.length && status === 'connected' && <p>{t('noDevices')}</p>}
    <VirtualList items={devices} itemKey={d => d.device} label={t('devices')} renderItem={d => <Card className="device-card">
      <h2>{d.name ?? d.device}</h2><p className={d.online ? 'device-online' : undefined}>{t(d.online ? 'online' : 'offline')}{d.via ? ` · ${d.via}` : ''}</p>
      <p><code>{d.fingerprint}</code></p>
      {d.lastSeen && <p>{t('lastSeen')}: {new Date(d.lastSeen).toLocaleString(locale)}</p>}
      <p>{t('capabilities')}: {d.capabilities.map(c => `${c.id} (${c.tools.join(', ')})`).join(' · ') || t('none')}</p>
      <Button disabled={busy} onClick={() => setRevoking(d)}>{t('revokeDevice')}</Button>
    </Card>} />
    <SheetPage open={!!revoking} title={t('revokeDevice')} onClose={() => setRevoking(undefined)} actions={<><Button onClick={() => setRevoking(undefined)}>{t('cancel')}</Button><Button variant="primary" disabled={busy} onClick={() => revoking && void act(() => store.client!.revokeDevice(revoking.device)).then(ok => { if (ok) setRevoking(undefined); })}>{t('revokeDevice')}</Button></>}>
      <p>{revoking?.device}</p><p>{t('revokeHelp')}</p>
    </SheetPage>
  </HubPage>;
}
