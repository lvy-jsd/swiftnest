/**
 * The account's devices, inside Preferences.
 *
 * A settings section is for the two things people come here for: see what is
 * connected, and cut one off. Opening a device's screen or sending it a file
 * stays on the devices page; this list only revokes, and asks first.
 */
import { useState } from 'react';
import type { Device } from '@swiftnest/api';
import { Button } from './components/Button';
import { ListRow } from './components/ListRow';
import { Pill } from './components/Pill';
import { Sheet } from './components/Sheet';
import { useConnection } from './connection';
import { useDevices } from './devices';
import { useI18n } from './i18n';

function DeviceRow({ device, busy, onRevoke }: { device: Device; busy: boolean; onRevoke: (device: Device) => void }) {
  const { t } = useI18n();
  return (
    <li>
      <ListRow
        title={device.name ?? device.device}
        subtitle={device.kind ? t(device.kind === 'android' ? 'devicesPhone' : 'devicesComputer') : device.via}
        value={
          <span className="device-settings-actions">
            <Pill dot tone={device.online ? 'success' : 'neutral'}>
              {t(device.online ? 'online' : 'offline')}
            </Pill>
            <Button variant="ghost" disabled={busy} onClick={() => onRevoke(device)}>
              {t('revokeDevice')}
            </Button>
          </span>
        }
      />
    </li>
  );
}

/** The list itself, so its markup can be checked without a live device hub. */
export function DeviceSettingsList({
  devices,
  busy,
  onRevoke,
}: {
  devices: readonly Device[];
  busy: boolean;
  onRevoke: (device: Device) => void;
}) {
  return (
    <ul className="device-settings-list">
      {devices.map((device) => (
        <DeviceRow key={device.device} device={device} busy={busy} onRevoke={onRevoke} />
      ))}
    </ul>
  );
}

export function DeviceSettings({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { status, store } = useConnection();
  const { devices, error, loaded, busy, act, refresh } = useDevices();
  const [revoking, setRevoking] = useState<Device>();

  const openDevices = () => {
    onClose();
    window.location.hash = '/devices';
  };
  const revoke = async () => {
    if (!revoking || !store.client) return;
    const done = await act(() => store.client!.revokeDevice(revoking.device));
    if (done) setRevoking(undefined);
  };

  return (
    <details className="device-settings" open>
      <summary>{t('devices')}</summary>
      {status !== 'connected' ? (
        <p role="status">{t('devicesNeedsConnection')}</p>
      ) : error ? (
        <>
          <p role="alert">{t('devicesLoadFailed')}</p>
          <Button onClick={() => void refresh()}>{t('retry')}</Button>
        </>
      ) : !loaded ? (
        <p role="status">{t('devicesLoading')}</p>
      ) : devices.length === 0 ? (
        <>
          <p>{t('noDevices')}</p>
          <Button onClick={openDevices}>{t('pairDevice')}</Button>
        </>
      ) : (
        <DeviceSettingsList devices={devices} busy={busy} onRevoke={setRevoking} />
      )}
      <Sheet
        open={!!revoking}
        title={t('revokeDevice')}
        onClose={() => setRevoking(undefined)}
        actions={
          <>
            <Button onClick={() => setRevoking(undefined)}>{t('cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={revoke}>
              {t('revokeDevice')}
            </Button>
          </>
        }
      >
        <p>{revoking?.name ?? revoking?.device}</p>
        <p>{t('revokeHelp')}</p>
      </Sheet>
    </details>
  );
}
