import { useEffect, useState } from 'react';
import type { Device, DevicePairing } from '@swiftnest/api';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { Button } from './components/Button';
import { PageHeader } from './components/PageHeader';
import { SheetPage } from './components/pages';
import { SendFile } from './transfers';
import { ThisDevice } from './thisDevice';
import { LivePanel } from './liveView';
import { useDevices } from './devices/hub';
import { DeviceApprovals } from './devices/Approvals';
import { DeviceCard } from './devices/DeviceCard';
import { PairingInvitation, PairingRequest } from './devices/Pairing';
export { DeviceHubProvider, useDevices } from './devices/hub';
export { DeviceApprovals } from './devices/Approvals';

function useDevicesPage() {
  const hub = useDevices();
  const { store, status } = useConnection();
  const [pairing, setPairing] = useState<DevicePairing>();
  const [revoking, setRevoking] = useState<Device>();
  const [viewing, setViewing] = useState<Device>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // A disconnected/revoked device must not leave an owner-control surface open.
  const liveDevice = viewing && hub.devices.find((device) => device.device === viewing.device && device.online);
  useEffect(() => {
    if (viewing && !liveDevice) setViewing(undefined);
  }, [viewing, liveDevice]);
  return {
    ...hub,
    status,
    pairing,
    revoking,
    setRevoking,
    liveDevice,
    setViewing,
    now,
    pair: () => void hub.act(async () => setPairing(await store.client!.createDevicePairing())),
    confirm: (id: string, accept: boolean) => void hub.act(() => store.client!.confirmDevicePairing(id, accept)),
    revoke: () =>
      revoking &&
      void hub
        .act(() => store.client!.revokeDevice(revoking.device))
        .then((ok) => {
          if (ok) setRevoking(undefined);
        }),
  };
}

function RevokeDevice({ page }: { page: ReturnType<typeof useDevicesPage> }) {
  const { t } = useI18n();
  return (
    <SheetPage
      open={!!page.revoking}
      title={t('revokeDevice')}
      onClose={() => page.setRevoking(undefined)}
      actions={
        <>
          <Button onClick={() => page.setRevoking(undefined)}>{t('cancel')}</Button>
          <Button variant="danger" disabled={page.busy} onClick={page.revoke}>
            {t('revokeDevice')}
          </Button>
        </>
      }
    >
      <p>{page.revoking?.device}</p>
      <p>{t('revokeHelp')}</p>
    </SheetPage>
  );
}

function DevicesActions({ page }: { page: ReturnType<typeof useDevicesPage> }) {
  const { t } = useI18n();
  return (
    <div className="device-actions">
      <SendFile />
      {page.status === 'connected' ? (
        <Button variant="primary" disabled={page.busy} onClick={page.pair}>
          {t('pairDevice')}
        </Button>
      ) : (
        <a className="devices-link" href="#/pair">
          {t('pair')}
        </a>
      )}
    </div>
  );
}

export function DevicesPage({ onBack }: { onBack: () => void }) {
  const page = useDevicesPage();
  const { t } = useI18n();
  return (
    <section className="page page--hub devices-page">
      <PageHeader
        large
        title={t('devices')}
        subtitle={t('devicesHelp')}
        onBack={onBack}
        action={<DevicesActions page={page} />}
      />
      <div className="page__body card-groups">
        {page.pairing && <PairingInvitation pairing={page.pairing} now={page.now} />}
        {page.candidates.map((candidate) => (
          <PairingRequest
            key={candidate.id}
            candidate={candidate}
            busy={page.busy}
            onAnswer={(accept) => page.confirm(candidate.id, accept)}
          />
        ))}
        <DeviceApprovals />
        {!page.devices.length && page.status === 'connected' && <p>{t('noDevices')}</p>}
        <ul className="devices-grid" aria-label={t('devices')}>
          {page.devices.map((device) => (
            <li key={device.device}>
              <DeviceCard
                device={device}
                now={page.now}
                busy={page.busy}
                onOpen={() => page.setViewing(device)}
                onRevoke={() => page.setRevoking(device)}
              />
            </li>
          ))}
        </ul>
        <ThisDevice />
        <a className="devices-link" href="#/transfers">
          {t('transfers')}
        </a>
        <RevokeDevice page={page} />
        {page.liveDevice && <LivePanel device={page.liveDevice} onClose={() => page.setViewing(undefined)} />}
      </div>
    </section>
  );
}
